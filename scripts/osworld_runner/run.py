#!/usr/bin/env python3
"""Fetch author-approved Apollo tasks, run them in OSWorld, and publish trajectories.

Generated task content, screenshots, and logs stay below the ignored ``.work``
directory. Credentials are accepted only through environment variables and are
never written to the job directory or included in child-process arguments.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


DEFAULT_APIS = {
    "v2": "https://2fb2wkpayf.execute-api.us-east-1.amazonaws.com/reporting/tasks",
    "pc": "https://t1ynh195m1.execute-api.us-east-1.amazonaws.com/reporting/tasks",
}
DEFAULT_BUCKET = "journeys-prolific"
DEFAULT_META_MODEL = "super_nova_ext"
DEFAULT_META_BASE_URL = "https://api.ai.meta.com/v1"
DEFAULT_META_SESSION_ID = "terminal-bench-2.1--123456"
DEFAULT_MUSE_REQUEST_TIMEOUT = 600.0
DEFAULT_MUSE_MAX_RETRIES = 3
# 0 = every screenshot in the trajectory, matching Odysseys' canonical
# run_full_trajectory_per_rubric.py. The old value of 12 evenly sampled frames
# was a concession to Meta's request-size limits and could hide the one frame
# that proves a rubric; OpenAI has no such pressure.
JUDGE_SCREENSHOT_SAMPLE = 0
META_JUDGE_MIN_OUTPUT_TOKENS = 16_384
META_JUDGE_REASONING_EFFORT = "low"
OSWORLD_MODEL_ALIAS = DEFAULT_META_MODEL
MUSE_SPARK_COMMIT = "84aee655c2afb6b77ecf39884432615ba345c031"
MUSE_SPARK_FILES = {
    "mm_agents/muse_spark_agent.py": "e98023fb55265bc68a086e6ea77bd4e8f37aa613818bca421e793fc6158d19de",
    "scripts/python/run_multienv_muse_spark.py": "dd9887a4f138a87136caab683126b57f0a7c56b8e141fed5d22ed6acf34fd003",
}
# OpenAI backend: upstream OSWorld's GPT-5.4-style computer-use agent, pinned
# at the commit that added the [INFEASIBLE] protocol and dropped the output cap.
GPT54_COMMIT = "fc31a9049664292fcb35d6e501ee1dc839f2cf6d"
GPT54_FILES = {
    "mm_agents/gpt54_agent.py": "cf27dd0b2244e34a40586d21fd892d77cacb558427c8852e5ce03900eb5c467c",
    "scripts/python/run_multienv_gpt54.py": "3710dbd75892e188512395ca62db2ddea9edaa9f0f3b93e889d5bb2741c3f15e",
}
AGENT_BACKENDS = ("muse-spark", "openai")
DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
DEFAULT_OPENAI_REASONING_EFFORT = "medium"
DEFAULT_OPENAI_JUDGE_MODEL = "gpt-5.4-mini"
DEFAULT_OSWORLD_ROOT = Path("/home/jykoh/OSWorld")
DEFAULT_VM_PATH = DEFAULT_OSWORLD_ROOT / "vmware_vm_data/Ubuntu0/Ubuntu0.vmx"
DEFAULT_DOCKER_VM_PATH = Path("/home/ljang/osworld_src/docker_vm_data/Ubuntu.qcow2")
DEFAULT_WORK_DIR = Path(".work/osworld_runner/latest")
APOLLO_RUN_ID_PREFIX = "apollo_b64_"
VALID_SIGNOFF_ACTIONS = {"accepted", "amended"}
MUSE_SPARK_VM_PREREQUISITES = [
    {
        "type": "command",
        "parameters": {
            "command": (
                "if ! command -v xclip >/dev/null 2>&1; then "
                "printf '%s\\n' '{CLIENT_PASSWORD}' | sudo -S -p '' "
                "env DEBIAN_FRONTEND=noninteractive sh -c "
                "'apt-get install -y -qq xclip xsel || "
                "{ apt-get update -qq && apt-get install -y -qq xclip xsel; }'; "
                "fi"
            ),
            "shell": True,
        },
    },
    {
        "type": "execute_with_verification",
        "parameters": {
            "command": "true",
            "shell": True,
            "verification": {"command_success": "command -v xclip >/dev/null 2>&1"},
            "max_wait_time": 10,
            "check_interval": 1.0,
        },
    },
]
SECRET_ENV_PATTERNS = (
    "APOLLO_",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "LLAMA_API_KEY",
    "META_API_KEY",
    "MUSE_SPARK_API_KEY",
    "OPENAI_API_KEY",
)
META_KEY_ENV_NAMES = ("MUSE_SPARK_API_KEY", "META_API_KEY", "LLAMA_API_KEY")


class BridgeError(RuntimeError):
    pass


@dataclass(frozen=True)
class JobPaths:
    root: Path
    configs: Path
    tasks: Path
    meta: Path
    results: Path
    runs: Path
    trajectory_output: Path


def _text(value: Any, limit: int = 20_000) -> str:
    return str(value or "").strip()[:limit]


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(_json_bytes(value))
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_private_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def encode_run_id(task_id: str) -> str:
    encoded = base64.urlsafe_b64encode(task_id.encode("utf-8")).decode("ascii").rstrip("=")
    return f"{APOLLO_RUN_ID_PREFIX}{encoded}"


def decode_run_id(run_id: str) -> str | None:
    if not run_id.startswith(APOLLO_RUN_ID_PREFIX):
        return None
    encoded = run_id[len(APOLLO_RUN_ID_PREFIX):]
    try:
        padding = "=" * (-len(encoded) % 4)
        decoded = base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    return decoded if encode_run_id(decoded) == run_id else None


def queue_accepts_task(task_id: str, queue: str) -> bool:
    is_pc = task_id.startswith(("pc_", "pc/"))
    return is_pc if queue == "pc" else not is_pc


def reporting_url(api_url: str, *, offset: int, limit: int = 150) -> str:
    parts = urlsplit(api_url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.update({
        "status": "approved",
        "include": "content",
        "limit": str(limit),
        "offset": str(offset),
    })
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def trajectory_reporting_url(api_url: str, *, offset: int, limit: int = 1_000) -> str:
    parts = urlsplit(api_url)
    if not parts.path.endswith("/reporting/tasks"):
        raise BridgeError("reporting API URL must end with /reporting/tasks")
    path = f"{parts.path[:-len('/tasks')]}/trajectories"
    return urlunsplit((
        parts.scheme,
        parts.netloc,
        path,
        urlencode({"limit": str(limit), "offset": str(offset)}),
        parts.fragment,
    ))


def get_json(
    url: str, token: str, timeout: float = 60.0, attempts: int = 6
) -> Mapping[str, Any]:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "apollo-osworld-runner/1",
        },
    )
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urlopen(request, timeout=timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
            break
        except HTTPError as exc:
            # Concurrent shard workers can trip API Gateway throttling; those
            # responses are transient and safe to retry with backoff.
            if exc.code in {429, 500, 502, 503, 504} and attempt + 1 < attempts:
                last_error = exc
                time.sleep(min(60.0, (2.0**attempt) + random.uniform(0.0, 2.0)))
                continue
            raise BridgeError(f"reporting API returned HTTP {exc.code}") from exc
        except (URLError, TimeoutError) as exc:
            if attempt + 1 < attempts:
                last_error = exc
                time.sleep(min(60.0, (2.0**attempt) + random.uniform(0.0, 2.0)))
                continue
            raise BridgeError(f"reporting API request failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise BridgeError(f"reporting API request failed: {exc}") from exc
    else:
        raise BridgeError(f"reporting API request failed: {last_error}")
    if not isinstance(value, Mapping):
        raise BridgeError("reporting API returned a non-object response")
    return value


def fetch_reporting_tasks(api_url: str, token: str) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    offset = 0
    seen_offsets: set[int] = set()
    while True:
        if offset in seen_offsets:
            raise BridgeError("reporting API returned a paging loop")
        seen_offsets.add(offset)
        page = get_json(reporting_url(api_url, offset=offset), token)
        items = page.get("items") if isinstance(page.get("items"), list) else page.get("tasks")
        if not isinstance(items, list):
            raise BridgeError("reporting API response is missing items[]/tasks[]")
        tasks.extend(item for item in items if isinstance(item, dict))
        page_info = page.get("page") if isinstance(page.get("page"), Mapping) else {}
        next_offset = page_info.get("next_offset")
        if next_offset is None:
            break
        try:
            offset = int(next_offset)
        except (TypeError, ValueError) as exc:
            raise BridgeError("reporting API returned an invalid next_offset") from exc
    return tasks


def fetch_trajectory_task_ids(
    api_url: str, token: str, *, model: str | None = None
) -> set[str]:
    """Task IDs that already have a trajectory.

    With `model`, only trajectories produced by that model count, so a
    multi-model campaign can run a second agent over tasks another agent
    already covered while still terminating once this model has done them all.
    """
    task_ids: set[str] = set()
    offset = 0
    seen_offsets: set[int] = set()
    while True:
        if offset in seen_offsets:
            raise BridgeError("trajectory reporting API returned a paging loop")
        seen_offsets.add(offset)
        page = get_json(trajectory_reporting_url(api_url, offset=offset), token)
        items = page.get("trajectories")
        if not isinstance(items, list):
            raise BridgeError("trajectory reporting API response is missing trajectories[]")
        task_ids.update(
            task_id
            for item in items
            if isinstance(item, Mapping)
            if model is None or _text(item.get("model"), 200) == model
            for task_id in [_text(item.get("task_id"), 300)]
            if task_id
        )
        page_info = page.get("page") if isinstance(page.get("page"), Mapping) else {}
        next_offset = page_info.get("next_offset")
        if next_offset is None:
            break
        try:
            offset = int(next_offset)
        except (TypeError, ValueError) as exc:
            raise BridgeError("trajectory reporting API returned an invalid next_offset") from exc
    return task_ids


def runnable_reason(
    task: Mapping[str, Any],
    queue: str,
    include_existing: bool,
    existing_task_ids: set[str] | frozenset[str] = frozenset(),
) -> str | None:
    task_id = _text(task.get("task_id"), 300)
    if not task_id:
        return "missing task_id"
    if not queue_accepts_task(task_id, queue):
        return f"task does not belong to {queue}"
    if task.get("status") != "approved":
        return "not human approved"
    if _text(task.get("signoff_action"), 20).lower() not in VALID_SIGNOFF_ACTIONS:
        return "awaiting author sign-off"
    content = task.get("content") if isinstance(task.get("content"), Mapping) else {}
    final = content.get("final") if isinstance(content.get("final"), Mapping) else {}
    rubrics = content.get("rubrics") if isinstance(content.get("rubrics"), list) else []
    if not _text(final.get("request"), 200_000):
        return "missing final request"
    if not any(isinstance(item, Mapping) and _text(item.get("final"), 30_000) for item in rubrics):
        return "missing final rubrics"
    if not include_existing and task_id in existing_task_ids:
        return "already has a trajectory"
    return None


def read_task_id_list(path: Path | None) -> frozenset[str]:
    """Read one task ID per line; blank lines and #-comments are ignored."""
    if path is None:
        return frozenset()
    try:
        lines = path.expanduser().read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise BridgeError(f"cannot read task ID list {path}: {exc}") from exc
    return frozenset(
        line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")
    )


