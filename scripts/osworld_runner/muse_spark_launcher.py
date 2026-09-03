#!/usr/bin/env python3
"""Launch upstream OSWorld Muse Spark while attaching Meta's session header."""

from __future__ import annotations

import argparse
import logging
import os
import random
import runpy
import time
from pathlib import Path
from typing import Any

import httpx
import openai
from docker.models.containers import Container

logger = logging.getLogger("muse_spark_launcher")

# Set by the queue; when this file exists every agent refuses to call Meta so
# a blocked key is never hammered by a whole fleet of retries.
_BLOCK_MARKER = os.environ.get("OSWORLD_META_BLOCK_MARKER", "")
_last_api_error: BaseException | None = None


def _session_headers(headers: Any = None) -> dict[str, str]:
    result = dict(headers or {})
    session_id = os.environ.get("MUSE_SPARK_SESSION_ID")
    if session_id:  # Meta's gateway needs it; plain OpenAI runs have none
        result.setdefault("x-session-id", session_id)
    return result


_OpenAI = openai.OpenAI


def _record_api_errors(create: Any) -> Any:
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        global _last_api_error
        try:
            result = create(*args, **kwargs)
        except BaseException as exc:
            _last_api_error = exc
            raise
        _last_api_error = None
        return result

    return wrapped


def _openai_with_session(*args: Any, **kwargs: Any) -> Any:
    kwargs["default_headers"] = _session_headers(kwargs.get("default_headers"))
    # The launcher owns all retry policy below; the SDK's hidden retries turn
    # one rate-limit breach into a request storm across a fleet of agents.
    kwargs["max_retries"] = 0
    client = _OpenAI(*args, **kwargs)
    client.responses.create = _record_api_errors(client.responses.create)
    return client


def _error_status(exc: BaseException | None) -> int | None:
    value = getattr(exc, "status_code", None)
    return value if isinstance(value, int) else None


def _error_code(exc: BaseException | None) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        inner = body.get("error")
        if isinstance(inner, dict) and inner.get("code"):
            return str(inner["code"])
        if body.get("code"):
            return str(body["code"])
    return ""


def _retry_after_seconds(exc: BaseException | None) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    raw = headers.get("retry-after")
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _mark_blocked(reason: str) -> None:
    if not _BLOCK_MARKER:
        return
    try:
        Path(_BLOCK_MARKER).write_text(
            f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {reason}\n", encoding="utf-8"
        )
    except OSError:
        logger.exception("could not write Meta block marker %s", _BLOCK_MARKER)


def _governed_create_response(original: Any) -> Any:
    """Replace the pinned agent's retry loop with one that cannot storm.

    The upstream loop retries every failure, including deterministic 4xx
    responses and a 403 block, with at most 30 s between attempts. Here:
    400s fail immediately, a 403 block stops the whole fleet via the marker
    file, 429s honor Retry-After with long jittered backoff, and 5xx or
    connection errors back off more slowly than upstream.
    """

    def create_response(self: Any, request_input: Any, instructions: Any) -> Any:
        global _last_api_error
        attempts = max(1, int(getattr(self, "max_retries", 3) or 1))
        original_max = self.max_retries
        last_error: BaseException | None = None
        try:
            for attempt in range(1, attempts + 1):
                if _BLOCK_MARKER and Path(_BLOCK_MARKER).exists():
                    raise RuntimeError(
                        f"Meta access is blocked (marker {_BLOCK_MARKER} present); "
                        "refusing to call the API"
                    )
                self.max_retries = 1
                _last_api_error = None
                try:
                    return original(self, request_input, instructions)
                except Exception as exc:
                    last_error = exc
                    api_error = _last_api_error
                    status = _error_status(api_error)
                    code = _error_code(api_error)
                    if status == 403 and code == "user_blocked":
                        _mark_blocked(f"403 {code}: {api_error}")
                        raise RuntimeError(
                            f"Meta blocked this key ({code}); stopping without retry"
                        ) from exc
                    if status is not None and 400 <= status < 500 and status != 429:
                        raise RuntimeError(
                            f"API rejected the request ({status} {code or 'client error'}); "
                            "not retrying"
                        ) from exc
                    if attempt >= attempts:
                        break
                    if status == 429:
                        wait = _retry_after_seconds(api_error)
                        if wait is None:
                            wait = min(300.0, 30.0 * (2 ** (attempt - 1)))
                        wait += random.uniform(0.0, 15.0)
                    else:
                        wait = min(120.0, 5.0 * (2**attempt)) + random.uniform(0.0, 5.0)
                    logger.error(
                        "Agent API error on attempt %d/%d (%s %s); waiting %.0fs: %s",
                        attempt, attempts, status, code or "-", wait, exc,
                    )
                    time.sleep(wait)
        finally:
            self.max_retries = original_max
        raise RuntimeError(f"Muse Spark API failed too many times: {last_error}")

    return create_response


