#!/usr/bin/env python3
"""Resumable Codex CLI fan-out for Apollo live-web feasibility review.

Each rubric is assigned to an independent ephemeral Codex process. A separate
manager process synthesizes the validated rubric outputs. All task-level
artifacts are immutable and content-addressed before optional S3 upload.
"""

from __future__ import annotations

import argparse
import base64
import copy
import concurrent.futures
import dataclasses
import datetime as dt
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


PIPELINE_VERSION = "apollo-llm-feasibility-v22"
ARTIFACT_SCHEMA_VERSION = "apollo-llm-feasibility-artifact-v11"
RUBRIC_SCHEMA_VERSION = "apollo-rubric-feasibility-v9"
BROWSER_SCHEMA_VERSION = "apollo-browser-feasibility-v3"
FEASIBILITY_MANAGER_SCHEMA_VERSION = "apollo-feasibility-manager-core-v4"
EVERGREEN_SCHEMA_VERSION = "apollo-evergreen-review-v1"
MANAGER_SCHEMA_VERSION = "apollo-feasibility-manager-v10"
QUALITY_SCHEMA_VERSION = "apollo-task-quality-review-v5"
RUBRIC_REPAIR_SCHEMA_VERSION = "apollo-rubric-repair-v3"
TASK_REPAIR_MANAGER_SCHEMA_VERSION = "apollo-task-repair-manager-v1"
REPAIR_PLAN_SCHEMA_VERSION = "apollo-task-repair-plan-v3"
RUBRIC_REPAIR_VERIFICATION_SCHEMA_VERSION = "apollo-rubric-repair-verification-v3"
PLAYWRIGHT_MCP_VERSION = "0.0.79"
PRE_QC_PASS_PREFIX = "v2-review/llm_pre_qc_pass"
PRE_QC_ATTENTION_PREFIX = "v2-review/llm_pre_qc_attention"
PRE_QC_CLAIM_PREFIX = "v2-review/llm_pre_qc_claims"
QUEUE_ROOTS = {"v2": "v2-review", "pc": "pc-review"}
BASE_DIR = Path(__file__).resolve().parent
SCHEMA_DIR = BASE_DIR / "schemas"
PROMPT_DIR = BASE_DIR / "prompts"
DEFAULT_WORKDIR = Path(".work/llm_feasibility")
SAFE_ID_RE = re.compile(r"[^A-Za-z0-9._-]+")
UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")

HUMAN_REVIEW_COPY_RULES = """
Human-facing writing rules:
- Keep every required enum and routing field exactly as defined by the schema.
- Write summaries, feedback, notes, reasons, concerns, and blockers for a busy human reviewer.
- Use one or two short sentences, no more than 360 characters total. Lead with the practical finding and the specific website fact that supports it.
- Say task, step, website, and page. In human-facing prose, do not say rubric, live-web, worker, manager, shortfall, feasibility, compatibility, enumerable, or deterministically bounded.
- Never say critical. Do not write a dependency essay or list every uncertain detail when one concrete finding is enough.
- Do not repeat machine values such as POSSIBLE, IMPOSSIBLE, SHORTFALL, PASS, FAIL, or FEASIBLE in prose.
- For a clear result, write: "An agent can complete this step. [What the checked page proves]."
- For a problem, write: "This step needs attention because [specific obstacle]." Then say what a person should verify or change.
- State each issue once. Do not repeat the same point across summary, feedback, blockers, or task-level notes.
- Keep pipeline stages, confidence mechanics, storage details, and implementation terminology out of human-facing prose.
- A website-check limitation is not proof that the task cannot be done. Say what was not verified without turning that limitation into a task defect.
""".strip()


class PipelineError(RuntimeError):
    """Expected operational or validation failure."""


@dataclasses.dataclass(frozen=True)
class Rubric:
    rubric_id: str
    criterion: str
    critical: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "rubric_id": self.rubric_id,
            "criterion": self.criterion,
            "critical": self.critical,
        }


@dataclasses.dataclass(frozen=True)
class Task:
    task_id: str
    prompt: str
    rubrics: tuple[Rubric, ...]
    effective_task: Mapping[str, Any] | None = None
    task_content_hash: str = ""
    workflow_status: str | None = None

    def __post_init__(self) -> None:
        if self.task_content_hash:
            if not re.fullmatch(r"[a-f0-9]{64}", self.task_content_hash):
                raise PipelineError("task_content_hash must be 64 lowercase hexadecimal characters")
            return
        body = {"task_id": self.task_id, **self.source_dict()}
        object.__setattr__(
            self,
            "task_content_hash",
            hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest(),
        )

    def source_dict(self) -> dict[str, Any]:
        effective_task = dict(self.effective_task) if self.effective_task is not None else {"request": self.prompt}
        return {
            "effective_task": effective_task,
            "prompt": self.prompt,
            "rubrics": [r.as_dict() for r in self.rubrics],
        }

@dataclasses.dataclass
class Config:
    workdir: Path
    workers: int
    timeout_seconds: int
    retries: int
    model: str | None
    codex_bin: str
    upload: bool
    s3_bucket: str | None
    s3_pass_prefix: str
    s3_fail_prefix: str
    s3_claim_prefix: str
    aws_profile: str | None
    aws_region: str | None
    lock_stale_seconds: int
    browser_escalation: bool
    pre_qc: bool = False
    s3_pre_qc_pass_prefix: str = PRE_QC_PASS_PREFIX
    s3_pre_qc_attention_prefix: str = PRE_QC_ATTENTION_PREFIX
    s3_pre_qc_claim_prefix: str = PRE_QC_CLAIM_PREFIX
    reasoning_effort: str | None = None
    model_provider: str | None = None


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def safe_id(value: str, max_length: int = 160) -> str:
    cleaned = SAFE_ID_RE.sub("_", value.strip()).strip("._-")
    if not cleaned:
        cleaned = hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]
    if len(cleaned) <= max_length:
        return cleaned
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
    return f"{cleaned[: max_length - 17]}-{digest}"


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def task_belongs_to_queue(task_id: str, queue: str) -> bool:
    """Fail closed for PC IDs while retaining legacy non-PC rows in v2."""
    is_pc = str(task_id).startswith("pc_")
    return is_pc if queue == "pc" else not is_pc


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PipelineError(f"Cannot read valid JSON from {path}: {exc}") from exc