def select_tasks(
    tasks: Iterable[dict[str, Any]],
    *,
    queue: str,
    wanted_ids: Sequence[str] = (),
    limit: int = 1,
    include_existing: bool = False,
    existing_task_ids: set[str] | frozenset[str] = frozenset(),
    shard_count: int = 1,
    shard_index: int = 0,
    excluded_ids: set[str] | frozenset[str] = frozenset(),
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    if shard_count < 1:
        raise BridgeError("--shard-count must be at least 1")
    if shard_index < 0 or shard_index >= shard_count:
        raise BridgeError("--shard-index must be between 0 and shard-count - 1")
    wanted = {value.strip() for value in wanted_ids if value.strip()}
    selected: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    found: set[str] = set()
    for task in tasks:
        task_id = _text(task.get("task_id"), 300)
        if wanted and task_id not in wanted:
            continue
        if task_id in wanted:
            found.add(task_id)
        if task_id in excluded_ids:
            skipped.append({"task_id": task_id, "reason": "excluded by operator list"})
            continue
        assigned_shard = int.from_bytes(
            hashlib.sha256(task_id.encode("utf-8")).digest()[:8], "big"
        ) % shard_count
        if assigned_shard != shard_index:
            if task_id in wanted:
                skipped.append({
                    "task_id": task_id,
                    "reason": f"assigned to shard {assigned_shard}, not {shard_index}",
                })
            continue
        reason = runnable_reason(task, queue, include_existing, existing_task_ids)
        if reason:
            skipped.append({"task_id": task_id, "reason": reason})
            continue
        selected.append(task)
    missing = sorted(wanted - found)
    if missing:
        raise BridgeError(f"requested task ID(s) not found: {', '.join(missing)}")
    if wanted:
        blocked = [item for item in skipped if item["task_id"] in wanted]
        if blocked:
            summary = "; ".join(f"{item['task_id']}: {item['reason']}" for item in blocked)
            raise BridgeError(f"requested task ID(s) are not runnable: {summary}")
    selected.sort(key=lambda item: (_text(item.get("signoff_at"), 80), _text(item.get("task_id"), 300)))
    if limit < 1:
        raise BridgeError("--limit must be at least 1")
    return selected[:limit], skipped


def _https_url(value: Any) -> str | None:
    text = _text(value, 4_000)
    if not text:
        return None
    if re.fullmatch(r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:/.*)?", text):
        text = f"https://{text}"
    parsed = urlsplit(text)
    if parsed.scheme != "https" or not parsed.netloc:
        return None
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, ""))