_httpx_post = httpx.post
_docker_remove = Container.remove


def _post_with_session(*args: Any, **kwargs: Any) -> Any:
    kwargs["headers"] = _session_headers(kwargs.get("headers"))
    return _httpx_post(*args, **kwargs)


def _remove_with_anonymous_volumes(self: Container, **kwargs: Any) -> Any:
    """Remove OSWorld's disposable /storage volume with its VM container."""
    kwargs.setdefault("v", True)
    return _docker_remove(self, **kwargs)


_add_argument = argparse.ArgumentParser.add_argument


def _add_argument_with_apptainer(self: argparse.ArgumentParser, *args: Any, **kwargs: Any) -> Any:
    """Let the hash-pinned upstream runner accept the fork's apptainer provider."""
    choices = kwargs.get("choices")
    if "--provider_name" in args and choices is not None and "apptainer" not in choices:
        kwargs["choices"] = [*choices, "apptainer"]
    return _add_argument(self, *args, **kwargs)


# Upstream's GPT-5.4 operator prompt is a short tips list; on deliverable-style
# Apollo tasks the model answers in chat text instead of using the desktop.
# This mirrors the directives the Muse Spark agent ships with. The four
# placeholders must stay: upstream formats exactly these keys.
APOLLO_OPERATOR_PROMPT = """You are a computer-use agent operating a real {PLATFORM} desktop with internet access through the `computer` tool. The person cannot see your text; the only thing that counts is what you do on screen.

Rules:
- Accomplish the task by operating the desktop. Never answer the task in text — a text-only reply is ignored and counts as giving up. Even research or writing tasks must be carried out in the environment: gather sources in the browser and produce the deliverable inside an application on screen (a document, spreadsheet, editor, or the web app the task refers to), then save it.
- Do not ask for clarification and do not wait for confirmation. Make reasonable, clearly labelled assumptions and keep going.
- Follow the task literally and complete ALL of its requirements before stopping. Re-read the instructions before declaring completion.
- Verify results by reading them back on screen, not by assuming an action worked. If content may be off-screen, scroll or zoom out before deciding it is unavailable.
- Prefer Chrome for web work, and stick to the website or application already open when possible. Do not invent URLs; use visible navigation or search.
- When possible, bundle several GUI actions into one computer-use turn.
- The current date is {CURRENT_DATE}. The home directory is "{HOME_DIR}". The computer password is "{CLIENT_PASSWORD}" if sudo is needed. Save output files next to the source data unless told otherwise.
- Only if the task is truly impossible because of missing apps, permissions, credentials, or contradictory requirements, output exactly "[INFEASIBLE]".
"""

TEXT_REPLY_NUDGE = (
    "You replied with text but took no action on the computer. Text answers are "
    "not accepted and nothing has been done yet. Perform the task in the "
    "environment now using the `computer` tool: use the browser to research and "
    "create the deliverable inside an application on screen. Start with your "
    "first concrete action on the screenshot below."
)


def _nudged_predict(agent_module: Any) -> Any:
    """Re-ask the model when it answers in text instead of acting.

    The harness ends the episode on a zero-action reply without logging a
    trajectory step, so a chatty answer silently wastes the task. Up to
    OSWORLD_TEXT_REPLY_NUDGES times we push a corrective user message plus the
    current screenshot into the pending input and continue the same
    conversation; unsupported-action and infeasible replies pass through.
    """
    original = agent_module.GPT54Agent.predict
    original_reset = agent_module.GPT54Agent.reset
    max_nudges = int(os.environ.get("OSWORLD_TEXT_REPLY_NUDGES", "2"))

    def reset(self: Any, *args: Any, **kwargs: Any) -> Any:
        self._apollo_actions_taken = 0
        return original_reset(self, *args, **kwargs)

    def predict(self: Any, instruction: Any, obs: Any) -> Any:
        info, actions = original(self, instruction, obs)
        nudges = 0
        # Only a chat answer *before any desktop action* is a refusal to act; a
        # text reply after acting is upstream's normal completion signal.
        while (
            not actions
            and getattr(self, "_apollo_actions_taken", 0) == 0
            and nudges < max_nudges
            and not info.get("infeasible_message")
            and "Unsupported computer action" not in str(info.get("response", ""))
        ):
            nudges += 1
            agent_module.logger.warning(
                "model replied in text without acting; nudging (%d/%d)", nudges, max_nudges
            )
            # Text only: once previous_response_id is set the Responses API
            # rejects user input_image items ("Computer tool only allows input
            # image without previous response"); the model still holds the
            # last screenshot from its computer_call_output context.
            self.pending_input_items.append({
                "role": "user",
                "content": [{"type": "input_text", "text": TEXT_REPLY_NUDGE}],
            })
            info, actions = original(self, instruction, obs)
        self._apollo_actions_taken = getattr(self, "_apollo_actions_taken", 0) + len(actions)
        if nudges:
            info["text_reply_nudges"] = nudges
        return info, actions

    agent_module.GPT54Agent.reset = reset
    return predict