def _require_object(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PipelineError(f"{where} must be a JSON object")
    return value


def _require_exact_keys(value: Mapping[str, Any], required: set[str], where: str) -> None:
    missing = sorted(required - set(value))
    extra = sorted(set(value) - required)
    if missing or extra:
        parts = []
        if missing:
            parts.append(f"missing {missing}")
        if extra:
            parts.append(f"unexpected {extra}")
        raise PipelineError(f"{where} has invalid keys: {', '.join(parts)}")


def _require_text(value: Any, where: str, max_length: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()) or len(value) > max_length:
        qualifier = "a string" if allow_empty else "a non-empty string"
        raise PipelineError(f"{where} must be {qualifier} of at most {max_length} characters")
    return value


def _require_utc(value: Any, where: str) -> str:
    text = _require_text(value, where, 80)
    if not UTC_RE.match(text):
        raise PipelineError(f"{where} must be an ISO-8601 UTC timestamp")
    try:
        dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PipelineError(f"{where} is not a valid timestamp") from exc
    return text


def _require_string_list(value: Any, where: str, max_items: int, max_length: int) -> list[str]:
    if not isinstance(value, list) or len(value) > max_items:
        raise PipelineError(f"{where} must be an array of at most {max_items} strings")
    return [_require_text(item, f"{where}[{index}]", max_length) for index, item in enumerate(value)]


RUBRIC_KEYS = {
    "schema_version",
    "task_id",
    "rubric_id",
    "verdict",
    "confidence",
    "tested_at_utc",
    "summary",
    "evidence",
    "access_constraints",
    "blockers",
    "safety_notes",
    "rubric_feedback",
    "browser_verification",
}
EVIDENCE_KEYS = {
    "url",
    "title",
    "observed_at_utc",
    "access_status",
    "authority_role",
    "supports",
    "fact_or_inference",
    "limitations",
}
BROWSER_VERIFICATION_KEYS = {"needed", "limitation_only", "reason", "target_urls", "safe_actions"}
BROWSER_REVIEW_KEYS = {
    "schema_version",
    "task_id",
    "rubric_id",
    "verdict",
    "confidence",
    "tested_at_utc",
    "summary",
    "evidence",
    "access_constraints",
    "blockers",
    "safety_notes",
    "rubric_feedback",
    "limitation_kind",
    "task_blocker",
}
BROWSER_EVIDENCE_KEYS = {
    "url",
    "title",
    "observed_at_utc",
    "actions",
    "observations",
    "side_effects",
}


def validate_rubric_review(value: Any, task_id: str, rubric_id: str) -> dict[str, Any]:
    review = _require_object(value, "rubric review")
    _require_exact_keys(review, RUBRIC_KEYS, "rubric review")
    if review["schema_version"] != RUBRIC_SCHEMA_VERSION:
        raise PipelineError("rubric review has the wrong schema_version")
    if review["task_id"] != task_id or review["rubric_id"] != rubric_id:
        raise PipelineError("rubric review task_id or rubric_id does not match its assignment")
    if review["verdict"] not in {"POSSIBLE", "SHORTFALL", "IMPOSSIBLE"}:
        raise PipelineError("rubric review verdict is invalid")
    confidence = review["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise PipelineError("rubric review confidence must be between 0 and 1")
    _require_utc(review["tested_at_utc"], "rubric review tested_at_utc")
    _require_text(review["summary"], "rubric review summary", 360)
    evidence = review["evidence"]
    if not isinstance(evidence, list) or len(evidence) > 20:
        raise PipelineError("rubric review evidence must be an array of at most 20 items")
    if review["verdict"] == "POSSIBLE" and not evidence:
        raise PipelineError("a POSSIBLE rubric review must include direct evidence")
    for index, raw_item in enumerate(evidence):
        item = _require_object(raw_item, f"evidence[{index}]")
        _require_exact_keys(item, EVIDENCE_KEYS, f"evidence[{index}]")
        url = _require_text(item["url"], f"evidence[{index}].url", 4000)
        if not url.startswith(("https://", "http://")):
            raise PipelineError(f"evidence[{index}].url must use http or https")
        _require_text(item["title"], f"evidence[{index}].title", 500)
        _require_utc(item["observed_at_utc"], f"evidence[{index}].observed_at_utc")
        if item["access_status"] not in {"OK", "BLOCKED", "DEAD", "PARKED", "LOGIN_REQUIRED"}:
            raise PipelineError(f"evidence[{index}].access_status is invalid")
        if item["authority_role"] not in {"DISCOVERY", "VERIFICATION", "CORROBORATION"}:
            raise PipelineError(f"evidence[{index}].authority_role is invalid")
        _require_text(item["supports"], f"evidence[{index}].supports", 3000)
        if item["fact_or_inference"] not in {"FACT", "INFERENCE"}:
            raise PipelineError(f"evidence[{index}].fact_or_inference is invalid")
        _require_text(item["limitations"], f"evidence[{index}].limitations", 3000, allow_empty=True)
    _require_string_list(review["access_constraints"], "access_constraints", 20, 360)
    _require_string_list(review["blockers"], "blockers", 20, 360)
    _require_text(review["safety_notes"], "safety_notes", 3000, allow_empty=True)
    feedback = review["rubric_feedback"]
    if feedback is not None:
        _require_text(feedback, "rubric_feedback", 360)
    browser = _require_object(review["browser_verification"], "browser_verification")
    _require_exact_keys(browser, BROWSER_VERIFICATION_KEYS, "browser_verification")
    if not isinstance(browser["needed"], bool):
        raise PipelineError("browser_verification.needed must be a boolean")
    if not isinstance(browser["limitation_only"], bool):
        raise PipelineError("browser_verification.limitation_only must be a boolean")
    reason = browser["reason"]
    if reason is not None:
        _require_text(reason, "browser_verification.reason", 2000)
    target_urls = _require_string_list(browser["target_urls"], "browser_verification.target_urls", 10, 4000)
    for index, url in enumerate(target_urls):
        if not url.startswith(("https://", "http://")):
            raise PipelineError(f"browser_verification.target_urls[{index}] must use http or https")
    _require_string_list(browser["safe_actions"], "browser_verification.safe_actions", 20, 1000)
    if browser["needed"]:
        if review["verdict"] != "SHORTFALL":
            raise PipelineError("browser verification may be requested only for a SHORTFALL")
        if not reason or not target_urls:
            raise PipelineError("requested browser verification requires a reason and at least one target URL")
    elif reason is not None or target_urls or browser["safe_actions"]:
        raise PipelineError("unneeded browser verification must use null reason and empty target/action arrays")
    if not browser["needed"] and browser["limitation_only"]:
        raise PipelineError("unneeded browser verification cannot be limitation-only")
    return review


def validate_browser_review(value: Any, task_id: str, rubric_id: str) -> dict[str, Any]:
    review = _require_object(value, "browser review")
    _require_exact_keys(review, BROWSER_REVIEW_KEYS, "browser review")
    if review["schema_version"] != BROWSER_SCHEMA_VERSION:
        raise PipelineError("browser review has the wrong schema_version")
    if review["task_id"] != task_id or review["rubric_id"] != rubric_id:
        raise PipelineError("browser review task_id or rubric_id does not match its assignment")
    if review["verdict"] not in {"POSSIBLE", "SHORTFALL", "IMPOSSIBLE"}:
        raise PipelineError("browser review verdict is invalid")
    confidence = review["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise PipelineError("browser review confidence must be between 0 and 1")
    _require_utc(review["tested_at_utc"], "browser review tested_at_utc")
    _require_text(review["summary"], "browser review summary", 360)
    evidence = review["evidence"]
    if not isinstance(evidence, list) or len(evidence) > 20:
        raise PipelineError("browser review evidence must be an array of at most 20 items")
    if review["verdict"] == "POSSIBLE" and not evidence:
        raise PipelineError("a POSSIBLE browser review must include direct evidence")
    for index, raw_item in enumerate(evidence):
        item = _require_object(raw_item, f"browser evidence[{index}]")
        _require_exact_keys(item, BROWSER_EVIDENCE_KEYS, f"browser evidence[{index}]")
        url = _require_text(item["url"], f"browser evidence[{index}].url", 4000)
        if not url.startswith(("https://", "http://")):
            raise PipelineError(f"browser evidence[{index}].url must use http or https")
        _require_text(item["title"], f"browser evidence[{index}].title", 500)
        _require_utc(item["observed_at_utc"], f"browser evidence[{index}].observed_at_utc")
        _require_string_list(item["actions"], f"browser evidence[{index}].actions", 20, 1000)
        _require_text(item["observations"], f"browser evidence[{index}].observations", 3000)
        if item["side_effects"] != "NONE":
            raise PipelineError(f"browser evidence[{index}].side_effects must be NONE")
    _require_string_list(review["access_constraints"], "browser access_constraints", 20, 360)
    _require_string_list(review["blockers"], "browser blockers", 20, 360)
    _require_text(review["safety_notes"], "browser safety_notes", 3000, allow_empty=True)
    feedback = review["rubric_feedback"]
    if feedback is not None:
        _require_text(feedback, "browser rubric_feedback", 360)
    if review["limitation_kind"] not in {"NONE", "CHECKER_TOOL", "ACCESS", "TASK_DEFECT"}:
        raise PipelineError("browser limitation_kind is invalid")
    if not isinstance(review["task_blocker"], bool):
        raise PipelineError("browser task_blocker must be a boolean")
    if review["verdict"] == "POSSIBLE" and (review["limitation_kind"] != "NONE" or review["task_blocker"]):
        raise PipelineError("a POSSIBLE browser review cannot report a limitation or task blocker")
    if review["limitation_kind"] == "CHECKER_TOOL" and review["task_blocker"]:
        raise PipelineError("a checker-tool limitation cannot be a task blocker")
    return review


def bind_worker_assignment_ids(value: Any, task_id: str, rubric_id: str) -> Any:
    """Bind machine-owned routing IDs without changing the worker's review content."""
    if not isinstance(value, dict):
        return value
    bound = dict(value)
    bound["task_id"] = task_id
    bound["rubric_id"] = rubric_id
    return bound


def normalize_rubric_worker_output(value: Any, task_id: str, rubric_id: str) -> Any:
    """Normalize machine-owned routing and inactive browser-request fields only."""
    bound = bind_worker_assignment_ids(value, task_id, rubric_id)
    if not isinstance(bound, dict):
        return bound
    browser = bound.get("browser_verification")
    if isinstance(browser, dict) and browser.get("needed") is False:
        bound = dict(bound)
        bound["browser_verification"] = {
            **browser,
            "limitation_only": False,
            "reason": None,
            "target_urls": [],
            "safe_actions": [],
        }
    return bound


FEASIBILITY_MANAGER_KEYS = {
    "schema_version",
    "task_id",
    "disposition",
    "confidence",
    "reviewed_at_utc",
    "summary",
    "rubric_assessments",
    "cross_rubric_conflicts",
    "task_level_risks",
    "task_feedback",
}
MANAGER_KEYS = FEASIBILITY_MANAGER_KEYS | {"evergreen_review", "quality_review"}
ASSESSMENT_KEYS = {"rubric_id", "accepted_worker_verdict", "manager_note"}
EVERGREEN_KEYS = {"verdict", "summary", "concerns"}
EVERGREEN_REVIEW_KEYS = {
    "schema_version",
    "task_id",
    "verdict",
    "confidence",
    "reviewed_at_utc",
    "summary",
    "concerns",
}
QUALITY_VERDICTS = {"PASS", "FAIL", "NEEDS_HUMAN_REVIEW"}
QUALITY_AXIS_KEYS = {"verdict", "summary", "concerns"}
QUALITY_DIFFICULTY_KEYS = QUALITY_AXIS_KEYS | {"rating"}
QUALITY_RUBRIC_KEYS = {
    "rubric_id",
    "verdict",
    "summary",
    "issues",
    "request_support",
    "introduced_requirements",
}
QUALITY_REVIEW_KEYS = {
    "schema_version",
    "task_id",
    "overall_verdict",
    "confidence",
    "reviewed_at_utc",
    "summary",
    "task_coherence",
    "rubric_assessments",
}


def _validate_quality_axis(value: Any, where: str, *, difficulty: bool = False) -> dict[str, Any]:
    axis = _require_object(value, where)
    _require_exact_keys(axis, QUALITY_DIFFICULTY_KEYS if difficulty else QUALITY_AXIS_KEYS, where)
    if axis["verdict"] not in QUALITY_VERDICTS:
        raise PipelineError(f"{where} verdict is invalid")
    _require_text(axis["summary"], f"{where} summary", 360)
    _require_string_list(axis["concerns"], f"{where} concerns", 3, 360)
    if difficulty:
        if axis["rating"] not in {"TOO_EASY", "APPROPRIATE", "TOO_HARD", "UNJUDGEABLE"}:
            raise PipelineError("quality difficulty rating is invalid")
        if axis["verdict"] == "PASS" and axis["rating"] != "APPROPRIATE":
            raise PipelineError("quality difficulty may pass only when its rating is APPROPRIATE")
    return axis


# Exact named services are not harmless implementation details when they occur
# only in a scored step. Requiring an unrequested site makes the evaluator
# stricter than the authored request. This deterministic inventory supplements
# the model's semantic alignment judgment and makes known false-pass cases such
# as an unrequested CryptPad deliverable fail closed.
NAMED_SERVICE_REQUIREMENTS = (
    "Airtable", "Amazon", "Apple Maps", "Asana", "Booking.com", "Canva",
    "ChatGPT", "ClickUp", "CoinGecko", "CoinMarketCap", "CryptPad", "Dropbox",
    "eBay", "Eventbrite", "Expedia", "Facebook", "Figma", "GitHub", "Gmail",
    "Google Calendar", "Google Docs", "Google Drive", "Google Flights",
    "Google Maps", "Google Sheets", "Instagram", "Kayak", "LinkedIn",
    "Notion", "OneDrive", "OpenTable", "Reddit", "Resy", "Slack", "Spotify",
    "TikTok", "Todoist", "Trello", "Tripadvisor", "Twitter", "Uber", "Venmo",
    "Walmart", "Webull", "X.com", "YouTube", "Zillow",
)
CAMEL_REQUIREMENT_RE = re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b")


def _alignment_text(value: str) -> str:
    return " ".join(str(value or "").casefold().split())


def named_requirement_candidates(criterion: str) -> tuple[str, ...]:
    text = str(criterion or "")
    candidates: list[str] = []
    normalized = _alignment_text(text)
    for service in NAMED_SERVICE_REQUIREMENTS:
        if _alignment_text(service) in normalized:
            candidates.append(service)
    for token in CAMEL_REQUIREMENT_RE.findall(text):
        if token not in candidates:
            candidates.append(token)
    return tuple(dict.fromkeys(candidates))


def unrequested_named_requirements(task: Task, rubric: Rubric) -> tuple[str, ...]:
    prompt = _alignment_text(task.prompt)
    return tuple(
        candidate
        for candidate in named_requirement_candidates(rubric.criterion)
        if _alignment_text(candidate) not in prompt
    )


def enforce_named_requirement_alignment(value: Any, task: Task) -> Any:
    """Fail a model PASS that requires a named app absent from the request.

    The model output remains available in the attempt cache. The validated
    review records the deterministic correction so the task produces useful
    attention feedback instead of becoming a pipeline error.
    """
    if not isinstance(value, dict) or not isinstance(value.get("rubric_assessments"), list):
        return value
    review = copy.deepcopy(value)
    rubrics_by_id = {rubric.rubric_id: rubric for rubric in task.rubrics}
    changed = False
    for assessment in review["rubric_assessments"]:
        if not isinstance(assessment, dict) or assessment.get("verdict") != "PASS":
            continue
        rubric = rubrics_by_id.get(str(assessment.get("rubric_id") or ""))
        if rubric is None:
            continue
        unrequested = unrequested_named_requirements(task, rubric)
        if not unrequested:
            continue
        changed = True
        names = ", ".join(unrequested)
        assessment["verdict"] = "FAIL"
        introduced = assessment.get("introduced_requirements")
        if not isinstance(introduced, list):
            introduced = []
        assessment["introduced_requirements"] = [
            *[str(item) for item in introduced if str(item).strip()],
            *[f"Require {name}" for name in unrequested],
        ][:3]
        issues = assessment.get("issues")
        if not isinstance(issues, list):
            issues = []
        assessment["issues"] = [
            *[str(item) for item in issues if str(item).strip()],
            f"{names} is required by this step but not by the task request.",
        ][:3]
        assessment["summary"] = (
            f"This step needs attention because it requires {names}, "
            "which the task request does not ask for."
        )[:360]
    if changed:
        verdicts = [
            str(review.get("task_coherence", {}).get("verdict") or "NEEDS_HUMAN_REVIEW"),
            *[str(item.get("verdict") or "NEEDS_HUMAN_REVIEW") for item in review["rubric_assessments"] if isinstance(item, dict)],
        ]
        review["overall_verdict"] = (
            "FAIL" if "FAIL" in verdicts
            else "NEEDS_HUMAN_REVIEW" if "NEEDS_HUMAN_REVIEW" in verdicts
            else "PASS"
        )
        review["summary"] = (
            "This task needs attention because at least one scored step requires "
            "a named app or service that the original request does not ask for."
        )
    return review


def validate_quality_review(value: Any, task: Task) -> dict[str, Any]:
    review = _require_object(value, "quality review")
    _require_exact_keys(review, QUALITY_REVIEW_KEYS, "quality review")
    if review["schema_version"] != QUALITY_SCHEMA_VERSION:
        raise PipelineError("quality review has the wrong schema_version")
    if review["task_id"] != task.task_id:
        raise PipelineError("quality review task_id does not match its assignment")
    if review["overall_verdict"] not in QUALITY_VERDICTS:
        raise PipelineError("quality review overall_verdict is invalid")
    confidence = review["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise PipelineError("quality review confidence must be between 0 and 1")
    _require_utc(review["reviewed_at_utc"], "quality review reviewed_at_utc")
    _require_text(review["summary"], "quality review summary", 360)
    coherence = _validate_quality_axis(review["task_coherence"], "quality task_coherence")
    assessments = review["rubric_assessments"]
    if not isinstance(assessments, list) or not assessments:
        raise PipelineError("quality review must contain rubric_assessments")
    actual_ids: list[str] = []
    for index, raw_item in enumerate(assessments):
        item = _require_object(raw_item, f"quality rubric_assessments[{index}]")
        _require_exact_keys(item, QUALITY_RUBRIC_KEYS, f"quality rubric_assessments[{index}]")
        actual_ids.append(_require_text(item["rubric_id"], f"quality rubric_assessments[{index}].rubric_id", 100))
        if item["verdict"] not in QUALITY_VERDICTS:
            raise PipelineError(f"quality rubric_assessments[{index}] verdict is invalid")
        _require_text(item["summary"], f"quality rubric_assessments[{index}].summary", 360)
        _require_string_list(item["issues"], f"quality rubric_assessments[{index}].issues", 3, 360)
        support = _require_string_list(
            item["request_support"],
            f"quality rubric_assessments[{index}].request_support",
            3,
            360,
        )
        introduced = _require_string_list(
            item["introduced_requirements"],
            f"quality rubric_assessments[{index}].introduced_requirements",
            3,
            360,
        )
        for excerpt in support:
            if _alignment_text(excerpt) not in _alignment_text(task.prompt):
                raise PipelineError(
                    f"quality rubric_assessments[{index}] request_support must quote the task request exactly"
                )
        rubric = next((rubric for rubric in task.rubrics if rubric.rubric_id == item["rubric_id"]), None)
        unrequested = unrequested_named_requirements(task, rubric) if rubric else ()
        if item["verdict"] == "PASS":
            if not support:
                raise PipelineError(
                    f"quality rubric_assessments[{index}] PASS requires exact request_support"
                )
            if introduced:
                raise PipelineError(
                    f"quality rubric_assessments[{index}] cannot pass introduced requirements"
                )
            if unrequested:
                raise PipelineError(
                    f"quality rubric_assessments[{index}] cannot pass unrequested named requirement: {', '.join(unrequested)}"
                )
        if introduced and item["verdict"] != "FAIL":
            raise PipelineError(
                f"quality rubric_assessments[{index}] introduced requirements require FAIL"
            )
    expected_ids = [rubric.rubric_id for rubric in task.rubrics]
    if len(actual_ids) != len(set(actual_ids)) or set(actual_ids) != set(expected_ids):
        raise PipelineError("quality review must assess every rubric exactly once")
    component_verdicts = [coherence["verdict"]] + [item["verdict"] for item in assessments]
    expected_overall = (
        "FAIL" if "FAIL" in component_verdicts
        else "NEEDS_HUMAN_REVIEW" if "NEEDS_HUMAN_REVIEW" in component_verdicts
        else "PASS"
    )
    if review["overall_verdict"] != expected_overall:
        raise PipelineError("quality review overall_verdict does not match its component judgments")
    return review


def validate_feasibility_manager(value: Any, task: Task) -> dict[str, Any]:
    review = _require_object(value, "feasibility manager review")
    _require_exact_keys(review, FEASIBILITY_MANAGER_KEYS, "feasibility manager review")
    if review["schema_version"] != FEASIBILITY_MANAGER_SCHEMA_VERSION:
        raise PipelineError("feasibility manager review has the wrong schema_version")
    if review["task_id"] != task.task_id:
        raise PipelineError("feasibility manager task_id does not match its assignment")
    if review["disposition"] not in {"FEASIBLE", "NOT_FEASIBLE", "NEEDS_HUMAN_REVIEW"}:
        raise PipelineError("manager review disposition is invalid")
    confidence = review["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise PipelineError("manager review confidence must be between 0 and 1")
    _require_utc(review["reviewed_at_utc"], "manager review reviewed_at_utc")
    _require_text(review["summary"], "manager review summary", 360)
    assessments = review["rubric_assessments"]
    if not isinstance(assessments, list) or not assessments:
        raise PipelineError("manager review must contain rubric_assessments")
    actual_ids: list[str] = []
    for index, raw_item in enumerate(assessments):
        item = _require_object(raw_item, f"rubric_assessments[{index}]")
        _require_exact_keys(item, ASSESSMENT_KEYS, f"rubric_assessments[{index}]")
        actual_ids.append(_require_text(item["rubric_id"], f"rubric_assessments[{index}].rubric_id", 100))
        if item["accepted_worker_verdict"] not in {"POSSIBLE", "SHORTFALL", "IMPOSSIBLE", "WORKER_ERROR"}:
            raise PipelineError(f"rubric_assessments[{index}].accepted_worker_verdict is invalid")
        _require_text(item["manager_note"], f"rubric_assessments[{index}].manager_note", 360)
    expected_ids = [rubric.rubric_id for rubric in task.rubrics]
    if len(actual_ids) != len(set(actual_ids)) or set(actual_ids) != set(expected_ids):
        raise PipelineError("manager review must assess every rubric exactly once")
    _require_string_list(review["cross_rubric_conflicts"], "cross_rubric_conflicts", 3, 360)
    _require_string_list(review["task_level_risks"], "task_level_risks", 3, 360)
    feedback = review["task_feedback"]
    if feedback is not None:
        _require_text(feedback, "task_feedback", 360)
    return review


def validate_evergreen_review(value: Any, task: Task) -> dict[str, Any]:
    review = _require_object(value, "evergreen review")
    _require_exact_keys(review, EVERGREEN_REVIEW_KEYS, "evergreen review")
    if review["schema_version"] != EVERGREEN_SCHEMA_VERSION:
        raise PipelineError("evergreen review has the wrong schema_version")
    if review["task_id"] != task.task_id:
        raise PipelineError("evergreen review task_id does not match its assignment")
    if review["verdict"] not in {"NOT_ASSESSED", "EVERGREEN", "NOT_EVERGREEN", "NEEDS_HUMAN_REVIEW"}:
        raise PipelineError("evergreen review verdict is invalid")
    confidence = review["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise PipelineError("evergreen review confidence must be between 0 and 1")
    _require_utc(review["reviewed_at_utc"], "evergreen review reviewed_at_utc")
    _require_text(review["summary"], "evergreen review summary", 5000)
    _require_string_list(review["concerns"], "evergreen review concerns", 30, 2000)
    return review


def validate_manager_review(value: Any, task: Task) -> dict[str, Any]:
    review = _require_object(value, "manager review")
    _require_exact_keys(review, MANAGER_KEYS, "manager review")
    if review["schema_version"] != MANAGER_SCHEMA_VERSION:
        raise PipelineError("manager review has the wrong schema_version")
    core = {key: review[key] for key in FEASIBILITY_MANAGER_KEYS}
    core["schema_version"] = FEASIBILITY_MANAGER_SCHEMA_VERSION
    validate_feasibility_manager(core, task)
    evergreen = _require_object(review["evergreen_review"], "evergreen_review")
    _require_exact_keys(evergreen, EVERGREEN_KEYS, "evergreen_review")
    standalone = {
        "schema_version": EVERGREEN_SCHEMA_VERSION,
        "task_id": task.task_id,
        "verdict": evergreen.get("verdict"),
        "confidence": 1,
        "reviewed_at_utc": review["reviewed_at_utc"],
        "summary": evergreen.get("summary"),
        "concerns": evergreen.get("concerns"),
    }
    validate_evergreen_review(standalone, task)
    validate_quality_review(review["quality_review"], task)
    return review


def _search_review_supports_public_path(review: Mapping[str, Any]) -> bool:
    request = review.get("browser_verification")
    if not isinstance(request, Mapping) or request.get("limitation_only") is not True:
        return False
    evidence = review.get("evidence")
    if not isinstance(evidence, list):
        return False
    return any(
        isinstance(item, Mapping)
        and item.get("access_status") == "OK"
        and item.get("fact_or_inference") == "FACT"
        and item.get("authority_role") in {"VERIFICATION", "CORROBORATION"}
        for item in evidence
    )


def effective_rubric_verdict(outcome: Mapping[str, Any]) -> str:
    if outcome.get("status") == "ERROR":
        return "WORKER_ERROR"
    base = _require_object(outcome.get("review"), "completed rubric review")
    browser_outcome = _require_object(outcome.get("browser_review"), "browser review outcome")
    if browser_outcome.get("status") == "COMPLETED":
        browser = _require_object(browser_outcome.get("review"), "completed browser review")
        if (
            base.get("verdict") == "SHORTFALL"
            and browser.get("verdict") == "SHORTFALL"
            and browser.get("limitation_kind") == "CHECKER_TOOL"
            and browser.get("task_blocker") is False
            and _search_review_supports_public_path(base)
        ):
            return "POSSIBLE"
        return str(browser.get("verdict"))
    if (
        browser_outcome.get("status") == "ERROR"
        and base.get("verdict") == "SHORTFALL"
        and _search_review_supports_public_path(base)
    ):
        return "POSSIBLE"
    return str(base.get("verdict"))


def deterministic_status(outcomes: Sequence[dict[str, Any]], manager: Mapping[str, Any]) -> str:
    if any(item["status"] == "ERROR" for item in outcomes):
        return "PIPELINE_ERROR"
    verdicts = [effective_rubric_verdict(item) for item in outcomes]
    if "IMPOSSIBLE" in verdicts:
        return "LLM_FAIL" if manager.get("disposition") == "NOT_FEASIBLE" else "NEEDS_HUMAN_REVIEW"
    if "SHORTFALL" in verdicts:
        return "NEEDS_HUMAN_REVIEW"
    quality = manager["quality_review"]["overall_verdict"]
    if quality == "FAIL":
        return "LLM_FAIL"
    if quality == "NEEDS_HUMAN_REVIEW":
        return "NEEDS_HUMAN_REVIEW"
    disposition = manager["disposition"]
    if disposition == "FEASIBLE":
        return "LLM_PASS"
    if disposition == "NOT_FEASIBLE":
        return "LLM_FAIL"
    return "NEEDS_HUMAN_REVIEW" if disposition == "NEEDS_HUMAN_REVIEW" else "PIPELINE_ERROR"


EDIT_OPERATION_KEYS = {"operation", "old_text", "new_text"}
REPAIR_URL_KEYS = {"url", "title", "supports"}
RUBRIC_REPAIR_KEYS = {
    "schema_version",
    "task_id",
    "rubric_id",
    "effective_verdict",
    "quality_verdict",
    "repair_kind",
    "confidence",
    "reason",
    "edit_operations",
    "verified_replacement_urls",
    "human_input_needed",
    "preserves_intent",
}
TASK_REPAIR_MANAGER_KEYS = {
    "schema_version",
    "task_id",
    "summary",
    "task_prompt_edit_operations",
    "unresolved_rubric_ids",
    "cross_rubric_notes",
    "preserves_task_flow",
}
REPAIR_VERIFICATION_KEYS = {
    "schema_version",
    "task_id",
    "rubric_id",
    "verdict",
    "quality_verdict",
    "quality_summary",
    "confidence",
    "tested_at_utc",
    "summary",
    "evidence",
    "blockers",
}
REPAIR_VERIFICATION_EVIDENCE_KEYS = {"url", "title", "observed_at_utc", "supports"}
REPAIR_KINDS = {
    "NONE",
    "REPLACE_SOURCE",
    "ADD_MISSING_CONTEXT",
    "CLARIFY_REQUIREMENT",
    "REMOVE_UNVERIFIABLE_CLAUSE",
    "REPLACE_PROHIBITED_ACTION",
    "RETRY_VERIFICATION",
    "HUMAN_INPUT_REQUIRED",
    "HUMAN_REVIEW_REQUIRED",
}
NON_EDIT_REPAIR_KINDS = {
    "NONE",
    "RETRY_VERIFICATION",
    "HUMAN_INPUT_REQUIRED",
    "HUMAN_REVIEW_REQUIRED",
}


def validate_edit_operations(value: Any, where: str, original: str) -> tuple[list[dict[str, Any]], str | None]:
    if not isinstance(value, list) or len(value) > 3:
        raise PipelineError(f"{where} must be an array of at most 3 exact edit operations")
    operations: list[dict[str, Any]] = []
    result = original
    for index, raw_operation in enumerate(value):
        operation = _require_object(raw_operation, f"{where}[{index}]")
        _require_exact_keys(operation, EDIT_OPERATION_KEYS, f"{where}[{index}]")
        operation_type = operation["operation"]
        if operation_type not in {"REPLACE", "DELETE", "APPEND"}:
            raise PipelineError(f"{where}[{index}].operation is invalid")
        old_text = operation["old_text"]
        new_text = _require_text(operation["new_text"], f"{where}[{index}].new_text", 8000, allow_empty=True)
        if operation_type == "APPEND":
            if old_text is not None or not new_text:
                raise PipelineError(f"{where}[{index}] APPEND requires null old_text and non-empty new_text")
            result += new_text
        else:
            old = _require_text(old_text, f"{where}[{index}].old_text", 8000)
            expected_new = "" if operation_type == "DELETE" else new_text
            if operation_type == "DELETE" and new_text:
                raise PipelineError(f"{where}[{index}] DELETE requires empty new_text")
            if operation_type == "REPLACE" and not new_text:
                raise PipelineError(f"{where}[{index}] REPLACE requires non-empty new_text")
            if result.count(old) != 1:
                raise PipelineError(f"{where}[{index}].old_text must occur exactly once at that edit step")
            result = result.replace(old, expected_new, 1)
        operations.append(dict(operation))
    if operations:
        if result == original:
            raise PipelineError(f"{where} cannot be a no-op")
        ratio = difflib.SequenceMatcher(None, original, result).ratio()
        changed_budget = max(400, int(len(original) * 0.45))
        changed_size = sum(
            max(i2 - i1, j2 - j1)
            for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, original, result).get_opcodes()
            if tag != "equal"
        )
        if ratio < 0.55 or changed_size > changed_budget:
            raise PipelineError(f"{where} exceeds the minimal-repair budget")
    return operations, result if operations else None


def validate_rubric_repair(
    value: Any,
    task: Task,
    rubric: Rubric,
    effective_verdict: str,
    quality_verdict: str = "PASS",
) -> dict[str, Any]:
    repair = _require_object(value, "rubric repair")
    _require_exact_keys(repair, RUBRIC_REPAIR_KEYS, "rubric repair")
    if repair["schema_version"] != RUBRIC_REPAIR_SCHEMA_VERSION:
        raise PipelineError("rubric repair has the wrong schema_version")
    if repair["task_id"] != task.task_id or repair["rubric_id"] != rubric.rubric_id:
        raise PipelineError("rubric repair task_id or rubric_id does not match its assignment")
    if repair["effective_verdict"] != effective_verdict:
        raise PipelineError("rubric repair must preserve the validated effective verdict")
    if quality_verdict not in QUALITY_VERDICTS or repair["quality_verdict"] != quality_verdict:
        raise PipelineError("rubric repair must preserve the validated quality verdict")
    kind = repair["repair_kind"]
    if kind not in REPAIR_KINDS:
        raise PipelineError("rubric repair kind is invalid")
    confidence = repair["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise PipelineError("rubric repair confidence must be between 0 and 1")
    _require_text(repair["reason"], "rubric repair reason", 5000)
    operations, suggested = validate_edit_operations(
        repair["edit_operations"], "rubric repair edit_operations", rubric.criterion
    )
    if kind in NON_EDIT_REPAIR_KINDS and operations:
        raise PipelineError(f"{kind} cannot contain edit operations")
    if kind not in NON_EDIT_REPAIR_KINDS and not operations:
        raise PipelineError(f"{kind} requires at least one exact edit operation")
    urls = repair["verified_replacement_urls"]
    if not isinstance(urls, list) or len(urls) > 10:
        raise PipelineError("verified_replacement_urls must be an array of at most 10 items")
    for index, raw_item in enumerate(urls):
        item = _require_object(raw_item, f"verified_replacement_urls[{index}]")
        _require_exact_keys(item, REPAIR_URL_KEYS, f"verified_replacement_urls[{index}]")
        url = _require_text(item["url"], f"verified_replacement_urls[{index}].url", 4000)
        if not url.startswith(("https://", "http://")):
            raise PipelineError("verified replacement URLs must use http or https")
        _require_text(item["title"], f"verified_replacement_urls[{index}].title", 500)
        _require_text(item["supports"], f"verified_replacement_urls[{index}].supports", 3000)
    if kind == "REPLACE_SOURCE" and not urls:
        raise PipelineError("REPLACE_SOURCE requires at least one verified replacement URL")
    if kind == "REPLACE_SOURCE" and suggested is not None and not any(
        item["url"] in suggested for item in urls
    ):
        raise PipelineError("REPLACE_SOURCE suggested text must contain a verified replacement URL")
    human_input = repair["human_input_needed"]
    if human_input is not None:
        _require_text(human_input, "rubric repair human_input_needed", 3000)
    if kind == "HUMAN_INPUT_REQUIRED" and human_input is None:
        raise PipelineError("HUMAN_INPUT_REQUIRED must state the missing input")
    if kind != "HUMAN_INPUT_REQUIRED" and human_input is not None:
        raise PipelineError("human_input_needed is allowed only for HUMAN_INPUT_REQUIRED")
    if not isinstance(repair["preserves_intent"], bool):
        raise PipelineError("rubric repair preserves_intent must be a boolean")
    if operations and repair["preserves_intent"] is not True:
        raise PipelineError("an editable repair must explicitly preserve intent")
    return {**repair, "suggested_rubric_text": suggested}


def normalize_rubric_repair_output(value: Any, task_id: str, rubric_id: str) -> Any:
    """Bind routing IDs and resolve an unsafe edit-plus-human-input conflict to no-edit feedback."""
    if not isinstance(value, dict):
        return value
    normalized = {**value, "task_id": task_id, "rubric_id": rubric_id}
    if normalized.get("human_input_needed") is not None and normalized.get("repair_kind") != "HUMAN_INPUT_REQUIRED":
        normalized = {
            **normalized,
            "repair_kind": "HUMAN_INPUT_REQUIRED",
            "edit_operations": [],
            "verified_replacement_urls": [],
            "preserves_intent": True,
        }
    return normalized


def validate_rubric_repair_verification(
    value: Any,
    task_id: str,
    rubric_id: str,
) -> dict[str, Any]:
    review = _require_object(value, "rubric repair verification")
    _require_exact_keys(review, REPAIR_VERIFICATION_KEYS, "rubric repair verification")
    if review["schema_version"] != RUBRIC_REPAIR_VERIFICATION_SCHEMA_VERSION:
        raise PipelineError("rubric repair verification has the wrong schema_version")
    if review["task_id"] != task_id or review["rubric_id"] != rubric_id:
        raise PipelineError("rubric repair verification task_id or rubric_id is invalid")
    if review["verdict"] not in {"POSSIBLE", "SHORTFALL", "IMPOSSIBLE"}:
        raise PipelineError("rubric repair verification verdict is invalid")
    if review["quality_verdict"] not in QUALITY_VERDICTS:
        raise PipelineError("rubric repair verification quality_verdict is invalid")
    _require_text(review["quality_summary"], "rubric repair verification quality_summary", 3000)
    confidence = review["confidence"]
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        raise PipelineError("rubric repair verification confidence must be between 0 and 1")
    _require_utc(review["tested_at_utc"], "rubric repair verification tested_at_utc")
    _require_text(review["summary"], "rubric repair verification summary", 5000)
    evidence = review["evidence"]
    if not isinstance(evidence, list) or len(evidence) > 20:
        raise PipelineError("rubric repair verification evidence must be an array of at most 20 items")
    if review["verdict"] == "POSSIBLE" and not evidence:
        raise PipelineError("a POSSIBLE repair verification must include direct live-web evidence")
    for index, raw_item in enumerate(evidence):
        item = _require_object(raw_item, f"repair verification evidence[{index}]")
        _require_exact_keys(item, REPAIR_VERIFICATION_EVIDENCE_KEYS, f"repair verification evidence[{index}]")
        url = _require_text(item["url"], f"repair verification evidence[{index}].url", 4000)
        if not url.startswith(("https://", "http://")):
            raise PipelineError("repair verification evidence URLs must use http or https")
        _require_text(item["title"], f"repair verification evidence[{index}].title", 500)
        _require_utc(item["observed_at_utc"], f"repair verification evidence[{index}].observed_at_utc")
        _require_text(item["supports"], f"repair verification evidence[{index}].supports", 3000)
    _require_string_list(review["blockers"], "repair verification blockers", 20, 1000)
    return review


def validate_repair_verification_outcome(
    value: Any,
    task_id: str,
    rubric_id: str,
) -> dict[str, Any]:
    outcome = _require_object(value, "repair verification outcome")
    _require_exact_keys(outcome, {"status", "review", "error"}, "repair verification outcome")
    status = outcome["status"]
    if status == "COMPLETED":
        if outcome["error"] is not None:
            raise PipelineError("completed repair verification cannot contain an error")
        validate_rubric_repair_verification(outcome["review"], task_id, rubric_id)
    elif status == "ERROR":
        if outcome["review"] is not None:
            raise PipelineError("errored repair verification cannot contain a review")
        _require_text(outcome["error"], "repair verification error", 8000)
    elif status in {"NOT_REQUIRED", "NOT_RUN"}:
        if outcome["review"] is not None or outcome["error"] is not None:
            raise PipelineError("unrun repair verification cannot contain review data or an error")
    else:
        raise PipelineError("repair verification outcome status is invalid")
    return outcome


def validate_task_repair_manager(value: Any, task: Task) -> dict[str, Any]:
    review = _require_object(value, "task repair manager")
    _require_exact_keys(review, TASK_REPAIR_MANAGER_KEYS, "task repair manager")
    if review["schema_version"] != TASK_REPAIR_MANAGER_SCHEMA_VERSION or review["task_id"] != task.task_id:
        raise PipelineError("task repair manager schema or task_id is invalid")
    _require_text(review["summary"], "task repair manager summary", 5000)
    operations, suggested = validate_edit_operations(
        review["task_prompt_edit_operations"], "task repair manager task_prompt_edit_operations", task.prompt
    )
    unresolved = _require_string_list(review["unresolved_rubric_ids"], "unresolved_rubric_ids", 100, 100)
    valid_ids = {rubric.rubric_id for rubric in task.rubrics}
    if len(unresolved) != len(set(unresolved)) or not set(unresolved).issubset(valid_ids):
        raise PipelineError("task repair manager unresolved_rubric_ids are invalid")
    _require_string_list(review["cross_rubric_notes"], "cross_rubric_notes", 30, 2000)
    if not isinstance(review["preserves_task_flow"], bool):
        raise PipelineError("task repair manager preserves_task_flow must be a boolean")
    if operations and review["preserves_task_flow"] is not True:
        raise PipelineError("task prompt edits must explicitly preserve task flow")
    return {**review, "suggested_task_prompt": suggested}


def validate_repair_plan(
    value: Any,
    task: Task,
    outcomes: Sequence[Mapping[str, Any]],
    manager: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    plan = _require_object(value, "repair plan")
    required = {
        "schema_version", "task_id", "created_at_utc", "applied_automatically", "source_changed",
        "summary", "suggested_task_prompt", "task_prompt_edit_operations", "rubric_repairs",
        "unresolved_rubric_ids", "cross_rubric_notes", "preserves_task_flow",
        "all_suggested_changes_verified", "all_rubrics_projected_possible", "projected_task_status",
        "projected_evergreen_review", "projected_feasibility_review",
        "projected_quality_review",
    }
    _require_exact_keys(plan, required, "repair plan")
    if plan["schema_version"] != REPAIR_PLAN_SCHEMA_VERSION or plan["task_id"] != task.task_id:
        raise PipelineError("repair plan schema or task_id is invalid")
    _require_utc(plan["created_at_utc"], "repair plan created_at_utc")
    if plan["applied_automatically"] is not False or plan["source_changed"] is not False:
        raise PipelineError("repair plans must be advisory and cannot report a source mutation")
    manager_shape = {
        "schema_version": TASK_REPAIR_MANAGER_SCHEMA_VERSION,
        "task_id": task.task_id,
        "summary": plan["summary"],
        "task_prompt_edit_operations": plan["task_prompt_edit_operations"],
        "unresolved_rubric_ids": plan["unresolved_rubric_ids"],
        "cross_rubric_notes": plan["cross_rubric_notes"],
        "preserves_task_flow": plan["preserves_task_flow"],
    }
    manager = validate_task_repair_manager(manager_shape, task)
    if plan["suggested_task_prompt"] != manager["suggested_task_prompt"]:
        raise PipelineError("repair plan suggested_task_prompt is not derived from exact edit operations")
    repairs = plan["rubric_repairs"]
    if not isinstance(repairs, list) or len(repairs) != len(task.rubrics):
        raise PipelineError("repair plan must contain one repair result per rubric")
    outcome_by_id = {str(item["rubric_id"]): item for item in outcomes}
    quality_by_id = {
        str(item["rubric_id"]): str(item["verdict"])
        for item in (
            manager.get("quality_review", {}).get("rubric_assessments", [])
            if isinstance(manager, Mapping)
            else []
        )
    }
    actual_ids = []
    for index, (rubric, raw_repair) in enumerate(zip(task.rubrics, repairs)):
        repair = dict(_require_object(raw_repair, f"rubric_repairs[{index}]") )
        suggested = repair.pop("suggested_rubric_text", None)
        verification = repair.pop("verification", None)
        verified_possible = repair.pop("verified_possible", None)
        verdict = str(outcome_by_id[rubric.rubric_id]["effective_verdict"])
        quality_verdict = quality_by_id.get(rubric.rubric_id, str(repair.get("quality_verdict")))
        validated = validate_rubric_repair(repair, task, rubric, verdict, quality_verdict)
        if suggested != validated["suggested_rubric_text"]:
            raise PipelineError("suggested_rubric_text is not derived from exact edit operations")
        if verdict == "POSSIBLE" and quality_verdict == "PASS" and repair["repair_kind"] != "NONE":
            raise PipelineError("a feasible, quality-passing rubric must have a NONE repair")
        validate_repair_verification_outcome(verification, task.task_id, rubric.rubric_id)
        if not isinstance(verified_possible, bool):
            raise PipelineError("repair verified_possible must be a boolean")
        verification_verdict = (
            verification["review"]["verdict"] if verification["status"] == "COMPLETED" else None
        )
        if suggested is not None and not (
            verified_possible and verification["status"] == "COMPLETED" and verification_verdict == "POSSIBLE"
        ):
            raise PipelineError("exposed suggested rubric text must be independently verified POSSIBLE")
        if suggested is None and (verdict != "POSSIBLE" or quality_verdict != "PASS") and verified_possible:
            raise PipelineError("an unresolved original rubric cannot be projected possible without a verified suggestion")
        if verdict == "POSSIBLE" and quality_verdict == "PASS" and not verified_possible:
            raise PipelineError("an originally possible, quality-passing rubric must remain projected possible")
        actual_ids.append(repair["rubric_id"])
    if actual_ids != [rubric.rubric_id for rubric in task.rubrics]:
        raise PipelineError("repair plan rubric order must match the source")
    required_unresolved = {repair["rubric_id"] for repair in repairs if not repair["verified_possible"]}
    if required_unresolved != set(plan["unresolved_rubric_ids"]):
        raise PipelineError("repair plan unresolved_rubric_ids must exactly match projected feasibility")
    all_projected = not required_unresolved
    if plan["all_suggested_changes_verified"] is not True:
        raise PipelineError("repair plan may expose only independently verified suggested changes")
    if plan["all_rubrics_projected_possible"] is not all_projected:
        raise PipelineError("repair plan all_rubrics_projected_possible is inconsistent")
    projected_evergreen = _require_object(plan["projected_evergreen_review"], "projected evergreen review")
    _require_exact_keys(
        projected_evergreen,
        {"status", "verdict", "confidence", "reviewed_at_utc", "summary", "concerns", "error"},
        "projected evergreen review",
    )
    if projected_evergreen["status"] not in {"NOT_REQUIRED", "COMPLETED"}:
        raise PipelineError("projected evergreen review status is invalid")
    if projected_evergreen["verdict"] not in {"NOT_ASSESSED", "EVERGREEN", "NOT_EVERGREEN", "NEEDS_HUMAN_REVIEW"}:
        raise PipelineError("projected evergreen review verdict is invalid")
    if projected_evergreen["confidence"] is not None:
        confidence = projected_evergreen["confidence"]
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise PipelineError("projected evergreen confidence must be between 0 and 1")
    if projected_evergreen["reviewed_at_utc"] is not None:
        _require_utc(projected_evergreen["reviewed_at_utc"], "projected evergreen reviewed_at_utc")
    _require_text(projected_evergreen["summary"], "projected evergreen summary", 5000)
    _require_string_list(projected_evergreen["concerns"], "projected evergreen concerns", 30, 2000)
    if projected_evergreen["error"] is not None:
        raise PipelineError("completed projected evergreen review cannot contain an error")
    projected_feasibility = _require_object(
        plan["projected_feasibility_review"], "projected feasibility review"
    )
    _require_exact_keys(
        projected_feasibility,
        {
            "status", "disposition", "confidence", "reviewed_at_utc", "summary",
            "cross_rubric_conflicts", "task_level_risks", "error",
        },
        "projected feasibility review",
    )
    if projected_feasibility["status"] not in {"NOT_RUN", "NOT_REQUIRED", "COMPLETED"}:
        raise PipelineError("projected feasibility review status is invalid")
    disposition = projected_feasibility["disposition"]
    if disposition is not None and disposition not in {"FEASIBLE", "NOT_FEASIBLE", "NEEDS_HUMAN_REVIEW"}:
        raise PipelineError("projected feasibility disposition is invalid")
    if projected_feasibility["status"] == "NOT_RUN":
        if disposition is not None:
            raise PipelineError("an unrun projected feasibility review cannot have a disposition")
    elif disposition is None:
        raise PipelineError("a completed projected feasibility review must have a disposition")
    if projected_feasibility["confidence"] is not None:
        confidence = projected_feasibility["confidence"]
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise PipelineError("projected feasibility confidence must be between 0 and 1")
    if projected_feasibility["reviewed_at_utc"] is not None:
        _require_utc(projected_feasibility["reviewed_at_utc"], "projected feasibility reviewed_at_utc")
    _require_text(projected_feasibility["summary"], "projected feasibility summary", 5000)
    _require_string_list(
        projected_feasibility["cross_rubric_conflicts"], "projected cross_rubric_conflicts", 30, 2000
    )
    _require_string_list(
        projected_feasibility["task_level_risks"], "projected task_level_risks", 30, 2000
    )
    if projected_feasibility["error"] is not None:
        raise PipelineError("projected feasibility review cannot contain an error")
    projected_quality = _require_object(plan["projected_quality_review"], "projected quality review")
    _require_exact_keys(projected_quality, {"status", "review", "error"}, "projected quality review")
    if projected_quality["status"] not in {"NOT_REQUIRED", "COMPLETED"}:
        raise PipelineError("projected quality review status is invalid")
    if projected_quality["error"] is not None:
        raise PipelineError("projected quality review cannot contain an error")
    projected_prompt = str(plan["suggested_task_prompt"] or task.prompt)
    projected_task = Task(
        task_id=task.task_id,
        prompt=projected_prompt,
        rubrics=tuple(
            Rubric(
                rubric.rubric_id,
                str(repair.get("suggested_rubric_text") or rubric.criterion),
                rubric.critical,
            )
            for rubric, repair in zip(task.rubrics, repairs)
        ),
        effective_task={"request": projected_prompt},
    )
    validated_quality = validate_quality_review(projected_quality["review"], projected_task)
    overall_possible = (
        all_projected
        and disposition == "FEASIBLE"
        and validated_quality["overall_verdict"] == "PASS"
    )
    expected_projected_status = "POSSIBLE" if overall_possible else "UNRESOLVED"
    if plan["projected_task_status"] != expected_projected_status:
        raise PipelineError("repair plan projected_task_status is inconsistent")
    if plan["suggested_task_prompt"] is not None and not overall_possible:
        raise PipelineError("a whole-task suggestion requires every rubric and the combined task to project POSSIBLE")
    if plan["suggested_task_prompt"] is None and plan["task_prompt_edit_operations"]:
        raise PipelineError("suppressed whole-task suggestions cannot expose edit operations")
    return plan


def validate_final_artifact(value: Any, task: Task) -> dict[str, Any]:
    artifact = _require_object(value, "final artifact")
    required = {
        "schema_version",
        "pipeline_version",
        "task_id",
        "task_content_hash",
        "created_at_utc",
        "source",
        "rubric_reviews",
        "manager_review",
        "feedback",
        "repair_plan",
        "status",
        "passed",
    }
    _require_exact_keys(artifact, required, "final artifact")
    if artifact["schema_version"] != ARTIFACT_SCHEMA_VERSION or artifact["pipeline_version"] != PIPELINE_VERSION:
        raise PipelineError("final artifact schema or pipeline version is invalid")
    if artifact["task_id"] != task.task_id or artifact["task_content_hash"] != task.task_content_hash:
        raise PipelineError("final artifact identity does not match its source")
    _require_utc(artifact["created_at_utc"], "final artifact created_at_utc")
    if artifact["source"] != task.source_dict():
        raise PipelineError("final artifact source does not exactly match the normalized task")
    outcomes = artifact["rubric_reviews"]
    if not isinstance(outcomes, list) or len(outcomes) != len(task.rubrics):
        raise PipelineError("final artifact must include one outcome per rubric")
    actual_ids: list[str] = []
    for index, raw_outcome in enumerate(outcomes):
        outcome = _require_object(raw_outcome, f"rubric_reviews[{index}]")
        _require_exact_keys(
            outcome,
            {"rubric_id", "status", "review", "browser_review", "effective_verdict", "error"},
            f"rubric_reviews[{index}]",
        )
        rubric_id = _require_text(outcome["rubric_id"], f"rubric_reviews[{index}].rubric_id", 100)
        actual_ids.append(rubric_id)
        if outcome["status"] == "COMPLETED":
            if outcome["error"] is not None:
                raise PipelineError("a completed rubric outcome cannot contain an error")
            validate_rubric_review(outcome["review"], task.task_id, rubric_id)
        elif outcome["status"] == "ERROR":
            if outcome["review"] is not None:
                raise PipelineError("an errored rubric outcome cannot contain a review")
            _require_text(outcome["error"], f"rubric_reviews[{index}].error", 8000)
        else:
            raise PipelineError(f"rubric_reviews[{index}].status is invalid")
        browser_outcome = _require_object(outcome["browser_review"], f"rubric_reviews[{index}].browser_review")
        _require_exact_keys(
            browser_outcome,
            {"status", "review", "error"},
            f"rubric_reviews[{index}].browser_review",
        )
        browser_status = browser_outcome["status"]
        if browser_status == "COMPLETED":
            if outcome["status"] != "COMPLETED" or browser_outcome["error"] is not None:
                raise PipelineError("a completed browser review requires a completed base review and no error")
            validate_browser_review(browser_outcome["review"], task.task_id, rubric_id)
        elif browser_status == "ERROR":
            if browser_outcome["review"] is not None:
                raise PipelineError("an errored browser review cannot contain a review")
            _require_text(browser_outcome["error"], f"rubric_reviews[{index}].browser_review.error", 8000)
        elif browser_status == "NOT_RUN":
            if browser_outcome["review"] is not None or browser_outcome["error"] is not None:
                raise PipelineError("an unrun browser review cannot contain review data or an error")
        else:
            raise PipelineError(f"rubric_reviews[{index}].browser_review.status is invalid")
        expected_verdict = effective_rubric_verdict(outcome)
        if outcome["effective_verdict"] != expected_verdict:
            raise PipelineError(f"rubric_reviews[{index}].effective_verdict is inconsistent")
    if set(actual_ids) != {r.rubric_id for r in task.rubrics} or len(actual_ids) != len(set(actual_ids)):
        raise PipelineError("final artifact rubric outcomes do not match the source rubrics")
    manager = validate_manager_review(artifact["manager_review"], task)
    _validate_manager_worker_alignment(manager, outcomes)
    expected_feedback = {
        "task": manager["task_feedback"],
        "rubrics": [
            {
                "rubric_id": outcome["rubric_id"],
                "feedback": (
                    outcome["browser_review"]["review"]["rubric_feedback"]
                    if outcome["browser_review"]["status"] == "COMPLETED"
                    and outcome["browser_review"]["review"]["rubric_feedback"] is not None
                    else outcome["review"]["rubric_feedback"] if outcome["status"] == "COMPLETED" else None
                ),
            }
            for outcome in outcomes
        ],
    }
    if artifact["feedback"] != expected_feedback:
        raise PipelineError("final artifact feedback must exactly mirror the read-only review feedback")
    validate_repair_plan(artifact["repair_plan"], task, outcomes, manager)
    expected_status = deterministic_status(outcomes, manager)
    if artifact["status"] != expected_status or artifact["passed"] is not (expected_status == "LLM_PASS"):
        raise PipelineError("final artifact status does not satisfy the deterministic gate")
    return artifact


def _find_task_payload(row: Mapping[str, Any]) -> Mapping[str, Any]:
    # A prior immutable review artifact is also a valid read-only rerun source.
    # Preserve its authoritative hash and copied authored snapshot; none of the
    # earlier review output is allowed to become task content.
    artifact_source = row.get("source")
    if (
        str(row.get("schema_version") or "").startswith("apollo-llm-feasibility-artifact-")
        and isinstance(artifact_source, dict)
        and isinstance(artifact_source.get("effective_task"), dict)
    ):
        return {
            "task_id": row.get("task_id"),
            "task_content_hash": row.get("task_content_hash"),
            "task": artifact_source["effective_task"],
            "rubrics": artifact_source.get("rubrics"),
        }
    candidate: Any = row
    for key in ("final_gold", "content", "reviewed_task"):
        nested = row.get(key)
        if isinstance(nested, dict):
            candidate = nested
            break
    if isinstance(candidate, dict) and isinstance(candidate.get("final_gold"), dict):
        candidate = candidate["final_gold"]
    return _require_object(candidate, "task record content")


def _normalize_explicit_rubrics(raw: Any) -> list[Rubric]:
    rubrics: list[Rubric] = []
    if isinstance(raw, dict):
        entries: Iterable[tuple[Any, Any]] = raw.items()
    elif isinstance(raw, list):
        entries = enumerate(raw, start=1)
    else:
        return rubrics
    for index_or_key, item in entries:
        default_id = str(index_or_key) if isinstance(index_or_key, str) else f"R{index_or_key}"
        if isinstance(item, str):
            criterion = item.strip()
            rubric_id = default_id
            critical = True
        elif isinstance(item, dict):
            rubric_id = str(item.get("rubric_id") or item.get("id") or default_id).strip()
            criterion = str(
                item.get("criterion")
                or item.get("requirement")
                or item.get("final")
                or item.get("description")
                or item.get("original")
                or ""
            ).strip()
            critical = bool(item.get("critical", True))
        else:
            continue
        if rubric_id and criterion:
            rubrics.append(Rubric(rubric_id=rubric_id, criterion=criterion, critical=critical))
    return rubrics


def normalize_task(row: Mapping[str, Any]) -> Task:
    content = _find_task_payload(row)
    if isinstance(content.get("task"), dict):
        task_obj = content["task"]
    elif isinstance(content.get("final"), dict) and str(content["final"].get("request") or "").strip():
        task_obj = content["final"]
    elif isinstance(content.get("original"), dict):
        task_obj = content["original"]
    else:
        task_obj = content
    task_id = str(content.get("task_id") or row.get("task_id") or "").strip()
    prompt = str(
        task_obj.get("agent_request")
        or task_obj.get("prompt")
        or task_obj.get("request")
        or row.get("prompt")
        or row.get("request")
        or ""
    ).strip()
    if not task_id:
        raise PipelineError("task record is missing task_id")
    if not prompt:
        raise PipelineError(f"task {task_id!r} is missing the full prompt")

    explicit = content.get("rubrics") if content.get("rubrics") is not None else row.get("rubrics")
    rubrics = _normalize_explicit_rubrics(explicit)
    if not rubrics:
        steps = task_obj.get("steps")
        if isinstance(steps, list):
            for index, raw_step in enumerate(steps, start=1):
                if not isinstance(raw_step, dict):
                    continue
                title = str(raw_step.get("title") or f"Step {index}").strip()
                description = str(raw_step.get("description") or "").strip()
                if description:
                    rubrics.append(Rubric(f"R{index}", f"{title}: {description}", True))
    if not rubrics:
        criteria = task_obj.get("success_criteria")
        if isinstance(criteria, list):
            rubrics.extend(
                Rubric(f"R{index}", str(criterion).strip(), True)
                for index, criterion in enumerate(criteria, start=1)
                if str(criterion).strip()
            )
    if not rubrics:
        raise PipelineError(f"task {task_id!r} has no rubrics or authored steps")
    ids = [rubric.rubric_id for rubric in rubrics]
    if len(ids) != len(set(ids)):
        raise PipelineError(f"task {task_id!r} contains duplicate rubric IDs")
    if len(rubrics) > 100:
        raise PipelineError(f"task {task_id!r} has more than 100 rubrics")
    api_hash = str(content.get("task_content_hash") or "").strip()
    return Task(
        task_id=task_id,
        prompt=prompt,
        rubrics=tuple(rubrics),
        effective_task=dict(task_obj),
        task_content_hash=api_hash,
        workflow_status=str(row.get("status") or content.get("status") or "").strip() or None,
    )


def _items_from_payload(payload: Any) -> tuple[list[Mapping[str, Any]], str | None, str | None]:
    if isinstance(payload, list):
        return [_require_object(item, "task item") for item in payload], None, None
    obj = _require_object(payload, "API/input payload")
    raw_items = obj.get("items") if isinstance(obj.get("items"), list) else obj.get("tasks")
    if not isinstance(raw_items, list):
        if "task_id" in obj:
            raw_items = [obj]
        else:
            raise PipelineError("payload must be a task, an array, or an object containing items/tasks")
    next_value = obj.get("next_cursor")
    next_parameter = "cursor" if next_value is not None else None
    if next_value is None and isinstance(obj.get("pagination"), dict):
        next_value = obj["pagination"].get("next_cursor")
        next_parameter = "cursor" if next_value is not None else None
    if next_value is None and isinstance(obj.get("page"), dict):
        next_value = obj["page"].get("next_offset")
        next_parameter = "offset" if next_value is not None else None
    return (
        [_require_object(item, "task item") for item in raw_items],
        str(next_value) if next_value is not None else None,
        next_parameter,
    )


def fetch_api_pages(url: str, token: str, timeout_seconds: int, max_pages: int = 10_000) -> list[Mapping[str, Any]]:
    items: list[Mapping[str, Any]] = []
    next_url = url
    seen_urls: set[str] = set()
    for _ in range(max_pages):
        if next_url in seen_urls:
            raise PipelineError(f"reporting API repeated a pagination URL: {next_url}")
        seen_urls.add(next_url)
        request = urllib.request.Request(
            next_url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            raise PipelineError(f"reporting API returned HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise PipelineError(f"could not read reporting API: {exc}") from exc
        page_items, next_value, next_parameter = _items_from_payload(payload)
        items.extend(page_items)
        if next_value is None or next_parameter is None:
            return items
        parsed = urllib.parse.urlsplit(url)
        query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        query[next_parameter] = next_value
        next_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment))
    raise PipelineError(f"reporting API pagination exceeded {max_pages} pages")


def load_rows(input_path: Path | None, api_url: str | None, token_env: str, timeout_seconds: int) -> list[Mapping[str, Any]]:
    if input_path:
        if input_path.suffix.lower() == ".jsonl":
            rows: list[Mapping[str, Any]] = []
            for line_number, line in enumerate(input_path.read_text(encoding="utf-8").splitlines(), start=1):
                if not line.strip():
                    continue
                try:
                    rows.append(_require_object(json.loads(line), f"{input_path}:{line_number}"))
                except json.JSONDecodeError as exc:
                    raise PipelineError(f"invalid JSONL at {input_path}:{line_number}: {exc}") from exc
            return rows
        items, next_value, _ = _items_from_payload(read_json(input_path))
        if next_value is not None:
            raise PipelineError("local input cannot use API pagination cursors")
        return items
    if not api_url:
        raise PipelineError("one of --input or --api-url is required")
    token = os.environ.get(token_env, "")
    if not token:
        raise PipelineError(f"API credential environment variable {token_env} is empty")
    return fetch_api_pages(api_url, token, timeout_seconds)


def normalize_tasks(
    rows: Sequence[Mapping[str, Any]],
    task_ids: set[str] | None = None,
    include_reviewed: bool = False,
) -> list[Task]:
    tasks: list[Task] = []
    hashes_by_id: dict[str, str] = {}
    for row in rows:
        if not include_reviewed and row.get("llm_review_status") in {
            "passed",
            "needs_attention",
            "pre_qc_passed",
            "pre_qc_attention",
        }:
            continue
        task = normalize_task(row)
        if task_ids and task.task_id not in task_ids:
            continue
        prior_hash = hashes_by_id.get(task.task_id)
        if prior_hash is not None:
            if prior_hash != task.task_content_hash:
                raise PipelineError(f"input contains conflicting records for task_id {task.task_id!r}")
            continue
        hashes_by_id[task.task_id] = task.task_content_hash
        tasks.append(task)
    return sorted(tasks, key=lambda task: task.task_id)


class CodexRunner:
    def __init__(self, config: Config):
        self.config = config

    def _command(
        self,
        schema_path: Path,
        output_path: Path,
        job_dir: Path,
        web_search: bool,
        browser: bool = False,
    ) -> list[str]:
        command = [
            self.config.codex_bin,
            "--ask-for-approval",
            "never",
            "--strict-config",
        ]
        if web_search:
            command.append("--search")
        if self.config.reasoning_effort:
            command.extend([
                "-c",
                f'model_reasoning_effort="{self.config.reasoning_effort}"',
            ])
        if self.config.model_provider:
            command.extend([
                "-c",
                f"model_provider={json.dumps(self.config.model_provider)}",
            ])
            if self.config.model_provider == "amazon-bedrock":
                if self.config.aws_profile:
                    command.extend([
                        "-c",
                        (
                            "model_providers.amazon-bedrock.aws.profile="
                            f"{json.dumps(self.config.aws_profile)}"
                        ),
                    ])
                if self.config.aws_region:
                    command.extend([
                        "-c",
                        (
                            "model_providers.amazon-bedrock.aws.region="
                            f"{json.dumps(self.config.aws_region)}"
                        ),
                    ])
        if browser:
            command.extend([
                "-c",
                'mcp_servers.playwright.command="npx"',
                "-c",
                (
                    "mcp_servers.playwright.args="
                    f'["--yes","@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}",'
                    '"--headless","--isolated","--block-service-workers",'
                    '"--image-responses","omit"]'
                ),
            ])
        command.extend([
            "exec",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--cd",
            str(job_dir),
            "--color",
            "never",
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(output_path),
        ])
        if self.config.model:
            command.extend(["--model", self.config.model])
        command.append("-")
        return command

    def run_json(
        self,
        prompt: str,
        schema_path: Path,
        output_path: Path,
        web_search: bool,
        browser: bool = False,
    ) -> Any:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        job_dir = output_path.parent / f"job-{safe_id(output_path.stem)}"
        job_dir.mkdir(parents=True, exist_ok=True)
        command = self._command(schema_path, output_path, job_dir, web_search, browser=browser)
        worker_env = scrub_worker_environment(os.environ)
        last_error = "Codex did not run"
        for attempt in range(self.config.retries + 1):
            attempt_output = output_path.with_suffix(f".attempt-{attempt + 1}.json")
            command_for_attempt = list(command)
            output_index = command_for_attempt.index("--output-last-message") + 1
            command_for_attempt[output_index] = str(attempt_output)
            retry_prompt = prompt
            if attempt:
                retry_prompt += "\nThe previous response failed strict validation. Return one complete JSON object only.\n"
            try:
                completed = subprocess.run(
                    command_for_attempt,
                    input=retry_prompt,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=self.config.timeout_seconds,
                    check=False,
                    cwd=job_dir,
                    env=worker_env,
                )
            except subprocess.TimeoutExpired:
                last_error = f"Codex timed out after {self.config.timeout_seconds} seconds"
                continue
            except OSError as exc:
                raise PipelineError(f"cannot execute {self.config.codex_bin!r}: {exc}") from exc
            if completed.returncode != 0:
                diagnostic_hash = hashlib.sha256((completed.stdout or "").encode("utf-8")).hexdigest()[:16]
                last_error = f"Codex exited with status {completed.returncode} (diagnostic {diagnostic_hash})"
                continue
            try:
                value = read_json(attempt_output)
            except PipelineError as exc:
                last_error = str(exc)
                continue
            atomic_write_json(output_path, value)
            return value
        raise PipelineError(last_error)


def render_prompt(template_name: str, payload: Mapping[str, Any]) -> str:
    template = (PROMPT_DIR / template_name).read_text(encoding="utf-8")
    marker = "{{PAYLOAD_JSON}}"
    if template.count(marker) != 1:
        raise PipelineError(f"prompt template {template_name} must contain exactly one payload marker")
    assignment = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    return template.replace(marker, f"{HUMAN_REVIEW_COPY_RULES}\n\n{assignment}")


def _browser_not_run() -> dict[str, Any]:
    return {"status": "NOT_RUN", "review": None, "error": None}


def run_browser_review(
    task: Task,
    rubric: Rubric,
    initial_review: Mapping[str, Any],
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    request = _require_object(initial_review.get("browser_verification"), "browser_verification")
    if not runner.config.browser_escalation or not request.get("needed"):
        return _browser_not_run()
    result_path = task_dir / "browser" / f"{safe_id(rubric.rubric_id)}.json"
    if result_path.exists():
        try:
            review = validate_browser_review(read_json(result_path), task.task_id, rubric.rubric_id)
            return {"status": "COMPLETED", "review": review, "error": None}
        except PipelineError:
            result_path.rename(result_path.with_suffix(f".invalid-{int(time.time())}.json"))
    payload = {
        "schema_version": "apollo-browser-assignment-v2",
        "task_id": task.task_id,
        "full_task_prompt": task.prompt,
        "rubric": rubric.as_dict(),
        "initial_live_web_review": initial_review,
        "browser_verification_request": request,
        "review_time_utc": utc_now(),
    }
    prompt = render_prompt("browser_worker.md", payload)
    raw_output_path = task_dir / "attempts" / f"browser-{safe_id(rubric.rubric_id)}.json"
    try:
        value = runner.run_json(
            prompt,
            SCHEMA_DIR / "browser_review.schema.json",
            raw_output_path,
            web_search=False,
            browser=True,
        )
        review = validate_browser_review(
            bind_worker_assignment_ids(value, task.task_id, rubric.rubric_id),
            task.task_id,
            rubric.rubric_id,
        )
        atomic_write_json(result_path, review)
        return {"status": "COMPLETED", "review": review, "error": None}
    except Exception as exc:
        return {"status": "ERROR", "review": None, "error": str(exc)[:8000]}


def review_one_rubric(task: Task, rubric: Rubric, task_dir: Path, runner: CodexRunner) -> dict[str, Any]:
    result_path = task_dir / "rubrics" / f"{safe_id(rubric.rubric_id)}.json"
    review: dict[str, Any] | None = None
    if result_path.exists():
        try:
            review = validate_rubric_review(read_json(result_path), task.task_id, rubric.rubric_id)
        except PipelineError:
            result_path.rename(result_path.with_suffix(f".invalid-{int(time.time())}.json"))
    if review is None:
        payload = {
            "schema_version": "apollo-rubric-assignment-v5",
            "task_id": task.task_id,
            "full_task_prompt": task.prompt,
            "rubric": rubric.as_dict(),
            "review_time_utc": utc_now(),
        }
        prompt = render_prompt("rubric_worker.md", payload)
        raw_output_path = task_dir / "attempts" / f"rubric-{safe_id(rubric.rubric_id)}.json"
        try:
            value = runner.run_json(prompt, SCHEMA_DIR / "rubric_review.schema.json", raw_output_path, web_search=True)
            review = validate_rubric_review(
                normalize_rubric_worker_output(value, task.task_id, rubric.rubric_id),
                task.task_id,
                rubric.rubric_id,
            )
            atomic_write_json(result_path, review)
        except Exception as exc:
            return {
                "rubric_id": rubric.rubric_id,
                "status": "ERROR",
                "review": None,
                "browser_review": _browser_not_run(),
                "effective_verdict": "WORKER_ERROR",
                "error": str(exc)[:8000],
            }
    browser_review = run_browser_review(task, rubric, review, task_dir, runner)
    outcome = {
        "rubric_id": rubric.rubric_id,
        "status": "COMPLETED",
        "review": review,
        "browser_review": browser_review,
        "effective_verdict": "",
        "error": None,
    }
    outcome["effective_verdict"] = effective_rubric_verdict(outcome)
    return outcome


def _fallback_feasibility_manager(
    task: Task,
    outcomes: Sequence[dict[str, Any]],
    reason: str,
) -> dict[str, Any]:
    assessments = []
    for outcome in outcomes:
        verdict = effective_rubric_verdict(outcome)
        assessments.append(
            {
                "rubric_id": outcome["rubric_id"],
                "accepted_worker_verdict": verdict,
                "manager_note": "The automated check did not finish. A person should review this step.",
            }
        )
    return {
        "schema_version": FEASIBILITY_MANAGER_SCHEMA_VERSION,
        "task_id": task.task_id,
        "disposition": "NEEDS_HUMAN_REVIEW",
        "confidence": 0,
        "reviewed_at_utc": utc_now(),
        "summary": "The automated check did not finish, so a person needs to review this task.",
        "rubric_assessments": assessments,
        "cross_rubric_conflicts": [],
        "task_level_risks": ["The automated check did not finish."],
        "task_feedback": "Review the flagged steps and run the automated check again.",
    }


def _fallback_evergreen_review(task: Task, reason: str) -> dict[str, Any]:
    return {
        "schema_version": EVERGREEN_SCHEMA_VERSION,
        "task_id": task.task_id,
        "verdict": "NEEDS_HUMAN_REVIEW",
        "confidence": 0,
        "reviewed_at_utc": utc_now(),
        "summary": "The automated check did not finish.",
        "concerns": ["The automated check did not finish."],
    }


def _fallback_quality_review(task: Task, reason: str) -> dict[str, Any]:
    unavailable = {
        "verdict": "NEEDS_HUMAN_REVIEW",
        "summary": "The automated check did not finish.",
        "concerns": ["The automated check did not finish."],
    }
    return {
        "schema_version": QUALITY_SCHEMA_VERSION,
        "task_id": task.task_id,
        "overall_verdict": "NEEDS_HUMAN_REVIEW",
        "confidence": 0,
        "reviewed_at_utc": utc_now(),
        "summary": "A person needs to check whether the task and its steps make sense together.",
        "task_coherence": dict(unavailable),
        "rubric_assessments": [
            {
                "rubric_id": rubric.rubric_id,
                "verdict": "NEEDS_HUMAN_REVIEW",
                "summary": "The automated check did not finish for this step.",
                "issues": ["The automated check did not finish."],
                "request_support": [],
                "introduced_requirements": [],
            }
            for rubric in task.rubrics
        ],
    }


def _validate_manager_worker_alignment(
    manager: Mapping[str, Any],
    outcomes: Sequence[Mapping[str, Any]],
) -> None:
    expected = {outcome["rubric_id"]: effective_rubric_verdict(outcome) for outcome in outcomes}
    actual = {
        item["rubric_id"]: item["accepted_worker_verdict"]
        for item in manager["rubric_assessments"]
    }
    if actual != expected:
        raise PipelineError("feasibility manager must preserve each validated worker's effective verdict")
    if manager["disposition"] == "FEASIBLE" and any(verdict != "POSSIBLE" for verdict in expected.values()):
        raise PipelineError("feasibility manager cannot pass a non-POSSIBLE effective rubric verdict")


def run_feasibility_manager(
    task: Task,
    outcomes: Sequence[dict[str, Any]],
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    manager_path = task_dir / "feasibility-manager.json"
    if manager_path.exists():
        try:
            manager = validate_feasibility_manager(read_json(manager_path), task)
            _validate_manager_worker_alignment(manager, outcomes)
            return manager
        except PipelineError:
            manager_path.rename(manager_path.with_suffix(f".invalid-{int(time.time())}.json"))
    manager_inputs = []
    for outcome in outcomes:
        manager_inputs.append(
            {
                "rubric_id": outcome["rubric_id"],
                "worker_status": outcome["status"],
                "review": outcome["review"],
                "browser_review": outcome["browser_review"],
                "effective_verdict": outcome["effective_verdict"],
                "error": outcome["error"],
            }
        )
    payload = {
        "schema_version": "apollo-feasibility-manager-assignment-v2",
        "task_id": task.task_id,
        "full_task_prompt": task.prompt,
        "rubrics": [rubric.as_dict() for rubric in task.rubrics],
        "independent_reviews": manager_inputs,
        "review_time_utc": utc_now(),
    }
    prompt = render_prompt("manager.md", payload)
    raw_output_path = task_dir / "attempts" / "feasibility-manager.json"
    try:
        value = runner.run_json(
            prompt,
            SCHEMA_DIR / "feasibility_manager.schema.json",
            raw_output_path,
            web_search=False,
        )
        manager = validate_feasibility_manager(value, task)
        _validate_manager_worker_alignment(manager, outcomes)
    except Exception as exc:
        manager = validate_feasibility_manager(_fallback_feasibility_manager(task, outcomes, str(exc)), task)
    atomic_write_json(manager_path, manager)
    return manager


def run_evergreen_manager(task: Task, task_dir: Path, runner: CodexRunner) -> dict[str, Any]:
    review_path = task_dir / "evergreen-manager.json"
    if review_path.exists():
        try:
            return validate_evergreen_review(read_json(review_path), task)
        except PipelineError:
            review_path.rename(review_path.with_suffix(f".invalid-{int(time.time())}.json"))
    payload = {
        "schema_version": "apollo-evergreen-assignment-v1",
        "task_id": task.task_id,
        "full_task_prompt": task.prompt,
        "rubrics": [rubric.as_dict() for rubric in task.rubrics],
        "review_time_utc": utc_now(),
    }
    prompt = render_prompt("evergreen_manager.md", payload)
    raw_output_path = task_dir / "attempts" / "evergreen-manager.json"
    try:
        value = runner.run_json(
            prompt,
            SCHEMA_DIR / "evergreen_review.schema.json",
            raw_output_path,
            web_search=False,
        )
        review = validate_evergreen_review(value, task)
    except Exception as exc:
        review = validate_evergreen_review(_fallback_evergreen_review(task, str(exc)), task)
    atomic_write_json(review_path, review)
    return review


def run_quality_manager(task: Task, task_dir: Path, runner: CodexRunner) -> dict[str, Any]:
    review_path = task_dir / "quality-manager.json"
    if review_path.exists():
        try:
            return validate_quality_review(read_json(review_path), task)
        except PipelineError:
            review_path.rename(review_path.with_suffix(f".invalid-{int(time.time())}.json"))
    payload = {
        "schema_version": "apollo-task-quality-assignment-v2",
        "task_id": task.task_id,
        "full_task_prompt": task.prompt,
        "rubrics": [rubric.as_dict() for rubric in task.rubrics],
        "review_time_utc": utc_now(),
    }
    prompt = render_prompt("quality_manager.md", payload)
    raw_output_path = task_dir / "attempts" / "quality-manager.json"
    try:
        value = runner.run_json(
            prompt,
            SCHEMA_DIR / "quality_review.schema.json",
            raw_output_path,
            web_search=False,
        )
        review = validate_quality_review(enforce_named_requirement_alignment(value, task), task)
    except Exception as exc:
        review = validate_quality_review(_fallback_quality_review(task, str(exc)), task)
    atomic_write_json(review_path, review)
    return review


def run_manager(task: Task, outcomes: Sequence[dict[str, Any]], task_dir: Path, runner: CodexRunner) -> dict[str, Any]:
    feasibility = run_feasibility_manager(task, outcomes, task_dir, runner)
    quality = run_quality_manager(task, task_dir, runner)
    manager = {
        **feasibility,
        "schema_version": MANAGER_SCHEMA_VERSION,
        "evergreen_review": {
            "verdict": "NOT_ASSESSED",
            "summary": "Whether the task still works later is checked by the human reviewer.",
            "concerns": [],
        },
        "quality_review": quality,
    }
    manager = validate_manager_review(manager, task)
    atomic_write_json(task_dir / "manager.json", manager)
    return manager


def _no_change_rubric_repair(
    task: Task,
    rubric: Rubric,
    effective_verdict: str,
    quality_verdict: str,
) -> dict[str, Any]:
    return {
        "schema_version": RUBRIC_REPAIR_SCHEMA_VERSION,
        "task_id": task.task_id,
        "rubric_id": rubric.rubric_id,
        "effective_verdict": effective_verdict,
        "quality_verdict": quality_verdict,
        "repair_kind": "NONE",
        "confidence": 1,
        "reason": "This step works as written and needs no change.",
        "edit_operations": [],
        "verified_replacement_urls": [],
        "human_input_needed": None,
        "preserves_intent": True,
    }


def _fallback_rubric_repair(
    task: Task,
    rubric: Rubric,
    effective_verdict: str,
    quality_verdict: str,
    reason: str,
) -> dict[str, Any]:
    return {
        "schema_version": RUBRIC_REPAIR_SCHEMA_VERSION,
        "task_id": task.task_id,
        "rubric_id": rubric.rubric_id,
        "effective_verdict": effective_verdict,
        "quality_verdict": quality_verdict,
        "repair_kind": "HUMAN_REVIEW_REQUIRED",
        "confidence": 0,
        "reason": "No safe small change was found. A person should review this step.",
        "edit_operations": [],
        "verified_replacement_urls": [],
        "human_input_needed": None,
        "preserves_intent": True,
    }


def run_rubric_repair(
    task: Task,
    rubric: Rubric,
    outcome: Mapping[str, Any],
    manager: Mapping[str, Any],
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    effective_verdict = str(outcome["effective_verdict"])
    quality_assessment = next(
        (
            item
            for item in manager["quality_review"]["rubric_assessments"]
            if item["rubric_id"] == rubric.rubric_id
        ),
        None,
    )
    quality_verdict = str(quality_assessment["verdict"] if quality_assessment else "NEEDS_HUMAN_REVIEW")
    if effective_verdict == "POSSIBLE" and quality_verdict == "PASS":
        return validate_rubric_repair(
            _no_change_rubric_repair(task, rubric, effective_verdict, quality_verdict),
            task,
            rubric,
            effective_verdict,
            quality_verdict,
        )
    result_path = task_dir / "rubric-repairs" / f"rubric-{safe_id(rubric.rubric_id)}.json"
    if result_path.exists():
        try:
            return validate_rubric_repair(
                read_json(result_path), task, rubric, effective_verdict, quality_verdict
            )
        except PipelineError:
            result_path.rename(result_path.with_suffix(f".invalid-{int(time.time())}.json"))
    assessment = next(
        (item for item in manager["rubric_assessments"] if item["rubric_id"] == rubric.rubric_id),
        None,
    )
    payload = {
        "schema_version": "apollo-rubric-repair-assignment-v2",
        "task_id": task.task_id,
        "full_task_prompt": task.prompt,
        "rubric": rubric.as_dict(),
        "validated_effective_verdict": effective_verdict,
        "validated_quality_assessment": quality_assessment,
        "validated_review": {
            "worker_status": outcome["status"],
            "review": outcome["review"],
            "browser_review": outcome["browser_review"],
            "error": outcome["error"],
        },
        "manager_assessment": assessment,
        "review_time_utc": utc_now(),
    }
    prompt = render_prompt("rubric_repair_worker.md", payload)
    raw_output_path = task_dir / "attempts" / f"rubric-repair-{safe_id(rubric.rubric_id)}.json"
    last_error: Exception = PipelineError("repair worker did not run")
    for semantic_attempt in range(2):
        attempt_prompt = prompt
        if semantic_attempt:
            attempt_prompt += (
                "\nThe prior JSON passed the output schema but failed Apollo's semantic safety checks: "
                f"{str(last_error)[:1000]}. Return a narrower, internally consistent repair.\n"
            )
        attempt_output_path = raw_output_path.with_name(
            f"{raw_output_path.stem}-semantic-{semantic_attempt + 1}{raw_output_path.suffix}"
        )
        try:
            value = runner.run_json(
                attempt_prompt,
                SCHEMA_DIR / "rubric_repair.schema.json",
                attempt_output_path,
                web_search=True,
            )
            value = normalize_rubric_repair_output(value, task.task_id, rubric.rubric_id)
            if isinstance(value, dict):
                value = {**value, "quality_verdict": quality_verdict}
            repair = validate_rubric_repair(value, task, rubric, effective_verdict, quality_verdict)
        except Exception as exc:
            last_error = exc
            continue
        raw_repair = {key: repair[key] for key in RUBRIC_REPAIR_KEYS}
        atomic_write_json(result_path, raw_repair)
        return repair
    fallback = _fallback_rubric_repair(
        task, rubric, effective_verdict, quality_verdict, str(last_error)
    )
    repair = validate_rubric_repair(fallback, task, rubric, effective_verdict, quality_verdict)
    atomic_write_json(result_path, fallback)
    return repair


def _fallback_task_repair_manager(
    task: Task,
    rubric_repairs: Sequence[Mapping[str, Any]],
    reason: str,
) -> dict[str, Any]:
    unresolved = [
        str(item["rubric_id"])
        for item in rubric_repairs
        if item["repair_kind"] in {"RETRY_VERIFICATION", "HUMAN_INPUT_REQUIRED", "HUMAN_REVIEW_REQUIRED"}
        or (
            item["effective_verdict"] != "POSSIBLE" or item["quality_verdict"] != "PASS"
        )
        and item["suggested_rubric_text"] is None
    ]
    return {
        "schema_version": TASK_REPAIR_MANAGER_SCHEMA_VERSION,
        "task_id": task.task_id,
        "summary": "No safe small task-level change was found. A person should review the flagged step.",
        "task_prompt_edit_operations": [],
        "unresolved_rubric_ids": unresolved,
        "cross_rubric_notes": [],
        "preserves_task_flow": True,
    }


def run_task_repair_manager(
    task: Task,
    outcomes: Sequence[Mapping[str, Any]],
    manager: Mapping[str, Any],
    rubric_repairs: Sequence[Mapping[str, Any]],
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    if (
        all(item["effective_verdict"] == "POSSIBLE" for item in outcomes)
        and manager["quality_review"]["overall_verdict"] == "PASS"
    ):
        return validate_task_repair_manager(
            {
                "schema_version": TASK_REPAIR_MANAGER_SCHEMA_VERSION,
                "task_id": task.task_id,
                "summary": "The task and every step work as written. No change is suggested.",
                "task_prompt_edit_operations": [],
                "unresolved_rubric_ids": [],
                "cross_rubric_notes": [],
                "preserves_task_flow": True,
            },
            task,
        )
    result_path = task_dir / "task-repair-manager.json"
    if result_path.exists():
        try:
            return validate_task_repair_manager(read_json(result_path), task)
        except PipelineError:
            result_path.rename(result_path.with_suffix(f".invalid-{int(time.time())}.json"))
    payload = {
        "schema_version": "apollo-task-repair-manager-assignment-v1",
        "task_id": task.task_id,
        "full_task_prompt": task.prompt,
        "rubrics": [rubric.as_dict() for rubric in task.rubrics],
        "validated_outcomes": list(outcomes),
        "manager_review": manager,
        "advisory_rubric_repairs": list(rubric_repairs),
        "review_time_utc": utc_now(),
    }
    prompt = render_prompt("task_repair_manager.md", payload)
    raw_output_path = task_dir / "attempts" / "task-repair-manager.json"
    try:
        value = runner.run_json(
            prompt,
            SCHEMA_DIR / "task_repair_manager.schema.json",
            raw_output_path,
            web_search=False,
        )
        if isinstance(value, dict):
            value = {**value, "task_id": task.task_id}
        repair_manager = validate_task_repair_manager(value, task)
        raw_manager = {key: repair_manager[key] for key in TASK_REPAIR_MANAGER_KEYS}
        atomic_write_json(result_path, raw_manager)
        return repair_manager
    except Exception as exc:
        fallback = _fallback_task_repair_manager(task, rubric_repairs, str(exc))
        repair_manager = validate_task_repair_manager(fallback, task)
        atomic_write_json(result_path, fallback)
        return repair_manager


def _repair_verification_outcome(status: str) -> dict[str, Any]:
    return {"status": status, "review": None, "error": None}


def run_rubric_repair_verification(
    task: Task,
    rubric: Rubric,
    repair: Mapping[str, Any],
    proposed_task_prompt: str,
    proposed_rubric_text: str,
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    task_context_changed = proposed_task_prompt != task.prompt
    if (
        repair["effective_verdict"] == "POSSIBLE"
        and repair["quality_verdict"] == "PASS"
        and repair["suggested_rubric_text"] is None
        and not task_context_changed
    ):
        return _repair_verification_outcome("NOT_REQUIRED")
    if repair["suggested_rubric_text"] is None and not task_context_changed:
        return _repair_verification_outcome("NOT_RUN")
    fingerprint = hashlib.sha256(
        canonical_json(
            {
                "task_prompt": proposed_task_prompt,
                "rubric_text": proposed_rubric_text,
                "repair_kind": repair["repair_kind"],
            }
        ).encode("utf-8")
    ).hexdigest()
    result_path = (
        task_dir
        / "repair-verifications"
        / f"rubric-{safe_id(rubric.rubric_id)}.{fingerprint[:16]}.json"
    )
    if result_path.exists():
        try:
            review = validate_rubric_repair_verification(
                read_json(result_path), task.task_id, rubric.rubric_id
            )
            return {"status": "COMPLETED", "review": review, "error": None}
        except PipelineError:
            result_path.rename(result_path.with_suffix(f".invalid-{int(time.time())}.json"))
    payload = {
        "schema_version": "apollo-rubric-repair-verification-assignment-v2",
        "task_id": task.task_id,
        "rubric_id": rubric.rubric_id,
        "proposed_full_task_prompt": proposed_task_prompt,
        "original_rubric": rubric.as_dict(),
        "proposed_rubric_text": proposed_rubric_text,
        "original_effective_verdict": repair["effective_verdict"],
        "original_quality_verdict": repair["quality_verdict"],
        "advisory_repair_kind": repair["repair_kind"],
        "advisory_repair_reason": repair["reason"],
        "claimed_replacement_urls": repair["verified_replacement_urls"],
        "review_time_utc": utc_now(),
    }
    prompt = render_prompt("rubric_repair_verifier.md", payload)
    raw_output_path = task_dir / "attempts" / (
        f"rubric-repair-verification-{safe_id(rubric.rubric_id)}-{fingerprint[:16]}.json"
    )
    try:
        value = runner.run_json(
            prompt,
            SCHEMA_DIR / "rubric_repair_verification.schema.json",
            raw_output_path,
            web_search=True,
        )
        value = bind_worker_assignment_ids(value, task.task_id, rubric.rubric_id)
        review = validate_rubric_repair_verification(value, task.task_id, rubric.rubric_id)
        atomic_write_json(result_path, review)
        return {"status": "COMPLETED", "review": review, "error": None}
    except Exception as exc:
        return {"status": "ERROR", "review": None, "error": str(exc)[:8000]}


def finalize_verified_rubric_repair(
    task: Task,
    rubric: Rubric,
    repair: Mapping[str, Any],
    verification: Mapping[str, Any],
) -> dict[str, Any]:
    effective_verdict = str(repair["effective_verdict"])
    quality_verdict = str(repair["quality_verdict"])
    if effective_verdict == "POSSIBLE":
        verified = verification.get("status") == "NOT_REQUIRED" or (
            verification.get("status") == "COMPLETED"
            and isinstance(verification.get("review"), Mapping)
            and verification["review"].get("verdict") == "POSSIBLE"
            and verification["review"].get("quality_verdict") == "PASS"
        )
        if repair["suggested_rubric_text"] is None or verified:
            return {**repair, "verification": dict(verification), "verified_possible": verified}
    review = verification.get("review") if verification.get("status") == "COMPLETED" else None
    if (
        repair["suggested_rubric_text"] is not None
        and isinstance(review, Mapping)
        and review.get("verdict") == "POSSIBLE"
        and review.get("quality_verdict") == "PASS"
    ):
        return {**repair, "verification": dict(verification), "verified_possible": True}
    if repair["suggested_rubric_text"] is None:
        reason = repair["reason"]
    elif verification.get("status") == "ERROR":
        reason = (
            "The candidate repair was suppressed because its independent live-web verification failed to run: "
            f"{str(verification.get('error'))[:1600]}"
        )
    else:
        verdict = review.get("verdict") if isinstance(review, Mapping) else "UNVERIFIED"
        summary = review.get("summary") if isinstance(review, Mapping) else "No independent result was available."
        reason = (
            f"The candidate repair was suppressed because an independent verifier returned {verdict}: "
            f"{str(summary)[:1600]}"
        )
    quality_verdict = str(repair["quality_verdict"])
    suppressed = _fallback_rubric_repair(
        task, rubric, effective_verdict, quality_verdict, reason
    )
    suppressed["reason"] = reason[:2000]
    validated = validate_rubric_repair(
        suppressed, task, rubric, effective_verdict, quality_verdict
    )
    return {**validated, "verification": dict(verification), "verified_possible": False}


def projected_evergreen_review(
    original_task: Task,
    proposed_task: Task,
    manager: Mapping[str, Any],
    changed: bool,
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    return {
        "status": "NOT_REQUIRED",
        "verdict": "NOT_ASSESSED",
        "confidence": None,
        "reviewed_at_utc": None,
        "summary": "Whether the task still works later is checked by the human reviewer.",
        "concerns": [],
        "error": None,
    }


def projected_feasibility_review(
    original_task: Task,
    proposed_task: Task,
    original_outcomes: Sequence[Mapping[str, Any]],
    rubric_repairs: Sequence[Mapping[str, Any]],
    manager: Mapping[str, Any],
    changed: bool,
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    if any(not repair["verified_possible"] for repair in rubric_repairs):
        return {
            "status": "NOT_RUN",
            "disposition": None,
            "confidence": None,
            "reviewed_at_utc": None,
            "summary": "The combined task was not checked because at least one step still needs attention.",
            "cross_rubric_conflicts": [],
            "task_level_risks": [],
            "error": None,
        }
    if not changed:
        return {
            "status": "NOT_REQUIRED",
            "disposition": manager["disposition"],
            "confidence": manager["confidence"],
            "reviewed_at_utc": manager["reviewed_at_utc"],
            "summary": manager["summary"],
            "cross_rubric_conflicts": manager["cross_rubric_conflicts"],
            "task_level_risks": manager["task_level_risks"],
            "error": None,
        }
    original_by_id = {str(item["rubric_id"]): item for item in original_outcomes}
    projected_outcomes = []
    for repair in rubric_repairs:
        rubric_id = str(repair["rubric_id"])
        verification = repair["verification"]
        if verification["status"] == "COMPLETED":
            review = verification["review"]
            browser = _browser_not_run()
        else:
            original = original_by_id[rubric_id]
            review = original["review"]
            browser = original["browser_review"]
        projected_outcomes.append({
            "rubric_id": rubric_id,
            "status": "COMPLETED",
            "review": review,
            "browser_review": browser,
            "effective_verdict": "POSSIBLE",
            "error": None,
        })
    review = run_feasibility_manager(
        proposed_task,
        projected_outcomes,
        task_dir / "repair-projection" / proposed_task.task_content_hash,
        runner,
    )
    return {
        "status": "COMPLETED",
        "disposition": review["disposition"],
        "confidence": review["confidence"],
        "reviewed_at_utc": review["reviewed_at_utc"],
        "summary": review["summary"],
        "cross_rubric_conflicts": review["cross_rubric_conflicts"],
        "task_level_risks": review["task_level_risks"],
        "error": None,
    }


def projected_quality_review(
    proposed_task: Task,
    manager: Mapping[str, Any],
    changed: bool,
    task_dir: Path,
    runner: CodexRunner,
) -> dict[str, Any]:
    if not changed:
        return {
            "status": "NOT_REQUIRED",
            "review": manager["quality_review"],
            "error": None,
        }
    review = run_quality_manager(
        proposed_task,
        task_dir / "repair-projection" / proposed_task.task_content_hash,
        runner,
    )
    return {"status": "COMPLETED", "review": review, "error": None}


def run_repair_plan(
    task: Task,
    outcomes: Sequence[dict[str, Any]],
    manager: Mapping[str, Any],
    task_dir: Path,
    runner: CodexRunner,
    workers: int,
) -> dict[str, Any]:
    outcome_by_id = {str(item["rubric_id"]): item for item in outcomes}
    repairs_by_id: dict[str, dict[str, Any]] = {}
    max_workers = max(1, min(workers, len(task.rubrics)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                run_rubric_repair,
                task,
                rubric,
                outcome_by_id[rubric.rubric_id],
                manager,
                task_dir,
                runner,
            ): rubric.rubric_id
            for rubric in task.rubrics
        }
        for future in concurrent.futures.as_completed(futures):
            rubric_id = futures[future]
            try:
                repairs_by_id[rubric_id] = future.result()
            except Exception as exc:
                rubric = next(item for item in task.rubrics if item.rubric_id == rubric_id)
                verdict = str(outcome_by_id[rubric_id]["effective_verdict"])
                quality_assessment = next(
                    (
                        item
                        for item in manager["quality_review"]["rubric_assessments"]
                        if item["rubric_id"] == rubric_id
                    ),
                    None,
                )
                quality_verdict = str(
                    quality_assessment["verdict"] if quality_assessment else "NEEDS_HUMAN_REVIEW"
                )
                repairs_by_id[rubric_id] = validate_rubric_repair(
                    _fallback_rubric_repair(
                        task, rubric, verdict, quality_verdict, str(exc)
                    ),
                    task,
                    rubric,
                    verdict,
                    quality_verdict,
                )
    candidate_repairs = [repairs_by_id[rubric.rubric_id] for rubric in task.rubrics]
    task_manager = run_task_repair_manager(task, outcomes, manager, candidate_repairs, task_dir, runner)
    candidate_task_prompt = task_manager["suggested_task_prompt"] or task.prompt
    candidate_rubric_texts = {
        rubric.rubric_id: (repair["suggested_rubric_text"] or rubric.criterion)
        for rubric, repair in zip(task.rubrics, candidate_repairs)
    }
    task_prompt_eligible = task_manager["suggested_task_prompt"] is not None and all(
        (
            repair["effective_verdict"] == "POSSIBLE"
            and repair["quality_verdict"] == "PASS"
        )
        or repair["suggested_rubric_text"] is not None
        for repair in candidate_repairs
    )
    selected_task_prompt = candidate_task_prompt if task_prompt_eligible else task.prompt

    def verify_and_finalize(prompt: str) -> list[dict[str, Any]]:
        verification_by_id: dict[str, dict[str, Any]] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(
                    run_rubric_repair_verification,
                    task,
                    rubric,
                    repair,
                    prompt,
                    candidate_rubric_texts[rubric.rubric_id],
                    task_dir,
                    runner,
                ): rubric.rubric_id
                for rubric, repair in zip(task.rubrics, candidate_repairs)
            }
            for future in concurrent.futures.as_completed(futures):
                rubric_id = futures[future]
                try:
                    verification_by_id[rubric_id] = future.result()
                except Exception as exc:
                    verification_by_id[rubric_id] = {
                        "status": "ERROR", "review": None, "error": str(exc)[:8000]
                    }
        return [
            finalize_verified_rubric_repair(
                task,
                rubric,
                repair,
                verification_by_id[rubric.rubric_id],
            )
            for rubric, repair in zip(task.rubrics, candidate_repairs)
        ]

    def project(
        prompt: str,
        repairs: Sequence[Mapping[str, Any]],
    ) -> tuple[list[str], Task, dict[str, Any], dict[str, Any], dict[str, Any]]:
        unresolved = [
            rubric.rubric_id
            for rubric, repair in zip(task.rubrics, repairs)
            if not repair["verified_possible"]
        ]
        final_texts = {
            rubric.rubric_id: (repair["suggested_rubric_text"] or rubric.criterion)
            for rubric, repair in zip(task.rubrics, repairs)
        }
        proposed = Task(
            task_id=task.task_id,
            prompt=prompt,
            rubrics=tuple(
                Rubric(rubric.rubric_id, final_texts[rubric.rubric_id], rubric.critical)
                for rubric in task.rubrics
            ),
            effective_task={"request": prompt},
        )
        changed = prompt != task.prompt or any(
            final_texts[rubric.rubric_id] != rubric.criterion for rubric in task.rubrics
        )
        evergreen = projected_evergreen_review(task, proposed, manager, changed, task_dir, runner)
        feasibility = projected_feasibility_review(
            task, proposed, outcomes, repairs, manager, changed, task_dir, runner
        )
        quality = projected_quality_review(proposed, manager, changed, task_dir, runner)
        return unresolved, proposed, evergreen, feasibility, quality

    rubric_repairs = verify_and_finalize(selected_task_prompt)
    (
        unresolved_rubric_ids,
        proposed_task,
        evergreen_projection,
        feasibility_projection,
        quality_projection,
    ) = project(selected_task_prompt, rubric_repairs)
    if selected_task_prompt != task.prompt and (
        unresolved_rubric_ids
        or feasibility_projection["disposition"] != "FEASIBLE"
        or quality_projection["review"]["overall_verdict"] != "PASS"
    ):
        selected_task_prompt = task.prompt
        rubric_repairs = verify_and_finalize(selected_task_prompt)
        (
            unresolved_rubric_ids,
            proposed_task,
            evergreen_projection,
            feasibility_projection,
            quality_projection,
        ) = project(selected_task_prompt, rubric_repairs)
    all_projected = not unresolved_rubric_ids
    overall_possible = (
        all_projected
        and feasibility_projection["disposition"] == "FEASIBLE"
        and quality_projection["review"]["overall_verdict"] == "PASS"
    )
    expose_task_prompt = selected_task_prompt != task.prompt and overall_possible
    exposed_rubric_ids = [
        str(repair["rubric_id"])
        for repair in rubric_repairs
        if repair["suggested_rubric_text"] is not None
    ]
    available: list[str] = []
    if expose_task_prompt:
        available.append("the request")
    if exposed_rubric_ids:
        available.append("steps " + ", ".join(exposed_rubric_ids[:5]))
    if available:
        second_sentence = "A small checked suggestion is available for " + " and ".join(available) + "."
    elif unresolved_rubric_ids:
        ids = ", ".join(unresolved_rubric_ids[:5])
        suffix = " and more" if len(unresolved_rubric_ids) > 5 else ""
        second_sentence = f"A person should review steps {ids}{suffix}."
    else:
        second_sentence = "No change is suggested."
    summary = f"The submitted task is unchanged. {second_sentence}"[:360]
    visible_cross_rubric_notes = [
        "Only suggestions checked on a public website and for task fit are shown.",
        "A reviewer must choose whether to use any suggestion.",
    ]
    if unresolved_rubric_ids:
        visible_cross_rubric_notes.append(
            "Some items need human judgment or missing information; nothing was invented."
        )
    plan = {
        "schema_version": REPAIR_PLAN_SCHEMA_VERSION,
        "task_id": task.task_id,
        "created_at_utc": utc_now(),
        "applied_automatically": False,
        "source_changed": False,
        "summary": summary,
        "suggested_task_prompt": task_manager["suggested_task_prompt"] if expose_task_prompt else None,
        "task_prompt_edit_operations": task_manager["task_prompt_edit_operations"] if expose_task_prompt else [],
        "rubric_repairs": rubric_repairs,
        "unresolved_rubric_ids": unresolved_rubric_ids,
        "cross_rubric_notes": visible_cross_rubric_notes,
        "preserves_task_flow": task_manager["preserves_task_flow"],
        "all_suggested_changes_verified": True,
        "all_rubrics_projected_possible": all_projected,
        "projected_evergreen_review": evergreen_projection,
        "projected_feasibility_review": feasibility_projection,
        "projected_quality_review": quality_projection,
        "projected_task_status": "POSSIBLE" if overall_possible else "UNRESOLVED",
    }
    return validate_repair_plan(plan, task, outcomes, manager)


class TaskLock:
    def __init__(self, task_dir: Path, stale_seconds: int):
        self.path = task_dir / ".lock"
        self.stale_seconds = stale_seconds
        self.held = False

    def __enter__(self) -> "TaskLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.path.mkdir()
        except FileExistsError:
            try:
                age = time.time() - self.path.stat().st_mtime
            except FileNotFoundError:
                age = 0
            if age <= self.stale_seconds:
                raise PipelineError(f"task is already claimed by another pipeline process: {self.path.parent}")
            try:
                (self.path / "owner.json").unlink(missing_ok=True)
                self.path.rmdir()
                self.path.mkdir()
            except OSError as exc:
                raise PipelineError(f"could not reclaim stale task lock: {self.path}") from exc
        (self.path / "owner.json").write_text(
            json.dumps({"pid": os.getpid(), "created_at_utc": utc_now()}), encoding="utf-8"
        )
        self.held = True
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if not self.held:
            return
        try:
            (self.path / "owner.json").unlink(missing_ok=True)
            self.path.rmdir()
        except OSError:
            pass


def aws_base_command(config: Config) -> list[str]:
    command = ["aws"]
    if config.aws_profile:
        command.extend(["--profile", config.aws_profile])
    if config.aws_region:
        command.extend(["--region", config.aws_region])
    return command


def scrub_worker_environment(environment: Mapping[str, str]) -> dict[str, str]:
    credential_prefixes = ("AWS_", "APOLLO_", "CLOUDFLARE_", "CMU_", "VERCEL_")
    return {
        key: value
        for key, value in environment.items()
        if not key.upper().startswith(credential_prefixes)
        and "REPORTING_TOKEN" not in key.upper()
        and "REPORTING_KEY" not in key.upper()
    }


def s3_existing_metadata(config: Config, key: str) -> dict[str, str] | None:
    command = aws_base_command(config) + ["s3api", "head-object", "--bucket", str(config.s3_bucket), "--key", key]
    error = ""
    for attempt in range(4):
        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            error = "AWS head-object timed out"
        else:
            if completed.returncode == 0:
                try:
                    head = json.loads(completed.stdout)
                except json.JSONDecodeError as exc:
                    raise PipelineError(f"AWS returned invalid head-object JSON for s3://{config.s3_bucket}/{key}") from exc
                metadata = head.get("Metadata") if isinstance(head, dict) else None
                return {str(k).lower(): str(v) for k, v in metadata.items()} if isinstance(metadata, dict) else {}
            error = completed.stderr or ""
            if any(marker in error for marker in ("404", "Not Found", "NoSuchKey")):
                return None
        if attempt < 3:
            time.sleep(0.25 * (2 ** attempt))
    raise PipelineError(f"could not check s3://{config.s3_bucket}/{key}: {error[-1000:].strip()}")


def upload_immutable(config: Config, local_path: Path, key: str, status: str, task_content_hash: str) -> None:
    review_stage = "PRE_QC" if config.pre_qc else "POST_QC"
    existing = s3_existing_metadata(config, key)
    if existing is not None:
        if existing.get("task-content-hash") != task_content_hash:
            raise PipelineError(
                f"refusing to replace s3://{config.s3_bucket}/{key}: its task-content-hash differs"
            )
        if existing.get("status") != status:
            raise PipelineError(f"refusing to reuse s3://{config.s3_bucket}/{key}: its status differs")
        if config.pre_qc and existing.get("review-stage") != review_stage:
            raise PipelineError(f"refusing to reuse s3://{config.s3_bucket}/{key}: its review-stage differs")
        return
    command = aws_base_command(config) + [
        "s3api",
        "put-object",
        "--bucket",
        str(config.s3_bucket),
        "--key",
        key,
        "--body",
        str(local_path),
        "--content-type",
        "application/json",
        "--cache-control",
        "no-store",
        "--metadata",
        (
            f"pipeline-version={PIPELINE_VERSION},status={status},"
            f"task-content-hash={task_content_hash},review-stage={review_stage}"
        ),
        "--if-none-match",
        "*",
    ]
    error = ""
    for attempt in range(4):
        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            error = "AWS put-object timed out"
        else:
            if completed.returncode == 0:
                return
            error = completed.stderr or ""
            if "PreconditionFailed" in error or "412" in error:
                return
        if attempt < 3:
            time.sleep(0.25 * (2 ** attempt))
    raise PipelineError(f"could not upload s3://{config.s3_bucket}/{key}: {error[-1500:].strip()}")


def base64url(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def artifact_key(config: Config, task: Task, status: str) -> str:
    if config.pre_qc:
        prefix = config.s3_pre_qc_pass_prefix if status == "LLM_PASS" else config.s3_pre_qc_attention_prefix
    else:
        prefix = config.s3_pass_prefix if status == "LLM_PASS" else config.s3_fail_prefix
    return (
        f"{prefix.strip('/')}/{base64url(task.task_id)}."
        f"{task.task_content_hash}.{safe_id(PIPELINE_VERSION)}.json"
    )


def upload_with_decision_claim(config: Config, artifact_path: Path, task: Task, status: str) -> None:
    # An operational failure is not a review decision. Keeping the artifact local
    # preserves diagnostics while leaving the production task eligible for a
    # clean retry instead of incorrectly unblocking human review.
    if status == "PIPELINE_ERROR":
        return
    claim_prefix = config.s3_pre_qc_claim_prefix if config.pre_qc else config.s3_claim_prefix
    claim_key = (
        f"{claim_prefix.strip('/')}/{base64url(task.task_id)}."
        f"{task.task_content_hash}.{safe_id(PIPELINE_VERSION)}.json"
    )
    claim_path = artifact_path.parent / "s3-decision-claim.json"
    claim = {
        "schema_version": "apollo-llm-feasibility-s3-claim-v1",
        "review_stage": "PRE_QC" if config.pre_qc else "POST_QC",
        "task_id": task.task_id,
        "task_content_hash": task.task_content_hash,
        "status": status,
        "created_at_utc": utc_now(),
    }
    atomic_write_json(claim_path, claim)
    upload_immutable(config, claim_path, claim_key, status, task.task_content_hash)
    upload_immutable(config, artifact_path, artifact_key(config, task, status), status, task.task_content_hash)


def process_task(task: Task, config: Config, runner: CodexRunner) -> dict[str, Any]:
    source_before = canonical_json(task.source_dict())
    task_root = config.workdir / "tasks" / safe_id(task.task_id) / safe_id(PIPELINE_VERSION)
    task_dir = task_root / "pre_qc" / task.task_content_hash if config.pre_qc else task_root / task.task_content_hash
    artifact_path = task_dir / "artifact.json"
    with TaskLock(task_dir, config.lock_stale_seconds):
        if artifact_path.exists():
            try:
                artifact = validate_final_artifact(read_json(artifact_path), task)
            except PipelineError:
                artifact_path.rename(artifact_path.with_suffix(f".invalid-{int(time.time())}.json"))
            else:
                if canonical_json(task.source_dict()) != source_before:
                    raise PipelineError("read-only invariant failed: source task changed during review")
                if config.upload:
                    upload_with_decision_claim(config, artifact_path, task, artifact["status"])
                return artifact

        max_workers = max(1, min(config.workers, len(task.rubrics)))
        outcomes_by_id: dict[str, dict[str, Any]] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(review_one_rubric, task, rubric, task_dir, runner): rubric.rubric_id
                for rubric in task.rubrics
            }
            for future in concurrent.futures.as_completed(futures):
                rubric_id = futures[future]
                try:
                    outcomes_by_id[rubric_id] = future.result()
                except Exception as exc:
                    outcomes_by_id[rubric_id] = {
                        "rubric_id": rubric_id,
                        "status": "ERROR",
                        "review": None,
                        "browser_review": _browser_not_run(),
                        "effective_verdict": "WORKER_ERROR",
                        "error": str(exc)[:8000],
                    }
        outcomes = [outcomes_by_id[rubric.rubric_id] for rubric in task.rubrics]
        manager = run_manager(task, outcomes, task_dir, runner)
        repair_plan = run_repair_plan(task, outcomes, manager, task_dir, runner, config.workers)
        status = deterministic_status(outcomes, manager)
        if canonical_json(task.source_dict()) != source_before:
            raise PipelineError("read-only invariant failed: source task changed during review")
        artifact = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "pipeline_version": PIPELINE_VERSION,
            "task_id": task.task_id,
            "task_content_hash": task.task_content_hash,
            "created_at_utc": utc_now(),
            "source": task.source_dict(),
            "rubric_reviews": outcomes,
            "manager_review": manager,
            "feedback": {
                "task": manager["task_feedback"],
                "rubrics": [
                    {
                        "rubric_id": outcome["rubric_id"],
                        "feedback": (
                            outcome["browser_review"]["review"]["rubric_feedback"]
                            if outcome["browser_review"]["status"] == "COMPLETED"
                            and outcome["browser_review"]["review"]["rubric_feedback"] is not None
                            else outcome["review"]["rubric_feedback"] if outcome["status"] == "COMPLETED" else None
                        ),
                    }
                    for outcome in outcomes
                ],
            },
            "repair_plan": repair_plan,
            "status": status,
            "passed": status == "LLM_PASS",
        }
        validate_final_artifact(artifact, task)
        atomic_write_json(artifact_path, artifact)
        if config.upload:
            upload_with_decision_claim(config, artifact_path, task, status)
        return artifact


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Local JSON or JSONL containing full task prompts and rubrics.")
    source.add_argument("--api-url", help="Authenticated reporting API URL containing full task content.")
    parser.add_argument("--api-token-env", default="APOLLO_REPORTING_TOKEN", help="Environment variable containing the API bearer token.")
    parser.add_argument("--task-id", action="append", dest="task_ids", help="Process only this exact task ID; repeatable.")
    parser.add_argument("--include-reviewed", action="store_true", help="Reprocess API rows already marked passed or needs_attention.")
    parser.add_argument(
        "--pre-qc",
        action="store_true",
        help="Review only pending/in-review drafts as advisory PRE_QC artifacts in isolated prefixes.",
    )
    parser.add_argument(
        "--queue",
        choices=tuple(QUEUE_ROOTS),
        default="v2",
        help="Read and write QC artifacts for the Apollo v2 or isolated Apollo PC queue.",
    )
    parser.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    parser.add_argument("--workers", type=int, default=6, help="Maximum simultaneous independent rubric Codex processes.")
    parser.add_argument(
        "--task-workers",
        type=int,
        default=1,
        help="Maximum tasks processed concurrently; total Codex concurrency can reach task-workers × workers.",
    )
    parser.add_argument("--timeout-seconds", type=int, default=900, help="Timeout per Codex process and API request.")
    parser.add_argument("--retries", type=int, default=1, help="Retries for failed or malformed Codex output.")
    parser.add_argument("--model", default=None, help="Optional Codex model override; defaults to the configured CLI model.")
    parser.add_argument(
        "--model-provider",
        choices=("openai", "amazon-bedrock"),
        default=None,
        help="Optional Codex model provider. Amazon Bedrock uses the standard AWS credential chain.",
    )
    parser.add_argument(
        "--reasoning-effort",
        choices=("low", "medium", "high", "xhigh"),
        default=None,
        help="Optional Codex reasoning-effort override for every worker.",
    )
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument(
        "--browser-escalation",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Escalate interaction-only SHORTFALL reviews to isolated headless Playwright verification.",
    )
    parser.add_argument("--plan", action="store_true", help="Validate and summarize work without invoking Codex or AWS.")
    parser.add_argument("--no-upload", action="store_true", help="Keep validated results local instead of writing S3.")
    parser.add_argument("--s3-bucket", default=os.environ.get("APOLLO_S3_BUCKET"))
    parser.add_argument("--s3-pass-prefix", default=None)
    parser.add_argument("--s3-fail-prefix", default=None)
    parser.add_argument("--s3-claim-prefix", default=None)
    parser.add_argument("--aws-profile", default=os.environ.get("AWS_PROFILE"))
    parser.add_argument("--aws-region", default=os.environ.get("AWS_REGION"))
    parser.add_argument("--lock-stale-seconds", type=int, default=7200)
    return parser


def validate_args(args: argparse.Namespace) -> None:
    if args.workers < 1 or args.workers > 16:
        raise PipelineError("--workers must be between 1 and 16")
    if args.task_workers < 1 or args.task_workers > 8:
        raise PipelineError("--task-workers must be between 1 and 8")
    if args.workers * args.task_workers > 32:
        raise PipelineError("--workers × --task-workers must not exceed 32")
    if args.timeout_seconds < 30:
        raise PipelineError("--timeout-seconds must be at least 30")
    if args.retries < 0 or args.retries > 3:
        raise PipelineError("--retries must be between 0 and 3")
    if args.lock_stale_seconds < args.timeout_seconds:
        raise PipelineError("--lock-stale-seconds must be at least --timeout-seconds")
    if args.model_provider == "amazon-bedrock" and not args.aws_region:
        raise PipelineError("--aws-region is required with --model-provider amazon-bedrock")
    if not args.no_upload and not args.plan and not args.s3_bucket:
        raise PipelineError("--s3-bucket or APOLLO_S3_BUCKET is required unless --no-upload is used")
    queue = getattr(args, "queue", "v2")
    root = QUEUE_ROOTS.get(queue)
    if not root:
        raise PipelineError("--queue must be v2 or pc")
    allowed_prefixes = {
        "s3_pass_prefix": f"{root}/llm_pass",
        "s3_fail_prefix": f"{root}/llm_fail",
        "s3_claim_prefix": f"{root}/llm_claims",
    }
    for field, expected in allowed_prefixes.items():
        provided = getattr(args, field, None)
        if provided is None:
            setattr(args, field, expected)
        elif str(provided).strip("/") != expected:
            raise PipelineError(f"--{field.replace('_', '-')} is fixed to {expected}; source-task prefixes are never writable")
    if not args.plan and shutil.which(args.codex_bin) is None:
        raise PipelineError(f"Codex CLI executable not found: {args.codex_bin}")
    if not args.plan and args.browser_escalation and shutil.which("npx") is None:
        raise PipelineError("npx is required for Playwright browser escalation")
    if not args.no_upload and not args.plan and shutil.which("aws") is None:
        raise PipelineError("AWS CLI executable not found")


def run(args: argparse.Namespace) -> int:
    validate_args(args)
    rows = load_rows(args.input, args.api_url, args.api_token_env, args.timeout_seconds)
    tasks = normalize_tasks(rows, set(args.task_ids) if args.task_ids else None, args.include_reviewed)
    wrong_queue = [task.task_id for task in tasks if not task_belongs_to_queue(task.task_id, args.queue)]
    if wrong_queue:
        preview = ", ".join(wrong_queue[:3])
        raise PipelineError(f"--queue {args.queue} cannot process task(s) from the other Apollo queue: {preview}")
    if args.pre_qc:
        invalid = [task.task_id for task in tasks if task.workflow_status not in {"pending", "in_review"}]
        if invalid:
            preview = ", ".join(invalid[:3])
            raise PipelineError(
                f"--pre-qc accepts only pending or in_review tasks; invalid task(s): {preview}"
            )
    total_rubrics = sum(len(task.rubrics) for task in tasks)
    print(f"Validated {len(tasks)} task(s) with {total_rubrics} rubric(s).", flush=True)
    if args.plan:
        stage = "PRE_QC" if args.pre_qc else "POST_QC"
        for task in tasks:
            print(
                f"PLAN {stage} {task.task_id}: {len(task.rubrics)} rubric worker(s), "
                f"content {task.task_content_hash[:12]}",
                flush=True,
            )
        return 0
    config = Config(
        workdir=args.workdir.resolve(),
        workers=args.workers,
        timeout_seconds=args.timeout_seconds,
        retries=args.retries,
        model=args.model,
        codex_bin=args.codex_bin,
        upload=not args.no_upload,
        s3_bucket=args.s3_bucket,
        s3_pass_prefix=args.s3_pass_prefix,
        s3_fail_prefix=args.s3_fail_prefix,
        s3_claim_prefix=args.s3_claim_prefix,
        aws_profile=args.aws_profile,
        aws_region=args.aws_region,
        lock_stale_seconds=args.lock_stale_seconds,
        browser_escalation=args.browser_escalation,
        reasoning_effort=args.reasoning_effort,
        pre_qc=args.pre_qc,
        s3_pre_qc_pass_prefix=f"{QUEUE_ROOTS[args.queue]}/llm_pre_qc_pass",
        s3_pre_qc_attention_prefix=f"{QUEUE_ROOTS[args.queue]}/llm_pre_qc_attention",
        s3_pre_qc_claim_prefix=f"{QUEUE_ROOTS[args.queue]}/llm_pre_qc_claims",
        model_provider=args.model_provider,
    )
    runner = CodexRunner(config)
    counts = {"LLM_PASS": 0, "LLM_FAIL": 0, "NEEDS_HUMAN_REVIEW": 0, "PIPELINE_ERROR": 0}
    failed_tasks = 0
    def review_task(index: int, task: Task) -> tuple[Task, dict[str, Any] | None, Exception | None]:
        print(f"[{index}/{len(tasks)}] {task.task_id}: reviewing {len(task.rubrics)} rubric(s)", flush=True)
        try:
            artifact = process_task(task, config, runner)
        except Exception as exc:
            return task, None, exc
        return task, artifact, None

    indexed_tasks = list(enumerate(tasks, start=1))
    if args.task_workers == 1:
        results = [review_task(index, task) for index, task in indexed_tasks]
    else:
        results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.task_workers) as executor:
            futures = [executor.submit(review_task, index, task) for index, task in indexed_tasks]
            for future in concurrent.futures.as_completed(futures):
                results.append(future.result())
    for task, artifact, error in results:
        if error is not None or artifact is None:
            failed_tasks += 1
            print(f"  task pipeline failed for {task.task_id}: {error}", file=sys.stderr, flush=True)
            continue
        counts[artifact["status"]] += 1
        print(f"  {artifact['status']} ({task.task_content_hash[:12]})", flush=True)
    summary = {
        "schema_version": "apollo-llm-feasibility-run-summary-v2",
        "pipeline_version": PIPELINE_VERSION,
        "review_stage": "PRE_QC" if args.pre_qc else "POST_QC",
        "queue": args.queue,
        "created_at_utc": utc_now(),
        "tasks_seen": len(tasks),
        "rubrics_seen": total_rubrics,
        "task_status_counts": counts,
        "task_pipeline_failures": failed_tasks,
    }
    atomic_write_json(config.workdir / "latest-run-summary.json", summary)
    print(json.dumps(summary, indent=2, sort_keys=True), flush=True)
    return 1 if failed_tasks or counts["PIPELINE_ERROR"] else 0


def main() -> None:
    try:
        raise SystemExit(run(make_parser().parse_args()))
    except PipelineError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