GOOGLE_START_URL = "https://www.google.com/"


def start_urls(task: Mapping[str, Any], mode: str = "google") -> list[str]:
    """Browser tabs the VM opens before the agent's first turn.

    ``google`` (default) starts every run on a blank search page, so the agent
    has to find its own sources — 132 of Odysseys' 200 canonical configs do
    this. ``site_scope`` instead pre-opens the task's authored key_urls /
    site_scope, which is how Apollo's earlier runs were recorded; keep it when
    comparing against those trajectories.
    """
    if mode == "google":
        return [GOOGLE_START_URL]
    content = task.get("content") if isinstance(task.get("content"), Mapping) else {}
    final = content.get("final") if isinstance(content.get("final"), Mapping) else {}
    values = final.get("key_urls") if isinstance(final.get("key_urls"), list) else []
    values = [*values, *(final.get("site_scope") if isinstance(final.get("site_scope"), list) else [])]
    urls: list[str] = []
    for value in values:
        url = _https_url(value)
        if url and url not in urls:
            urls.append(url)
    return urls[:12] or ["https://www.google.com/"]


def osworld_config(task: Mapping[str, Any], domain: str, start_url_mode: str = "google") -> dict[str, Any]:
    task_id = _text(task.get("task_id"), 300)
    content = task.get("content") if isinstance(task.get("content"), Mapping) else {}
    final = content.get("final") if isinstance(content.get("final"), Mapping) else {}
    urls = start_urls(task, start_url_mode)
    return {
        "id": encode_run_id(task_id),
        "snapshot": "chrome",
        "instruction": _text(final.get("request"), 200_000),
        "source": urls[0],
        "config": [
            *MUSE_SPARK_VM_PREREQUISITES,
            {
                "type": "launch",
                "parameters": {"command": ["google-chrome", "--remote-debugging-port=1337"]},
            },
            {
                "type": "launch",
                "parameters": {"command": ["socat", "tcp-listen:9222,fork", "tcp:localhost:1337"]},
            },
            {"type": "chrome_open_tabs", "parameters": {"urls_to_open": urls}},
        ],
        "trajectory": f"trajectories/{encode_run_id(task_id)}",
        "related_apps": ["chrome"],
        "evaluator": {"func": "infeasible"},
        "proxy": False,
        "fixed_ip": False,
        "possibility_of_env_change": "high",
        "metadata": {
            "domain": domain,
            "apollo_task_id": task_id,
            "task_content_hash": _text(content.get("task_content_hash"), 80),
            "creator_pid": _text(task.get("participant_id"), 80).lower(),
        },
    }


def _is_muse_spark_vm_prerequisite(step: Any) -> bool:
    if not isinstance(step, Mapping) or not isinstance(step.get("parameters"), Mapping):
        return False
    parameters = step["parameters"]
    command = _text(parameters.get("command"), 20_000)
    verification = parameters.get("verification")
    verification_command = _text(
        verification.get("command_success") if isinstance(verification, Mapping) else "",
        20_000,
    )
    return (
        "apt-get install -y -qq xclip" in command
        or "command -v xclip" in command
        or "command -v xclip" in verification_command
    )


