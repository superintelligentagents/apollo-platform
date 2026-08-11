#!/usr/bin/env python3
"""Judge every rubric against a complete recorded browser trajectory.

This is the repo-local, production-safe counterpart of Odysseys'
``run_full_trajectory_per_rubric.py``.  It deliberately emits the same
``{"summary": ..., "tasks": [...]}`` envelope consumed by ``prepare.py``.

Model credentials are read from the environment only.  The program never
writes to Apollo task, gold, or human-review prefixes.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import mimetypes
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

if __package__:
    from .prepare import PackageError, load_steps, resolve_screenshot
else:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from scripts.trajectory_review.prepare import PackageError, load_steps, resolve_screenshot


JUDGE_VERSION = "apollo-full-trajectory-judge-v1"
DEFAULT_MODEL = "gemini-3.1-flash-lite-preview"
DEFAULT_MAX_IMAGES = 0
DEFAULT_MAX_HISTORY_CHARS = 400_000
MAX_COMPLETION_TOKENS = 4_096

SYSTEM_PROMPT = """You are an independent evaluator of a web-navigation agent trajectory.

You receive the complete user task for context, exactly one rubric/verifier,
the recorded action/response history, and chronological screenshots.

Evaluate only the supplied rubric. Ground the decision in visible or recorded
evidence. Do not infer an unobserved result. A required filter, sort, form
state, saved artifact, or final answer counts only when the trajectory proves
it. A captcha or access block is a failure when it prevented completion.

