#!/usr/bin/env python3
"""Prepare Odysseys trajectory-judge output for Apollo human review.

The upstream evaluator intentionally writes only ``run_dir`` plus rubric
scores/reasoning.  Apollo's reviewer also needs the action stream and visual
evidence, so this script joins the evaluator JSON with each run's
``steps.jsonl`` or ``traj.jsonl`` and emits immutable, portable packages.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import re
import shutil
import random
import subprocess
import time
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


SCHEMA_VERSION = "apollo-trajectory-review-package-v1"
QUEUE_ROOTS = {
    "v2": ("v2-review/trajectory-runs", "v2-review/trajectory-inbox"),
    "pc": ("pc-review/trajectory-runs", "pc-review/trajectory-inbox"),
}
MAX_STEPS = 500
MAX_PACKAGE_BYTES = 4_000_000


class PackageError(ValueError):
    pass


def task_belongs_to_queue(task_id: str, queue: str) -> bool:
    """Keep PC packages out of v2 and all non-PC packages out of PC."""
    is_pc = str(task_id).startswith(("pc_", "pc/"))
    return is_pc if queue == "pc" else not is_pc


VALID_PID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")


def creator_pid_for(task_result: dict[str, Any], task_id: str, override: str = "") -> str:
    """Resolve the Apollo author used for creator-only trajectory grading."""
    candidates = [
        override,
        task_result.get("creator_pid"),
        task_result.get("participant_id"),
        task_result.get("author_pid"),
    ]
    match = re.match(r"^(?:v2|pc)/([^/]+)/", task_id)
    if match:
        candidates.append(match.group(1))
    for value in candidates:
        pid = _text(value, 80).lower()
        if VALID_PID.fullmatch(pid):
            return pid
    raise PackageError(
        f"creator_pid is required for task {task_id}; use an Apollo task ID or provide --creator-map"
    )


def _text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _append_unique(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise PackageError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
            if not isinstance(value, dict):
                raise PackageError(f"{path}:{line_number}: expected a JSON object")
            rows.append(value)
    return rows


def _step_number(row: dict[str, Any], fallback: int) -> int:
    try:
        return int(row.get("step_num", fallback) or fallback)
    except (TypeError, ValueError):
        return fallback


def load_steps(run_dir: Path) -> tuple[list[dict[str, Any]], Path]:
    """Normalize both trajectory formats used by run_full_trajectory_per_rubric.py."""
    steps_path = run_dir / "steps.jsonl"
    traj_path = run_dir / "traj.jsonl"
    if steps_path.is_file():
        source_path = steps_path
        source_kind = "steps.jsonl"
    elif traj_path.is_file():
        source_path = traj_path
        source_kind = "traj.jsonl"
    else:
        raise PackageError(f"No steps.jsonl or traj.jsonl found in {run_dir}")

    grouped: dict[int, dict[str, Any]] = {}
    rows = _read_jsonl(source_path)
    start = 0 if source_kind == "steps.jsonl" else 1
    for offset, row in enumerate(rows, start=start):
        number = _step_number(row, offset)
        step = grouped.setdefault(number, {
            "step_number": number,
            "actions": [],
            "responses": [],
            "screenshot_source": None,
            "final": False,
        })
        screenshot = row.get("screenshot") or row.get("screenshot_file")
        if screenshot and (source_kind == "steps.jsonl" or not step["screenshot_source"]):
            step["screenshot_source"] = str(screenshot)

        response = _text(row.get("response"), 50_000)
        _append_unique(step["responses"], response)

        action = row.get("action")
        is_screenshot = False
        action_text = ""
        if source_kind == "steps.jsonl":
            action_text = _text(action, 20_000)
            if action_text.lower() == "screenshot":
                action_text = ""
            arguments = row.get("arguments")
            if action_text and isinstance(arguments, dict):
                safe_arguments = {key: value for key, value in arguments.items() if key != "action"}
                if safe_arguments:
                    action_text = f"{action_text} {json.dumps(safe_arguments, ensure_ascii=False, sort_keys=True)}"
            if not action_text:
                action_text = _text(row.get("action_line"), 20_000)
                if action_text.replace(" ", "") == '{"type":"screenshot"}':
                    action_text = ""
        elif isinstance(action, dict):
            action_text = _text(action.get("command") or action.get("action"), 20_000)
            action_input = action.get("input")
            is_screenshot = isinstance(action_input, dict) and str(action_input.get("action", "")).lower() == "screenshot"
        else:
            action_text = _text(action, 20_000)
        if not is_screenshot:
            _append_unique(step["actions"], action_text)
        step["final"] = bool(step["final"] or row.get("final") is True)

    return [grouped[key] for key in sorted(grouped)], source_path


def resolve_screenshot(run_dir: Path, raw_value: str | None) -> Path | None:
    if not raw_value:
        return None
    raw = Path(raw_value).expanduser()
    candidates = [raw] if raw.is_absolute() else [run_dir / raw.name, run_dir / raw, raw]
    return next((candidate.resolve() for candidate in candidates if candidate.is_file()), None)


def _sha256_chunks(chunks: Iterable[bytes]) -> str:
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk)
    return digest.hexdigest()


def _encoded(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def _safe_rubrics(task_result: dict[str, Any]) -> list[dict[str, Any]]:
    raw = task_result.get("rubric_results")
    if not isinstance(raw, list):
        raise PackageError("rubric_results must be an array")
    rubrics = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise PackageError(f"rubric_results[{index}] must be an object")
        rubric_id = _text(item.get("rubric_id") or f"rubric-{index + 1}", 100)
        requirement = _text(item.get("requirement"), 30_000)
        if not requirement:
            raise PackageError(f"rubric_results[{index}].requirement is required")
        raw_status = _text(item.get("judge_status"), 20).upper()
        if raw_status not in {"SUCCESS", "FAILURE", "ERROR"}:
            raw_status = "SUCCESS" if item.get("success") is True or item.get("score") == 1 else "FAILURE"
        score = None if raw_status == "ERROR" else (1 if raw_status == "SUCCESS" else 0)
        rubrics.append({
            "rubric_id": rubric_id,
            "requirement": requirement,
            "verification": _text(item.get("verification"), 20_000),
            "llm_status": raw_status,
            "llm_score": score,
            "llm_success": None if score is None else score == 1,
            "llm_reasoning": _text(item.get("final_reasoning"), 30_000),
        })
    if not rubrics:
        raise PackageError("At least one rubric_result is required")
    return rubrics


def prepare_one(
    task_result: dict[str, Any],
    eval_path: Path,
    output_root: Path,
    runs_root: Path | None = None,
    *,
    agent: str = "",
    model: str = "",
    run_label: str = "",
    creator_pid: str = "",
) -> tuple[Path, dict[str, Any]]:
    task_id = _text(task_result.get("task_id"), 300)
    prompt = _text(task_result.get("task"), 200_000)
    run_value = _text(task_result.get("run_dir"), 10_000)
    if not task_id or not prompt or not run_value:
        raise PackageError("task_id, task, and run_dir are required")
    resolved_creator_pid = creator_pid_for(task_result, task_id, creator_pid)
    raw_run_dir = Path(run_value).expanduser()
    candidates = [raw_run_dir] if raw_run_dir.is_absolute() else [
        (runs_root / raw_run_dir) if runs_root else None,
        eval_path.parent / raw_run_dir,
        raw_run_dir,
    ]
    run_dir = next((candidate.resolve() for candidate in candidates if candidate and candidate.is_dir()), None)
    if run_dir is None:
        raise PackageError(f"run_dir does not exist: {run_value}")

    steps, trajectory_path = load_steps(run_dir)
    if not steps:
        raise PackageError("Trajectory contains no steps")
    if len(steps) > MAX_STEPS:
        raise PackageError(f"Trajectory has {len(steps)} steps; the review package limit is {MAX_STEPS}")
    rubrics = _safe_rubrics(task_result)
    # The same immutable run may be mounted at a different absolute path on a
    # second worker.  Keep the package ID content-addressed rather than
    # machine-addressed so retries cannot enqueue duplicates.
    fingerprint_result = {**task_result, "run_dir": run_dir.name}
    fingerprint_result["apollo_run_metadata"] = {
        "agent": _text(agent, 120),
        "model": _text(model, 160),
        "run_label": _text(run_label, 240),
        "creator_pid": resolved_creator_pid,
    }
    normalized_result = json.dumps(fingerprint_result, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    evidence_chunks = [normalized_result, trajectory_path.read_bytes()]
    seen_screenshots: set[Path] = set()
    for step in steps:
        screenshot = resolve_screenshot(run_dir, step.get("screenshot_source"))
        if screenshot and screenshot not in seen_screenshots:
            seen_screenshots.add(screenshot)
            evidence_chunks.extend([screenshot.name.encode("utf-8"), screenshot.read_bytes()])
    source_hash = _sha256_chunks(evidence_chunks)
    run_id = source_hash[:24]
    package_dir = output_root / _encoded(task_id) / run_id
    screens_dir = package_dir / "screens"
    package_dir.mkdir(parents=True, exist_ok=True)

    normalized_steps = []
    for index, step in enumerate(steps):
        screenshot = resolve_screenshot(run_dir, step.pop("screenshot_source", None))
        asset_path = None
        if screenshot:
            suffix = screenshot.suffix.lower() if screenshot.suffix else ".png"
            if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
                suffix = mimetypes.guess_extension(mimetypes.guess_type(screenshot.name)[0] or "image/png") or ".png"
            screens_dir.mkdir(parents=True, exist_ok=True)
            destination = screens_dir / f"{index + 1:05d}{suffix}"
            if not destination.exists() or destination.read_bytes() != screenshot.read_bytes():
                shutil.copyfile(screenshot, destination)
            asset_path = destination.relative_to(package_dir).as_posix()
        normalized_steps.append({
            "index": index,
            "step_number": step["step_number"],
            "action": " -> ".join(step["actions"]),
            "response": "\n\n".join(step["responses"]),
            "final": bool(step["final"]),
            "screenshot_path": asset_path,
        })

    llm_scores = [rubric["llm_score"] for rubric in rubrics if rubric["llm_score"] is not None]
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "task_id": task_id,
        "creator_pid": resolved_creator_pid,
        "task_prompt": prompt,
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {
            "evaluator_format": "run_full_trajectory_per_rubric.py",
            "source_result_sha256": source_hash,
            "run_directory_name": run_dir.name,
            "trajectory_filename": trajectory_path.name,
            "agent": _text(agent, 120) or None,
            "model": _text(model, 160) or None,
            "run_label": _text(run_label, 240) or None,
        },
        "metrics": {
            "num_steps": len(normalized_steps),
            "num_screenshots": sum(step["screenshot_path"] is not None for step in normalized_steps),
            "average_rubric_score": round(sum(llm_scores) / len(llm_scores), 4) if llm_scores else 0.0,
            "perfect": len(llm_scores) == len(rubrics) and all(score == 1 for score in llm_scores),
            "judge_errors": sum(rubric["llm_status"] == "ERROR" for rubric in rubrics),
        },
        "rubrics": rubrics,
        "steps": normalized_steps,
    }
    validate_manifest(manifest)
    manifest_path = package_dir / "manifest.json"
    serialized = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    if len(serialized.encode("utf-8")) > MAX_PACKAGE_BYTES:
        raise PackageError(f"Review manifest exceeds the {MAX_PACKAGE_BYTES}-byte limit")
    manifest_path.write_text(serialized, encoding="utf-8")
    return manifest_path, manifest


def validate_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        raise PackageError(f"schema_version must be {SCHEMA_VERSION}")
    for field in ("run_id", "task_id", "task_prompt", "creator_pid"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise PackageError(f"{field} is required")
    if not VALID_PID.fullmatch(value["creator_pid"]):
        raise PackageError("creator_pid must be a valid Apollo participant id")
    rubrics = value.get("rubrics")
    steps = value.get("steps")
    if not isinstance(rubrics, list) or not rubrics:
        raise PackageError("rubrics must be a non-empty array")
    if not isinstance(steps, list) or not steps:
        raise PackageError("steps must be a non-empty array")
    if len(rubrics) > 100:
        raise PackageError("rubrics exceeds the 100-item limit")
    if len(steps) > MAX_STEPS:
        raise PackageError(f"steps exceeds the {MAX_STEPS}-item limit")
    rubric_ids = [rubric.get("rubric_id") for rubric in rubrics if isinstance(rubric, dict)]
    if len(rubric_ids) != len(rubrics) or len(set(rubric_ids)) != len(rubric_ids):
        raise PackageError("rubric IDs must be present and unique")
    for rubric in rubrics:
        status = rubric.get("llm_status")
        score = rubric.get("llm_score")
        success = rubric.get("llm_success")
        if status not in {"SUCCESS", "FAILURE", "ERROR"}:
            raise PackageError("rubric llm_status is invalid")
        if status == "ERROR" and (score is not None or success is not None):
            raise PackageError("an errored rubric cannot expose a score")
        if status != "ERROR" and (score not in {0, 1} or success is not (score == 1)):
            raise PackageError("rubric LLM status and score are inconsistent")
    for index, step in enumerate(steps):
        if not isinstance(step, dict) or step.get("index") != index:
            raise PackageError("step indices must be contiguous and zero-based")
        screenshot_path = step.get("screenshot_path")
        if screenshot_path is not None and (not isinstance(screenshot_path, str) or screenshot_path.startswith("/") or ".." in Path(screenshot_path).parts):
            raise PackageError("screenshot_path must be package-relative")
    return value


def put_object_if_absent(
    source: Path,
    bucket: str,
    key: str,
    *,
    content_type: str,
    aws_cli: str = "aws",
) -> bool:
    """Create an immutable object, treating an existing content-addressed key as idempotent."""
    result = subprocess.run([
        aws_cli, "s3api", "put-object",
        "--bucket", bucket,
        "--key", key,
        "--body", str(source),
        "--content-type", content_type,
        "--if-none-match", "*",
    ], check=False, capture_output=True, text=True)
    if result.returncode == 0:
        return True
    error = f"{result.stdout}\n{result.stderr}"
    if "PreconditionFailed" in error or "status code: 412" in error or "(412)" in error:
        return False
    raise subprocess.CalledProcessError(result.returncode, result.args, output=result.stdout, stderr=result.stderr)


def run_aws_with_retry(
    command: Sequence[str],
    *,
    attempts: int = 4,
    delay: float = 5.0,
    stdout: Any = None,
) -> None:
    """Run an AWS CLI command, retrying transient failures.

    A whole batch used to be lost when one `s3 cp` hit throttling or a network
    blip: every task in it was skipped and the queue worker stopped. S3 writes
    here are idempotent (content-addressed keys), so retrying is safe.
    """
    last: subprocess.CalledProcessError | None = None
    for attempt in range(attempts):
        result = subprocess.run(
            list(command), check=False, capture_output=stdout is None, text=True
        )
        if result.returncode == 0:
            return
        last = subprocess.CalledProcessError(
            result.returncode, result.args,
            output=getattr(result, "stdout", None), stderr=getattr(result, "stderr", None),
        )
        if attempt + 1 < attempts:
            time.sleep(delay * (2**attempt) + random.uniform(0.0, 2.0))
    detail = (getattr(last, "stderr", "") or "").strip()[-500:]
    raise PackageError(
        f"AWS command failed after {attempts} attempts: {' '.join(command[:4])}…"
        + (f"; stderr: {detail}" if detail else "")
    )


def upload_package(
    manifest_path: Path,
    manifest: dict[str, Any],
    bucket: str,
    aws_cli: str = "aws",
    *,
    queue: str = "v2",
) -> str:
    package_dir = manifest_path.parent
    task_id = manifest["task_id"]
    creator_pid = _text(manifest.get("creator_pid"), 80).lower()
    if not VALID_PID.fullmatch(creator_pid):
        raise PackageError("creator_pid is required before a trajectory can be queued")
    run_id = manifest["run_id"]
    if not task_belongs_to_queue(task_id, queue):
        raise PackageError(f"Task {task_id} does not belong to the {queue} trajectory queue")
    try:
        s3_root, inbox_root = QUEUE_ROOTS[queue]
    except KeyError as exc:
        raise PackageError(f"Unknown trajectory queue: {queue}") from exc
    s3_prefix = f"{s3_root}/{_encoded(task_id)}/{run_id}"
    screens_dir = package_dir / "screens"
    if screens_dir.is_dir():
        run_aws_with_retry([
            aws_cli, "s3", "cp", str(screens_dir), f"s3://{bucket}/{s3_prefix}/screens/",
            "--recursive", "--only-show-errors",
        ])
    manifest_key = f"{s3_prefix}/manifest.json"
    put_object_if_absent(
        manifest_path,
        bucket,
        manifest_key,
        content_type="application/json",
        aws_cli=aws_cli,
    )
    marker_key = f"{inbox_root}/{creator_pid}/{_encoded(manifest_key)}"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8") as marker:
        marker.write(manifest_key)
        marker.flush()
        run_aws_with_retry([
            aws_cli, "s3api", "put-object", "--bucket", bucket, "--key", marker_key,
            "--body", marker.name, "--content-type", "text/plain",
        ], stdout=subprocess.DEVNULL)
    return manifest_key


def select_task_results(
    tasks: list[Any],
    task_ids: list[str] | None = None,
    limit: int | None = None,
) -> list[Any]:
    """Select a deterministic experiment batch without editing evaluator output."""
    wanted = {value.strip() for value in (task_ids or []) if value.strip()}
    selected = [
        item for item in tasks
        if not wanted or (isinstance(item, dict) and str(item.get("task_id") or "").strip() in wanted)
    ]
    if wanted:
        found = {
            str(item.get("task_id") or "").strip()
            for item in selected
            if isinstance(item, dict)
        }
        missing = sorted(wanted - found)
        if missing:
            raise PackageError(f"Requested task IDs were not found: {', '.join(missing)}")
    if limit is not None:
        if limit < 1:
            raise PackageError("limit must be at least 1")
        selected = selected[:limit]
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare Odysseys judge output for Apollo's human trajectory-review queue.")
    parser.add_argument("--eval-results", type=Path, required=True, help="eval_results_full_traj_per_rubric.json")
    parser.add_argument("--output-dir", type=Path, default=Path(".work/trajectory_review"))
    parser.add_argument("--runs-root", type=Path, default=None, help="Optional base for relative run_dir values")
    parser.add_argument("--s3-bucket", default=None, help="Upload packages and enqueue them after local validation")
    parser.add_argument(
        "--queue",
        choices=tuple(QUEUE_ROOTS),
        default="v2",
        help="Human grading queue and S3 prefix family (use pc for Apollo PC trajectories)",
    )
    parser.add_argument("--aws-cli", default="aws")
    parser.add_argument(
        "--task-id",
        action="append",
        default=[],
        help="Prepare only this exact task ID; repeat for a small experiment batch",
    )
    parser.add_argument("--limit", type=int, default=None, help="Prepare at most this many selected tasks")
    parser.add_argument("--agent", default="", help="Agent or runner name shown to human graders")
    parser.add_argument("--model", default="", help="Model name shown to human graders")
    parser.add_argument("--run-label", default="", help="Optional experiment or evaluation label")
    parser.add_argument(
        "--creator-map",
        type=Path,
        default=None,
        help="JSON object mapping task_id to the original Apollo creator participant id",
    )
    args = parser.parse_args()

    eval_path = args.eval_results.expanduser().resolve()
    raw = json.loads(eval_path.read_text(encoding="utf-8"))
    tasks = raw.get("tasks") if isinstance(raw, dict) else None
    if not isinstance(tasks, list):
        raise SystemExit("Evaluation file must contain a tasks array")
    try:
        tasks = select_task_results(tasks, args.task_id, args.limit)
    except PackageError as exc:
        raise SystemExit(str(exc)) from exc

    creator_map: dict[str, str] = {}
    if args.creator_map:
        raw_map = json.loads(args.creator_map.expanduser().read_text(encoding="utf-8"))
        if not isinstance(raw_map, dict):
            raise SystemExit("--creator-map must contain a JSON object")
        creator_map = {str(key): str(value) for key, value in raw_map.items()}

    prepared: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for index, task_result in enumerate(tasks):
        if not isinstance(task_result, dict):
            skipped.append({"index": str(index), "reason": "task result is not an object"})
            continue
        try:
            manifest_path, manifest = prepare_one(
                task_result,
                eval_path,
                args.output_dir.resolve(),
                args.runs_root,
                agent=args.agent,
                model=args.model,
                run_label=args.run_label,
                creator_pid=creator_map.get(_text(task_result.get("task_id"), 300), ""),
            )
            if not task_belongs_to_queue(manifest["task_id"], args.queue):
                raise PackageError(f"Task {manifest['task_id']} does not belong to the {args.queue} trajectory queue")
            manifest_key = upload_package(
                manifest_path,
                manifest,
                args.s3_bucket,
                args.aws_cli,
                queue=args.queue,
            ) if args.s3_bucket else None
            prepared.append({
                "task_id": manifest["task_id"],
                "run_id": manifest["run_id"],
                "creator_pid": manifest["creator_pid"],
                "manifest_path": str(manifest_path),
                "manifest_key": manifest_key,
            })
        except (OSError, PackageError, subprocess.CalledProcessError) as exc:
            skipped.append({"index": str(index), "task_id": _text(task_result.get("task_id"), 300), "reason": str(exc)})

    summary = {
        "schema_version": "apollo-trajectory-prepare-summary-v1",
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "queue": args.queue,
        "prepared": prepared,
        "skipped": skipped,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = args.output_dir / "prepare-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"prepared": len(prepared), "skipped": len(skipped), "summary": str(summary_path)}, indent=2))
    if skipped:
        for item in skipped:
            print(f"SKIP {item.get('task_id') or item['index']}: {item['reason']}")
    if not prepared:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