def _governed_gpt54_create_response(agent_module: Any) -> Any:
    """Faithful copy of upstream GPT54Agent._create_response minus its retry loop.

    Upstream retries every failure five times with <=5 s sleeps, which is
    exactly the storm shape that got the Meta key blocked. The request body is
    reproduced verbatim from the pinned source so behaviour is unchanged; only
    the retry policy differs, and it is shared with the Muse Spark path.
    """
    get_field = agent_module._get_field
    sanitize = agent_module._sanitize_for_log
    agent_logger = agent_module.logger

    def single_attempt(self: Any, request_input: Any, instructions: Any) -> Any:
        client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        agent_logger.info(
            "Sending GPT-5.4 request with previous_response_id=%s and %d input item(s)",
            self.previous_response_id,
            len(request_input),
        )
        agent_logger.debug("Request input items: %s", sanitize(request_input))
        request: dict[str, Any] = {
            "model": self.model,
            "instructions": instructions,
            "input": request_input,
            "tools": self.tools,
            "parallel_tool_calls": False,
            "reasoning": {"effort": self.reasoning_effort, "summary": "concise"},
            "truncation": "auto",
        }
        if self.max_tokens is not None:
            request["max_output_tokens"] = self.max_tokens
        if self.previous_response_id:
            request["previous_response_id"] = self.previous_response_id
        response = client.responses.create(**request)
        response_error = get_field(get_field(response, "error", {}), "message")
        if response_error:
            raise RuntimeError(response_error)
        if get_field(response, "status") == "failed":
            raise RuntimeError("Responses API request failed.")
        agent_logger.info("Received GPT-5.4 computer-use response")
        agent_logger.debug("Raw response output: %s", sanitize(get_field(response, "output", [])))
        try:  # billable split for cost accounting; never let logging break a step
            usage = get_field(response, "usage", {}) or {}
            details = get_field(usage, "input_tokens_details", {}) or {}
            agent_logger.info(
                "Usage billable: input=%s cached=%s output=%s",
                get_field(usage, "input_tokens", 0),
                get_field(details, "cached_tokens", 0),
                get_field(usage, "output_tokens", 0),
            )
        except Exception:
            pass
        return response

    governed = _governed_create_response(single_attempt)

    def create_response(self: Any, request_input: Any, instructions: Any) -> Any:
        if not hasattr(self, "max_retries"):
            self.max_retries = int(os.environ.get("OSWORLD_AGENT_MAX_RETRIES", "5"))
        return governed(self, request_input, instructions)

    return create_response


def main() -> None:
    runner = Path(os.environ["MUSE_SPARK_RUNNER_PATH"]).resolve()
    if not runner.is_file():
        raise SystemExit(f"agent runner not found: {runner}")
    openai.OpenAI = _openai_with_session
    httpx.post = _post_with_session
    Container.remove = _remove_with_anonymous_volumes
    argparse.ArgumentParser.add_argument = _add_argument_with_apptainer
    # Each backend's agent module resolves from its own pinned overlay; patch
    # whichever ones are importable so retry policy is governed for both.
    try:
        from mm_agents import muse_spark_agent
    except ImportError:
        pass
    else:
        muse_spark_agent.MuseSparkAgent._create_response = _governed_create_response(
            muse_spark_agent.MuseSparkAgent._create_response
        )
    try:
        from mm_agents import gpt54_agent
    except ImportError:
        pass
    else:
        if "instructions" in gpt54_agent.GPT54Agent._create_response.__code__.co_varnames:
            gpt54_agent.GPT54Agent._create_response = _governed_gpt54_create_response(gpt54_agent)
            if os.environ.get("OSWORLD_OPERATOR_PROMPT_OVERRIDE", "1") != "0":
                gpt54_agent.OPERATOR_PROMPT = APOLLO_OPERATOR_PROMPT
            gpt54_agent.GPT54Agent.predict = _nudged_predict(gpt54_agent)
    runpy.run_path(str(runner), run_name="__main__")


if __name__ == "__main__":
    main()