Do not provide hidden chain-of-thought. Return exactly two lines:
Evidence: <a concise evidence summary citing decisive step numbers>
Status: "success" or "failure"
"""


class JudgeError(RuntimeError):
    pass


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    prompt: str
    rubrics: tuple[dict[str, str], ...]
    level: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def infer_task_id(run_dir: Path) -> str:
    """Match the task-id convention used by the Odysseys runner."""
    name = run_dir.name
    if re.fullmatch(r"[0-9a-f]{32}(?:_\S+)?", name, re.IGNORECASE):
        return name
    match = re.search(r"(?:^|[_-])([0-9a-f]{40}|[0-9a-f]{32})(?:_[0-9]+)?$", name, re.IGNORECASE)
    return match.group(1) if match else name


def _rubric_rows(raw: Any) -> tuple[dict[str, str], ...]:
    entries: Iterable[tuple[str, Any]]
    if isinstance(raw, Mapping):
        entries = ((str(key), value) for key, value in raw.items())
    elif isinstance(raw, list):
        entries = (
            (clean_text(value.get("rubric_id") or value.get("id") or f"rubric-{index + 1}", 100), value)
            for index, value in enumerate(raw)
            if isinstance(value, Mapping)
        )
    else:
        return ()

    rows: list[dict[str, str]] = []
    for fallback_id, value in entries:
        if isinstance(value, str):
            value = {"requirement": value}
        if not isinstance(value, Mapping):
            continue
        rubric_id = clean_text(value.get("rubric_id") or value.get("id") or fallback_id, 100)
        requirement = clean_text(
            value.get("requirement")
            or value.get("criterion")
            or value.get("final")
            or value.get("text"),
            30_000,
        )
        verification = clean_text(
            value.get("verification") or value.get("verifier") or value.get("verification_description"),
            20_000,
        )
        if rubric_id and requirement:
            rows.append({"id": rubric_id, "requirement": requirement, "verification": verification})
    return tuple(rows)


def normalize_task(value: Mapping[str, Any]) -> TaskSpec:
    """Accept Odysseys task JSON and Apollo reporting ``include=full`` rows."""
    content = value.get("content") if isinstance(value.get("content"), Mapping) else {}
    final = content.get("final") if isinstance(content.get("final"), Mapping) else {}
    task_id = clean_text(value.get("task_id") or content.get("task_id"), 300)
    prompt = clean_text(
        value.get("confirmed_task")
        or value.get("task")
        or value.get("request")
        or final.get("request"),
        200_000,
    )
    rubrics = _rubric_rows(value.get("rubrics") or content.get("rubrics"))
    level = clean_text(value.get("level") or value.get("difficulty") or final.get("difficulty") or "unknown", 40)
    if not task_id or not prompt or not rubrics:
        raise JudgeError("task_id, task prompt, and at least one rubric are required")
    return TaskSpec(task_id, prompt, rubrics, level)


def load_task_index(path: Path) -> dict[str, TaskSpec]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    values = raw.get("tasks") if isinstance(raw, Mapping) else raw
    if not isinstance(values, list):
        raise JudgeError("task source must be an array or an object with a tasks array")
    index: dict[str, TaskSpec] = {}
    for position, value in enumerate(values):
        if not isinstance(value, Mapping):
            raise JudgeError(f"task source item {position} is not an object")
        task = normalize_task(value)
        if task.task_id in index:
            raise JudgeError(f"duplicate task_id in task source: {task.task_id}")
        index[task.task_id] = task
    return index


def discover_runs(runs_dir: Path, include_incomplete: bool) -> list[Path]:
    if not runs_dir.is_dir():
        raise JudgeError(f"runs directory does not exist: {runs_dir}")
    if (runs_dir / "steps.jsonl").is_file() or (runs_dir / "traj.jsonl").is_file():
        discovered = [runs_dir]
    else:
        discovered = sorted(
            {path.parent for filename in ("steps.jsonl", "traj.jsonl") for path in runs_dir.rglob(filename)},
            key=str,
        )
    if include_incomplete:
        return discovered
    complete: list[Path] = []
    for run_dir in discovered:
        try:
            first = (run_dir / "result.txt").read_text(encoding="utf-8", errors="ignore").splitlines()[0]
            if math.isfinite(float(first.strip())):
                complete.append(run_dir)
        except (OSError, ValueError, IndexError):
            continue
    return complete


def validate_assignments(run_dirs: Sequence[Path], task_index: Mapping[str, TaskSpec]) -> list[tuple[Path, TaskSpec]]:
    assignments: list[tuple[Path, TaskSpec]] = []
    missing: list[str] = []
    for run_dir in run_dirs:
        task_id = infer_task_id(run_dir)
        task = task_index.get(task_id)
        if task is None:
            missing.append(f"{run_dir} -> {task_id}")
        else:
            assignments.append((run_dir, task))
    if missing:
        preview = "; ".join(missing[:10])
        suffix = f"; and {len(missing) - 10} more" if len(missing) > 10 else ""
        raise JudgeError(f"run directories missing from task source: {preview}{suffix}")
    return assignments


def assignment_hash(run_dir: Path, task: TaskSpec) -> str:
    """Fingerprint exact task, trajectory bytes, and referenced screenshots."""
    steps, trajectory_path = load_steps(run_dir)
    digest = hashlib.sha256()
    digest.update(json.dumps({
        "task_id": task.task_id,
        "prompt": task.prompt,
        "rubrics": task.rubrics,
    }, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    digest.update(trajectory_path.read_bytes())
    seen: set[Path] = set()
    for step in steps:
        screenshot = resolve_screenshot(run_dir, clean_text(step.get("screenshot_source"), 10_000) or None)
        if screenshot and screenshot not in seen:
            seen.add(screenshot)
            digest.update(screenshot.name.encode("utf-8"))
            digest.update(screenshot.read_bytes())
    return digest.hexdigest()


def load_env_file(path: Path | None) -> None:
    candidate = path or Path(".env")
    if not candidate.is_file():
        if path is not None:
            raise JudgeError(f"environment file does not exist: {candidate}")
        return
    try:
        from dotenv import load_dotenv
    except ImportError as exc:
        raise JudgeError("python-dotenv is required when an environment file is present") from exc
    load_dotenv(candidate, override=False)


def resolve_provider(model: str, requested: str) -> str:
    if requested != "auto":
        return requested
    return "gemini" if model.lower().startswith("gemini") else "openai"


def make_client(provider: str) -> Any:
    if provider == "gemini":
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise JudgeError("set GEMINI_API_KEY or GOOGLE_API_KEY")
        try:
            from google import genai
        except ImportError as exc:
            raise JudgeError("install scripts/trajectory_review/requirements.txt") from exc
        return genai.Client(api_key=api_key)
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise JudgeError("set OPENAI_API_KEY")
    try:
        from openai import AsyncOpenAI
    except ImportError as exc:
        raise JudgeError("install scripts/trajectory_review/requirements.txt") from exc
    kwargs: dict[str, Any] = {"api_key": api_key}
    if os.getenv("OPENAI_BASE_URL"):
        kwargs["base_url"] = os.environ["OPENAI_BASE_URL"]
    return AsyncOpenAI(**kwargs)


def _image_assets(run_dir: Path, steps: Sequence[Mapping[str, Any]], max_images: int) -> list[dict[str, Any]]:
    paths: list[Path] = []
    for step in steps:
        screenshot = resolve_screenshot(run_dir, clean_text(step.get("screenshot_source"), 10_000) or None)
        if screenshot and screenshot not in paths:
            paths.append(screenshot)
    selected = paths[-max_images:] if max_images > 0 else paths
    assets = []
    for path in selected:
        try:
            data = path.read_bytes()
        except OSError:
            continue
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        assets.append({
            "bytes": data,
            "mime": mime,
            "data_url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}",
        })
    return assets


def _history(steps: Sequence[Mapping[str, Any]], max_chars: int) -> str:
    lines: list[str] = []
    for index, step in enumerate(steps, start=1):
        parts = []
        actions = step.get("actions") if isinstance(step.get("actions"), list) else []
        responses = step.get("responses") if isinstance(step.get("responses"), list) else []
        if actions:
            parts.append("Action: " + " -> ".join(clean_text(item, 20_000) for item in actions if clean_text(item, 20_000)))
        if responses:
            parts.append("Response: " + "\n\n".join(clean_text(item, 50_000) for item in responses if clean_text(item, 50_000)))
        if parts:
            lines.append(f"Step {index} (recorded step {step.get('step_number', index)}):\n" + "\n".join(parts))
    value = "\n\n".join(lines) or "No actions or responses were recorded."
    if len(value) > max_chars:
        raise JudgeError(
            f"trajectory history has {len(value):,} characters, above the {max_chars:,} safety limit; "
            "raise --max-history-chars explicitly after inspecting the run"
        )
    return value


def parse_judgment(text: str) -> tuple[str, str]:
    status_match = re.search(r"Status:\s*[\"']?(success|failure)[\"']?", text, re.IGNORECASE)
    evidence_match = re.search(r"Evidence:\s*(.+?)(?:\n\s*Status:|$)", text, re.IGNORECASE | re.DOTALL)
    if not status_match:
        raise JudgeError("judge response omitted a parseable Status line")
    evidence = clean_text(evidence_match.group(1) if evidence_match else text, 30_000)
    if not evidence:
        raise JudgeError("judge response omitted evidence")
    return status_match.group(1).upper(), evidence


async def judge_rubric(
    client: Any,
    provider: str,
    model: str,
    task: TaskSpec,
    rubric: Mapping[str, str],
    history: str,
    assets: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    prompt = (
        f"User task (context only):\n{task.prompt}\n\n"
        f"Evaluate only rubric {rubric['id']}:\nRequirement: {rubric['requirement']}\n"
        f"Verification: {rubric.get('verification') or 'No separate verifier text.'}\n\n"
        f"Recorded action history:\n{history}\n\n"
        f"Chronological screenshots attached: {len(assets)}."
    )
    try:
        if provider == "gemini":
            from google.genai import types
            response = await client.aio.models.generate_content(
                model=model,
                contents=[types.Content(role="user", parts=[
                    types.Part.from_text(text=prompt),
                    *[types.Part.from_bytes(data=asset["bytes"], mime_type=asset["mime"]) for asset in assets],
                ])],
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    max_output_tokens=MAX_COMPLETION_TOKENS,
                    temperature=0,
                ),
            )
            raw = clean_text(response.text, 40_000)
        else:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": [
                        {"type": "text", "text": prompt},
                        *[{"type": "image_url", "image_url": {"url": asset["data_url"], "detail": "high"}} for asset in assets],
                    ]},
                ],
                max_completion_tokens=MAX_COMPLETION_TOKENS,
                temperature=0,
            )
            raw = clean_text(response.choices[0].message.content, 40_000)
        status, evidence = parse_judgment(raw)
        return {
            "rubric_id": rubric["id"],
            "requirement": rubric["requirement"],
            "verification": rubric.get("verification", ""),
            "judge_status": status,
            "score": 1 if status == "SUCCESS" else 0,
            "success": status == "SUCCESS",
            "final_reasoning": evidence,
        }
    except Exception as exc:
        return {
            "rubric_id": rubric["id"],
            "requirement": rubric["requirement"],
            "verification": rubric.get("verification", ""),
            "judge_status": "ERROR",
            "score": None,
            "success": None,
            "final_reasoning": clean_text(f"Judge error: {exc}", 30_000),
        }


def empty_result(run_dir: Path, task: TaskSpec, input_sha256: str, error: str) -> dict[str, Any]:
    return {
        "run_dir": str(run_dir),
        "task_id": task.task_id,
        "task": task.prompt,
        "judge_version": JUDGE_VERSION,
        "input_sha256": input_sha256,
        "rubric_scores": {},
        "rubric_results": [],
        "average_rubric_score": None,
        "perfect": False,
        "error": clean_text(error, 10_000),
    }


async def evaluate_run(
    run_dir: Path,
    task: TaskSpec,
    client: Any,
    provider: str,
    model: str,
    max_images: int,
    max_steps: int,
    max_history_chars: int,
    input_sha256: str,
) -> dict[str, Any]:
    try:
        steps, _ = load_steps(run_dir)
        if max_steps > 0:
            steps = steps[:max_steps]
        if not steps:
            raise JudgeError("trajectory contains no steps")
        history = _history(steps, max_history_chars)
        assets = _image_assets(run_dir, steps, max_images)
    except (OSError, PackageError, JudgeError) as exc:
        return empty_result(run_dir, task, input_sha256, str(exc))

    results = [
        await judge_rubric(client, provider, model, task, rubric, history, assets)
        for rubric in task.rubrics
    ]
    scores = {
        result["rubric_id"]: result["score"]
        for result in results
        if result["judge_status"] != "ERROR"
    }
    numeric = [score for score in scores.values() if isinstance(score, int)]
    return {
        "run_dir": str(run_dir),
        "task_id": task.task_id,
        "task": task.prompt,
        "judge_version": JUDGE_VERSION,
        "input_sha256": input_sha256,
        "judge_provider": provider,
        "judge_model": model,
        "num_steps": len(steps),
        "num_screenshots_sent": len(assets),
        "rubric_scores": scores,
        "rubric_results": results,
        "average_rubric_score": round(sum(numeric) / len(numeric), 4) if numeric else None,
        "perfect": len(numeric) == len(results) and bool(numeric) and all(score == 1 for score in numeric),
        "error": None,
    }


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def load_completed(path: Path, provider: str, model: str) -> dict[str, dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        tasks = raw.get("tasks") if isinstance(raw, Mapping) else None
        if (
            not isinstance(tasks, list)
            or raw.get("judge_version") != JUDGE_VERSION
            or raw.get("provider") != provider
            or raw.get("model") != model
        ):
            return {}
        return {
            str(Path(item["run_dir"]).resolve()): item
            for item in tasks
            if isinstance(item, Mapping)
            and isinstance(item.get("run_dir"), str)
            and not item.get("error")
            and isinstance(item.get("rubric_results"), list)
            and item["rubric_results"]
            and all(result.get("judge_status") in {"SUCCESS", "FAILURE"} for result in item["rubric_results"])
        }
    except (OSError, json.JSONDecodeError):
        return {}


def build_payload(results: Sequence[Mapping[str, Any]], provider: str, model: str) -> dict[str, Any]:
    judged = [
        score
        for result in results
        for score in (result.get("rubric_scores") or {}).values()
        if isinstance(score, int)
    ]
    rubric_errors = sum(
        1
        for result in results
        for rubric in result.get("rubric_results") or []
        if rubric.get("judge_status") == "ERROR"
    )
    perfect = sum(1 for result in results if result.get("perfect") is True)
    return {
        "schema_version": "apollo-full-trajectory-judge-results-v1",
        "judge_version": JUDGE_VERSION,
        "created_at_utc": utc_now(),
        "provider": provider,
        "model": model,
        "summary": {
            "total_tasks": len(results),
            "total_rubrics_judged": len(judged),
            "rubric_errors": rubric_errors,
            "average_rubric_score": round(sum(judged) / len(judged), 4) if judged else None,
            "perfect_tasks": perfect,
            "perfect_task_rate": round(perfect / len(results), 4) if results else 0,
            "errored_tasks": sum(1 for result in results if result.get("error")),
        },
        "tasks": list(results),
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    load_env_file(args.env_file)
    task_index = load_task_index(args.task_source_json.resolve())
    run_dirs = discover_runs(args.runs_dir.resolve(), args.include_incomplete)
    if not run_dirs:
        raise JudgeError("no eligible trajectory runs found")
    assignments = validate_assignments(run_dirs, task_index)
    provider = resolve_provider(args.model, args.provider)
    if args.plan:
        return {
            "schema_version": "apollo-full-trajectory-judge-plan-v1",
            "judge_version": JUDGE_VERSION,
            "provider": provider,
            "model": args.model,
            "runs": len(assignments),
            "rubrics": sum(len(task.rubrics) for _, task in assignments),
            "output": str(args.output.resolve()),
        }

    client = make_client(provider)
    input_hashes = {
        str(run_dir.resolve()): assignment_hash(run_dir, task)
        for run_dir, task in assignments
    }
    existing = load_completed(args.output, provider, args.model)
    pending = [
        (run_dir, task)
        for run_dir, task in assignments
        if str(run_dir.resolve()) not in existing
        or existing[str(run_dir.resolve())].get("input_sha256") != input_hashes[str(run_dir.resolve())]
    ]
    semaphore = asyncio.Semaphore(max(1, min(args.num_workers, len(pending) or 1)))

    async def one(run_dir: Path, task: TaskSpec) -> dict[str, Any]:
        async with semaphore:
            return await evaluate_run(
                run_dir, task, client, provider, args.model,
                args.max_images, args.max_steps, args.max_history_chars,
                input_hashes[str(run_dir.resolve())],
            )

    completed: dict[str, dict[str, Any]] = dict(existing)
    futures = [asyncio.create_task(one(run_dir, task)) for run_dir, task in pending]
    for position, future in enumerate(asyncio.as_completed(futures), start=1):
        result = await future
        completed[str(Path(result["run_dir"]).resolve())] = result
        ordered = [completed[str(run_dir.resolve())] for run_dir, _ in assignments if str(run_dir.resolve()) in completed]
        atomic_write_json(args.output, build_payload(ordered, provider, args.model))
        print(f"Judged {position}/{len(pending)} pending run(s): {result['task_id']}", flush=True)

    ordered = [completed[str(run_dir.resolve())] for run_dir, _ in assignments]
    payload = build_payload(ordered, provider, args.model)
    atomic_write_json(args.output, payload)
    return payload


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Judge every rubric against full trajectory evidence.")
    value.add_argument("--runs-dir", type=Path, required=True)
    value.add_argument("--task-source-json", type=Path, required=True)
    value.add_argument("--output", type=Path, default=Path(".work/trajectory_review/eval_results_full_traj_per_rubric.json"))
    value.add_argument("--provider", choices=("auto", "gemini", "openai"), default="auto")
    value.add_argument("--model", default=DEFAULT_MODEL)
    value.add_argument("--env-file", type=Path, default=None)
    value.add_argument("--num-workers", type=int, default=4)
    value.add_argument("--max-images", type=int, default=DEFAULT_MAX_IMAGES, help="Last N screenshots; 0 keeps all")
    value.add_argument("--max-steps", type=int, default=0, help="First N normalized steps; 0 keeps all")
    value.add_argument("--max-history-chars", type=int, default=DEFAULT_MAX_HISTORY_CHARS)
    value.add_argument("--include-incomplete", action="store_true")
    value.add_argument("--plan", action="store_true", help="Validate assignments without invoking a model")
    return value


def main() -> None:
    args = parser().parse_args()
    try:
        payload = asyncio.run(run(args))
    except (OSError, json.JSONDecodeError, JudgeError) as exc:
        raise SystemExit(f"error: {exc}") from exc
    print(json.dumps(payload if args.plan else payload["summary"], indent=2))
    if not args.plan and (payload["summary"]["errored_tasks"] or payload["summary"]["rubric_errors"]):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