def ensure_muse_spark_vm_prerequisite(paths: JobPaths) -> None:
    """Add Muse Spark's clipboard dependency to prepared configs, including old jobs."""
    try:
        metadata = json.loads(paths.meta.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BridgeError(f"could not read prepared OSWorld metadata: {paths.meta}") from exc
    if not isinstance(metadata, Mapping):
        raise BridgeError(f"prepared OSWorld metadata must be an object: {paths.meta}")

    for domain, run_ids in metadata.items():
        if not isinstance(domain, str) or not isinstance(run_ids, list):
            raise BridgeError(f"prepared OSWorld metadata has an invalid domain entry: {paths.meta}")
        for run_id in run_ids:
            if not isinstance(run_id, str) or not run_id:
                raise BridgeError(f"prepared OSWorld metadata has an invalid run ID: {paths.meta}")
            config_path = paths.configs / "examples" / domain / f"{run_id}.json"
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise BridgeError(f"could not read prepared OSWorld config: {config_path}") from exc
            steps = config.get("config") if isinstance(config, Mapping) else None
            if not isinstance(steps, list):
                raise BridgeError(f"prepared OSWorld config has no setup steps: {config_path}")
            existing_prerequisites = [
                step
                for step in steps
                if _is_muse_spark_vm_prerequisite(step)
            ]
            if len(existing_prerequisites) == len(MUSE_SPARK_VM_PREREQUISITES):
                continue
            config = dict(config)
            remaining_steps = [
                step
                for step in steps
                if not _is_muse_spark_vm_prerequisite(step)
            ]
            config["config"] = [*MUSE_SPARK_VM_PREREQUISITES, *remaining_steps]
            write_private_json(config_path, config)


def job_paths(
    root: Path,
    *,
    domain: str = "apollo_chrome",
    model: str = OSWORLD_MODEL_ALIAS,
) -> JobPaths:
    root = root.expanduser().resolve()
    configs = root / "configs"
    results = root / "results"
    runs = results / "pyautogui" / "screenshot" / model / domain
    return JobPaths(
        root=root,
        configs=configs,
        tasks=root / "tasks.json",
        meta=configs / "test_all.json",
        results=results,
        runs=runs,
        trajectory_output=root / "trajectory_review",
    )


def prepare_job(tasks: Sequence[dict[str, Any]], paths: JobPaths, domain: str, start_url_mode: str = "google") -> dict[str, Any]:
    examples_dir = paths.configs / "examples" / domain
    examples_dir.mkdir(parents=True, exist_ok=True)
    run_ids: list[str] = []
    mapping: dict[str, str] = {}
    for task in tasks:
        config = osworld_config(task, domain, start_url_mode)
        run_id = config["id"]
        run_ids.append(run_id)
        mapping[run_id] = _text(task.get("task_id"), 300)
        write_private_json(examples_dir / f"{run_id}.json", config)
    write_private_json(paths.tasks, list(tasks))
    write_private_json(paths.meta, {domain: run_ids})
    manifest = {
        "schema_version": "apollo-osworld-job-v1",
        "domain": domain,
        "task_count": len(tasks),
        "task_ids": [_text(task.get("task_id"), 300) for task in tasks],
        "run_id_to_task_id": mapping,
        "task_source_json": str(paths.tasks),
        "test_all_meta_path": str(paths.meta),
        "results_dir": str(paths.results),
        "secrets_stored": False,
    }
    write_private_json(paths.root / "job.json", manifest)
    (paths.root / "logs").mkdir(parents=True, exist_ok=True)
    return manifest


def normalize_meta_messages(raw_messages: Any) -> list[dict[str, Any]]:
    """Translate Chat Completions messages into Responses API input items."""
    if not isinstance(raw_messages, list):
        raise BridgeError("model request messages must be an array")
    messages: list[dict[str, Any]] = []
    for raw in raw_messages:
        if not isinstance(raw, Mapping):
            continue
        role = _text(raw.get("role"), 20)
        if role not in {"system", "user", "assistant"}:
            continue
        content = raw.get("content")
        if isinstance(content, str):
            if role == "system":
                normalized: Any = content
            else:
                normalized = [{
                    "type": "output_text" if role == "assistant" else "input_text",
                    "text": content,
                }]
        elif isinstance(content, list):
            items: list[dict[str, Any]] = []
            for item in content:
                if not isinstance(item, Mapping):
                    continue
                if item.get("type") == "text":
                    items.append({
                        "type": "output_text" if role == "assistant" else "input_text",
                        "text": _text(item.get("text"), 1_000_000),
                    })
                elif role == "user" and item.get("type") == "image_url":
                    image = item.get("image_url") if isinstance(item.get("image_url"), Mapping) else {}
                    url = _text(image.get("url"), 20_000_000)
                    if url:
                        normalized_image: dict[str, Any] = {
                            "type": "input_image",
                            "image_url": url,
                        }
                        if image.get("detail") in {"auto", "low", "high"}:
                            normalized_image["detail"] = image["detail"]
                        items.append(normalized_image)
            if role == "assistant":
                normalized = [item for item in items if item["type"] == "output_text"]
            elif role == "system":
                normalized = "\n".join(
                    item["text"] for item in items if item["type"] == "input_text"
                )
            else:
                normalized = items
        else:
            text = _text(content, 1_000_000)
            normalized = text if role == "system" else [{
                "type": "output_text" if role == "assistant" else "input_text",
                "text": text,
            }]
        if normalized:
            messages.append({"role": role, "content": normalized})
    if not messages:
        raise BridgeError("model request has no usable messages")
    return messages


def meta_payload(openai_payload: Mapping[str, Any], model: str) -> dict[str, Any]:
    requested_tokens = int(
        openai_payload.get("max_tokens")
        or openai_payload.get("max_completion_tokens")
        or 1500
    )
    messages = normalize_meta_messages(openai_payload.get("messages"))
    instructions = "\n\n".join(
        _text(message["content"], 1_000_000)
        for message in messages
        if message["role"] == "system"
    )
    response_input = [message for message in messages if message["role"] != "system"]
    if not response_input:
        raise BridgeError("model request has no usable non-system input")
    payload: dict[str, Any] = {
        "model": model,
        "input": response_input,
        "max_output_tokens": max(
            META_JUDGE_MIN_OUTPUT_TOKENS,
            min(131_072, requested_tokens),
        ),
        "reasoning": {
            "effort": META_JUDGE_REASONING_EFFORT,
            "summary": "auto",
        },
    }
    if instructions:
        payload["instructions"] = instructions
    for field in ("temperature", "top_p"):
        if openai_payload.get(field) is not None:
            payload[field] = float(openai_payload[field])
    return payload


def meta_completion(
    payload: Mapping[str, Any],
    api_key: str,
    base_url: str,
    session_id: str,
    timeout: float = 600.0,
) -> str:
    request = Request(
        f"{base_url.rstrip('/')}/responses",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "apollo-osworld-runner/1",
            "x-session-id": session_id,
        },
    )
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with urlopen(request, timeout=timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
            if not isinstance(value, Mapping):
                raise BridgeError("Meta returned a non-object response")
            if value.get("status") == "failed":
                error = value.get("error") if isinstance(value.get("error"), Mapping) else {}
                raise BridgeError(
                    "Meta Responses API failed: " + _text(error.get("message"), 500)
                )
            text = _text(value.get("output_text"), 1_000_000)
            if not text:
                parts: list[str] = []
                output = value.get("output") if isinstance(value.get("output"), list) else []
                for item in output:
                    if not isinstance(item, Mapping) or item.get("type") != "message":
                        continue
                    content = item.get("content") if isinstance(item.get("content"), list) else []
                    parts.extend(
                        _text(part.get("text"), 1_000_000)
                        for part in content
                        if isinstance(part, Mapping) and part.get("type") == "output_text"
                    )
                text = "\n".join(part for part in parts if part)
            if not text:
                incomplete = (
                    value.get("incomplete_details")
                    if isinstance(value.get("incomplete_details"), Mapping)
                    else {}
                )
                reason = _text(incomplete.get("reason"), 200)
                suffix = f" ({reason})" if reason else ""
                raise BridgeError("Meta returned an empty completion" + suffix)
            return text
        except HTTPError as exc:
            last_error = exc
            if exc.code not in {408, 409, 429} and exc.code < 500:
                try:
                    detail = _text(exc.read().decode("utf-8", errors="replace"), 500)
                except OSError:
                    detail = ""
                suffix = f": {detail}" if detail else ""
                raise BridgeError(f"Meta API returned HTTP {exc.code}{suffix}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError, BridgeError) as exc:
            last_error = exc
        if attempt < 4:
            time.sleep(min(2 ** attempt, 8))
    detail = _text(last_error, 500)
    suffix = f": {detail}" if detail else ""
    raise BridgeError(
        f"Meta API request failed after retries: {type(last_error).__name__}{suffix}"
    ) from last_error


class _MetaProxyHandler(BaseHTTPRequestHandler):
    server_version = "ApolloMetaProxy/1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send(self, status: int, value: Mapping[str, Any]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in {"", "/health"}:
            self._send(HTTPStatus.OK, {"ok": True})
        else:
            self._send(HTTPStatus.NOT_FOUND, {"error": {"code": "not_found", "message": "Not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in {"/v1/chat/completions", "/chat/completions"}:
            self._send(HTTPStatus.NOT_FOUND, {"error": {"code": "not_found", "message": "Not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            incoming = json.loads(raw.decode("utf-8"))
            if not isinstance(incoming, Mapping):
                raise BridgeError("request body must be an object")
            server = self.server
            assert isinstance(server, _MetaProxyServer)
            text = meta_completion(
                meta_payload(incoming, server.meta_model),
                server.meta_api_key,
                server.meta_base_url,
                server.meta_session_id,
            )
            self._send(HTTPStatus.OK, {
                "id": "apollo-meta-proxy",
                "object": "chat.completion",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            })
        except (BridgeError, json.JSONDecodeError, ValueError) as exc:
            self._send(HTTPStatus.BAD_GATEWAY, {
                "error": {"code": "meta_upstream_error", "message": str(exc)[:500]},
            })


class _MetaProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, api_key: str, model: str, base_url: str, session_id: str):
        super().__init__(("127.0.0.1", 0), _MetaProxyHandler)
        self.meta_api_key = api_key
        self.meta_model = model
        self.meta_base_url = base_url
        self.meta_session_id = session_id


@contextmanager
def meta_proxy(api_key: str, model: str, base_url: str, session_id: str) -> Iterator[str]:
    server = _MetaProxyServer(api_key, model, base_url, session_id)
    thread = threading.Thread(target=server.serve_forever, name="apollo-meta-proxy", daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def sanitized_environment() -> dict[str, str]:
    environment = dict(os.environ)
    for key in list(environment):
        upper = key.upper()
        if any(upper == pattern or upper.startswith(pattern) for pattern in SECRET_ENV_PATTERNS):
            environment.pop(key, None)
    environment.update({
        "PYTHONUNBUFFERED": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })
    return environment


def child_environment(base_url: str) -> dict[str, str]:
    environment = sanitized_environment()
    environment.update({
        "OPENAI_API_KEY": "local-meta-proxy",
        "OPENAI_BASE_URL": base_url,
    })
    return environment


def muse_child_environment(
    args: argparse.Namespace,
    meta_key: str,
    runner: Path,
) -> dict[str, str]:
    environment = sanitized_environment()
    root = args.osworld_root.expanduser().resolve()
    overlay_root = runner.parents[2]
    existing_pythonpath = environment.get("PYTHONPATH", "")
    pythonpath = [str(overlay_root), str(root)]
    if existing_pythonpath:
        pythonpath.append(existing_pythonpath)
    environment.update({
        "MUSE_SPARK_API_KEY": meta_key,
        "MUSE_SPARK_SESSION_ID": args.meta_session_id,
        "MUSE_SPARK_RUNNER_PATH": str(runner),
        "PYTHONPATH": os.pathsep.join(pythonpath),
    })
    return environment


def ensure_upstream_overlay(
    paths: JobPaths,
    commit: str,
    files: Mapping[str, str],
    entry: str,
    label: str,
) -> Path:
    """Download SHA-pinned upstream OSWorld files into a PYTHONPATH overlay."""
    overlay = paths.root / "upstream_osworld" / commit
    for relative, expected_sha256 in files.items():
        destination = overlay / relative
        if destination.is_file():
            current = hashlib.sha256(destination.read_bytes()).hexdigest()
            if current == expected_sha256:
                continue
        url = f"https://raw.githubusercontent.com/xlang-ai/OSWorld/{commit}/{relative}"
        request = Request(url, headers={"User-Agent": "apollo-osworld-runner/1"})
        try:
            with urlopen(request, timeout=60) as response:
                content = response.read()
        except (HTTPError, URLError, TimeoutError) as exc:
            raise BridgeError(f"could not fetch pinned {label} source: {relative}") from exc
        actual_sha256 = hashlib.sha256(content).hexdigest()
        if actual_sha256 != expected_sha256:
            raise BridgeError(f"pinned {label} source hash mismatch: {relative}")
        write_private_bytes(destination, content)
    package_init = overlay / "mm_agents/__init__.py"
    if not package_init.is_file():
        write_private_bytes(
            package_init,
            b"from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n",
        )
    return overlay / entry


def ensure_muse_spark_overlay(paths: JobPaths) -> Path:
    return ensure_upstream_overlay(
        paths, MUSE_SPARK_COMMIT, MUSE_SPARK_FILES,
        "scripts/python/run_multienv_muse_spark.py", "Muse Spark",
    )


def ensure_gpt54_overlay(paths: JobPaths) -> Path:
    return ensure_upstream_overlay(
        paths, GPT54_COMMIT, GPT54_FILES, "scripts/python/run_multienv_gpt54.py", "GPT-5.4",
    )


def agent_model(args: argparse.Namespace) -> str:
    return args.openai_model if args.agent_backend == "openai" else args.meta_model


def agent_label(args: argparse.Namespace) -> str:
    return "OSWorld GPT54Agent" if args.agent_backend == "openai" else "OSWorld MuseSparkAgent"


def validate_osworld(args: argparse.Namespace, paths: JobPaths, muse_runner: Path) -> None:
    root = args.osworld_root.expanduser().resolve()
    python = root / ".venv/bin/python"
    if not root.is_dir() or not (root / "scripts/python/run_multienv.py").is_file() or not python.is_file():
        raise BridgeError(f"OSWorld checkout is incomplete: {root}")
    if not muse_runner.is_file():
        raise BridgeError(f"pinned Muse Spark runner is missing: {muse_runner}")
    if not (root / "mm_agents/gpt54_agent.py").is_file():
        raise BridgeError(f"OSWorld checkout lacks Muse Spark support dependencies: {root}")
    if args.provider_name in {"vmware", "docker"} and not args.path_to_vm.expanduser().is_file():
        raise BridgeError(f"{args.provider_name} VM does not exist: {args.path_to_vm}")
    if args.provider_name == "apptainer":
        sif = Path(os.environ.get("OSWORLD_APPTAINER_SIF", ""))
        vms_dir = Path(os.environ.get("OSWORLD_APPTAINER_VMS_DIR", ""))
        if not sif.is_file():
            raise BridgeError(f"apptainer SIF is missing: set OSWORLD_APPTAINER_SIF ({sif})")
        if not (vms_dir / "Ubuntu.qcow2").is_file():
            raise BridgeError(
                f"apptainer base VM is missing: {vms_dir / 'Ubuntu.qcow2'};"
                " stage it before running so the provider cannot re-download it"
            )
        if not Path("/dev/kvm").exists():
            raise BridgeError("/dev/kvm is not available on this host")
    if not paths.tasks.is_file() or not paths.meta.is_file():
        raise BridgeError(f"job is not prepared below {paths.root}; run --stage fetch first")


def osworld_command(args: argparse.Namespace, paths: JobPaths) -> list[str]:
    root = args.osworld_root.expanduser().resolve()
    command = [
        str(root / ".venv/bin/python"),
        str(Path(__file__).with_name("muse_spark_launcher.py")),
        "--provider_name", args.provider_name,
        "--headless",
        "--action_space", "pyautogui",
        "--observation_type", "screenshot",
        "--model", args.meta_model,
        "--base_url", args.meta_base_url,
        "--api_key_envs", "MUSE_SPARK_API_KEY",
        "--max_steps", str(args.max_steps),
        "--max_tokens", str(args.max_tokens),
        "--max_trajectory_length", str(args.max_trajectory_length),
        "--reasoning_effort", args.reasoning_effort,
        "--request_timeout", str(args.request_timeout),
        "--max_retries", str(args.max_retries),
        "--num_envs", str(args.num_envs),
        "--sleep_after_execution", str(args.sleep_after_execution),
        "--result_dir", str(paths.results),
        "--test_config_base_dir", str(paths.configs),
        "--test_all_meta_path", str(paths.meta),
        "--domain", args.domain,
        "--client_password", args.client_password,
    ]
    if args.temperature is not None:
        command.extend(["--temperature", str(args.temperature)])
    if args.provider_name in {"vmware", "docker"}:
        command.extend(["--path_to_vm", str(args.path_to_vm.expanduser().resolve())])
    if args.provider_name == "aws":
        command.extend(["--region", args.aws_region])
    return command


def openai_osworld_command(args: argparse.Namespace, paths: JobPaths) -> list[str]:
    """Drive upstream's run_multienv_gpt54.py through the same launcher shim."""
    root = args.osworld_root.expanduser().resolve()
    command = [
        str(root / ".venv/bin/python"),
        str(Path(__file__).with_name("muse_spark_launcher.py")),
        "--provider_name", args.provider_name,
        "--headless",
        "--action_space", "pyautogui",
        "--observation_type", "screenshot",
        "--model", args.openai_model,
        "--reasoning_effort", args.openai_reasoning_effort,
        "--max_steps", str(args.max_steps),
        "--max_trajectory_length", str(args.max_trajectory_length),
        "--num_envs", str(args.num_envs),
        "--sleep_after_execution", str(args.sleep_after_execution),
        "--result_dir", str(paths.results),
        "--test_config_base_dir", str(paths.configs),
        "--test_all_meta_path", str(paths.meta),
        "--domain", args.domain,
        "--client_password", args.client_password,
    ]
    if args.provider_name in {"vmware", "docker"}:
        command.extend(["--path_to_vm", str(args.path_to_vm.expanduser().resolve())])
    if args.provider_name == "aws":
        command.extend(["--region", args.aws_region])
    return command


def openai_child_environment(openai_key: str, runner: Path, osworld_root: Path) -> dict[str, str]:
    environment = sanitized_environment()
    overlay_root = runner.parents[2]
    pythonpath = [str(overlay_root), str(osworld_root.expanduser().resolve())]
    if environment.get("PYTHONPATH"):
        pythonpath.append(environment["PYTHONPATH"])
    environment.update({
        "OPENAI_API_KEY": openai_key,
        "MUSE_SPARK_RUNNER_PATH": str(runner),
        "PYTHONPATH": os.pathsep.join(pythonpath),
    })
    return environment


def run_osworld(args: argparse.Namespace, paths: JobPaths, agent_key: str) -> None:
    if args.agent_backend == "openai":
        runner = ensure_gpt54_overlay(paths)
        command = openai_osworld_command(args, paths)
        environment = openai_child_environment(agent_key, runner, args.osworld_root)
    else:
        runner = ensure_muse_spark_overlay(paths)
        command = osworld_command(args, paths)
        environment = muse_child_environment(args, agent_key, runner)
    validate_osworld(args, paths, runner)
    ensure_muse_spark_vm_prerequisite(paths)
    if args.provider_name == "vmware" and args.num_envs != 1:
        raise BridgeError("an explicit VMware VM can run only one environment at a time")
    subprocess.run(command, cwd=paths.root, env=environment, check=True)
    if not paths.runs.is_dir():
        raise BridgeError(f"OSWorld produced no run directory at {paths.runs}")


def trajectory_command(args: argparse.Namespace, paths: JobPaths, *, plan: bool) -> list[str]:
    command = [
        sys.executable,
        str(Path(__file__).resolve().parents[1] / "trajectory_review/run.py"),
        "--runs-dir", str(paths.runs),
        "--task-source-json", str(paths.tasks),
        "--output-dir", str(paths.trajectory_output),
        "--provider", "openai" if args.agent_backend == "openai" else "meta",
        "--judge-impl", args.judge_impl,
        "--model", args.judge_model if args.agent_backend == "openai" else args.meta_model,
        "--queue", args.queue,
        "--num-workers", str(args.judge_workers),
        "--max-images", str(args.judge_max_images),
        "--agent", agent_label(args),
        "--run-model", agent_model(args),
        "--run-label", args.run_label,
        "--aws-region", args.aws_region,
        "--s3-bucket", args.s3_bucket,
    ]
    if args.aws_profile:
        command.extend(["--aws-profile", args.aws_profile])
    if plan:
        command.append("--plan")
    return command


def publish_trajectories(args: argparse.Namespace, paths: JobPaths, agent_key: str, *, plan: bool) -> None:
    if not paths.runs.is_dir():
        raise BridgeError(f"OSWorld runs do not exist: {paths.runs}")
    if plan:
        subprocess.run(trajectory_command(args, paths, plan=True), check=True)
        return
    if args.agent_backend == "openai":
        # The judge talks to OpenAI directly; only the scoped key is forwarded.
        environment = sanitized_environment()
        environment["OPENAI_API_KEY"] = agent_key
        subprocess.run(trajectory_command(args, paths, plan=False), check=True, env=environment)
        return
    with meta_proxy(
        agent_key,
        args.meta_model,
        args.meta_base_url,
        args.meta_session_id,
    ) as base_url:
        subprocess.run(
            trajectory_command(args, paths, plan=False),
            check=True,
            env=child_environment(base_url),
        )


def require_secret(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise BridgeError(f"set {name} in the process environment")
    return value


def require_meta_key() -> str:
    for name in META_KEY_ENV_NAMES:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    raise BridgeError(
        "set MUSE_SPARK_API_KEY (preferred) or META_API_KEY in the process environment"
    )


def require_agent_key(args: argparse.Namespace) -> str:
    if args.agent_backend == "openai":
        return require_secret("OPENAI_API_KEY")
    return require_meta_key()


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Fetch author-signed Apollo tasks, run them in OSWorld with Meta Llama, and publish trajectories."
    )
    value.add_argument("--stage", choices=("fetch", "run", "publish", "all"), default="all")
    value.add_argument("--queue", choices=("v2", "pc"), default="v2")
    value.add_argument("--api-url", default=None)
    value.add_argument("--task-id", action="append", default=[])
    value.add_argument(
        "--exclude-task-ids-file",
        type=Path,
        default=None,
        help="file of task IDs (one per line) to never select, e.g. known content-filter rejects",
    )
    value.add_argument("--limit", type=int, default=1)
    value.add_argument("--include-existing-trajectories", action="store_true")
    value.add_argument(
        "--dedupe-by-model",
        action="store_true",
        help="skip a task only when THIS model already has a trajectory for it "
             "(multi-model coverage); default skips tasks with any trajectory",
    )
    value.add_argument("--shard-count", type=int, default=1)
    value.add_argument("--shard-index", type=int, default=0)
    value.add_argument("--work-dir", type=Path, default=DEFAULT_WORK_DIR)
    value.add_argument("--domain", default="apollo_chrome")
    value.add_argument(
        "--start-url-mode",
        choices=("google", "site_scope"),
        default="google",
        help="browser tabs opened before the run: a blank Google search (default, "
             "matching most Odysseys configs) or the task's authored key_urls/site_scope",
    )
    value.add_argument("--osworld-root", type=Path, default=DEFAULT_OSWORLD_ROOT)
    value.add_argument(
        "--provider-name", choices=("vmware", "docker", "aws", "apptainer"), default="docker"
    )
    value.add_argument("--path-to-vm", type=Path, default=None)
    value.add_argument("--num-envs", type=int, default=1)
    value.add_argument("--max-steps", type=int, default=100)
    value.add_argument("--max-tokens", type=int, default=131_072)
    value.add_argument("--max-trajectory-length", type=int, default=100)
    value.add_argument("--temperature", type=float, default=None)
    value.add_argument("--sleep-after-execution", type=float, default=2.0)
    value.add_argument(
        "--request-timeout",
        type=float,
        default=DEFAULT_MUSE_REQUEST_TIMEOUT,
        help="Per-request Meta timeout in seconds for the desktop agent",
    )
    value.add_argument(
        "--max-retries",
        type=int,
        default=DEFAULT_MUSE_MAX_RETRIES,
        help="Maximum Meta SDK retries for a desktop-agent request",
    )
    value.add_argument("--client-password", default="password")
    value.add_argument("--meta-model", default=DEFAULT_META_MODEL)
    value.add_argument("--meta-base-url", default=DEFAULT_META_BASE_URL)
    value.add_argument("--meta-session-id", default=DEFAULT_META_SESSION_ID)
    value.add_argument(
        "--agent-backend",
        choices=AGENT_BACKENDS,
        default="muse-spark",
        help="desktop agent: Meta Muse Spark (default) or upstream OSWorld's OpenAI GPT-5.4-style agent",
    )
    value.add_argument("--openai-model", default=DEFAULT_OPENAI_MODEL)
    value.add_argument(
        "--openai-reasoning-effort",
        choices=("none", "low", "medium", "high", "xhigh"),
        default=DEFAULT_OPENAI_REASONING_EFFORT,
    )
    value.add_argument(
        "--judge-model",
        default=DEFAULT_OPENAI_JUDGE_MODEL,
        help="rubric judge model for the openai backend (the meta backend judges with --meta-model)",
    )
    value.add_argument(
        "--judge-impl",
        choices=("repo", "canonical"),
        default="canonical",
        help="which rubric judge to run: Odysseys' canonical file (default) or the in-tree counterpart",
    )
    value.add_argument(
        "--judge-max-images",
        type=int,
        default=JUDGE_SCREENSHOT_SAMPLE,
        help="screenshots per rubric judgment; 0 = the whole trajectory (Odysseys canonical behaviour)",
    )
    value.add_argument(
        "--reasoning-effort",
        choices=("none", "low", "medium", "high", "xhigh"),
        default="high",
    )
    value.add_argument("--judge-workers", type=int, default=1)
    value.add_argument("--run-label", default="Apollo author-approved Meta pilot")
    value.add_argument("--s3-bucket", default=DEFAULT_BUCKET)
    value.add_argument("--aws-profile", default=None)
    value.add_argument("--aws-region", default="us-east-1")
    value.add_argument("--plan", action="store_true", help="Validate an existing run and AWS access without model calls or writes")
    return value


def main(argv: Sequence[str] | None = None) -> None:
    args = parser().parse_args(argv)
    args.api_url = args.api_url or DEFAULT_APIS[args.queue]
    if args.path_to_vm is None:
        args.path_to_vm = DEFAULT_DOCKER_VM_PATH if args.provider_name == "docker" else DEFAULT_VM_PATH
    paths = job_paths(args.work_dir, domain=args.domain, model=agent_model(args))
    try:
        if args.num_envs < 1:
            raise BridgeError("--num-envs must be at least 1")
        if args.shard_count < 1:
            raise BridgeError("--shard-count must be at least 1")
        if args.shard_index < 0 or args.shard_index >= args.shard_count:
            raise BridgeError("--shard-index must be between 0 and shard-count - 1")
        if args.judge_workers < 1:
            raise BridgeError("--judge-workers must be at least 1")
        if args.request_timeout <= 0:
            raise BridgeError("--request-timeout must be positive")
        if args.max_retries < 0:
            raise BridgeError("--max-retries cannot be negative")
        if args.plan and args.stage not in {"publish", "all"}:
            raise BridgeError("--plan is valid only with --stage publish or all after OSWorld runs exist")

        if args.stage in {"fetch", "all"} and not args.plan:
            token = require_secret("APOLLO_REPORTING_TOKEN")
            all_tasks = fetch_reporting_tasks(args.api_url, token)
            existing_task_ids = (
                set() if args.include_existing_trajectories
                else fetch_trajectory_task_ids(
                    args.api_url,
                    token,
                    model=agent_model(args) if args.dedupe_by_model else None,
                )
            )
            selected, skipped = select_tasks(
                all_tasks,
                queue=args.queue,
                wanted_ids=args.task_id,
                limit=args.limit,
                include_existing=args.include_existing_trajectories,
                existing_task_ids=existing_task_ids,
                shard_count=args.shard_count,
                shard_index=args.shard_index,
                excluded_ids=read_task_id_list(args.exclude_task_ids_file),
            )
            if not selected:
                raise BridgeError("no author-signed tasks without existing trajectories are available")
            manifest = prepare_job(selected, paths, args.domain, args.start_url_mode)
            print(json.dumps({
                "stage": "fetch",
                "job": manifest,
                "skipped_count": len(skipped),
                "existing_trajectory_tasks": len(existing_task_ids),
            }, indent=2))

        if args.stage in {"run", "all"} and not args.plan:
            run_osworld(args, paths, require_agent_key(args))

        if args.stage in {"publish", "all"}:
            agent_key = "" if args.plan else require_agent_key(args)
            publish_trajectories(args, paths, agent_key, plan=args.plan)
    except (BridgeError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"error: {exc}") from exc


if __name__ == "__main__":
    main()
