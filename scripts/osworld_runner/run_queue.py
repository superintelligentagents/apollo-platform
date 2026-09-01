#!/usr/bin/env python3
"""Run Apollo's approved OSWorld queue in verified, resumable batches.

The worker intentionally stops on the first failed batch or when free disk drops
below the configured floor. A successful batch is judged, uploaded, verified in
S3 and the reporting API, and then reduced to its small audit artifacts before
the next batch starts.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.osworld_runner.run import (
    DEFAULT_APIS,
    DEFAULT_DOCKER_VM_PATH,
    DEFAULT_META_SESSION_ID,
    DEFAULT_OSWORLD_ROOT,
    fetch_reporting_tasks,
    fetch_trajectory_task_ids,
    get_json,
    select_tasks,
    trajectory_reporting_url,
    write_private_json,
)


class QueueRunError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def disk_free_gib(path: Path) -> float:
    return shutil.disk_usage(path).free / (1024**3)


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def log(message: str) -> None:
    print(f"[{utc_now()}] {message}", flush=True)


def run_command(command: Sequence[str], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("ab") as handle:
        handle.write(("\n$ " + " ".join(command) + "\n").encode())
        handle.flush()
        result = subprocess.run(
            list(command),
            stdout=handle,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if result.returncode:
        raise QueueRunError(
            f"command exited {result.returncode}; inspect {output}"
        )


def available_tasks(
    queue: str,
    token: str,
    *,
    shard_count: int,
    shard_index: int,
) -> tuple[int, int]:
    api_url = DEFAULT_APIS[queue]
    tasks = fetch_reporting_tasks(api_url, token)
    existing = fetch_trajectory_task_ids(api_url, token)
    selected, _ = select_tasks(
        tasks,
        queue=queue,
        limit=max(1, len(tasks)),
        include_existing=False,
        existing_task_ids=existing,
        shard_count=shard_count,
        shard_index=shard_index,
    )
    return len(selected), len(existing)


def reporting_rows(queue: str, token: str) -> list[Mapping[str, Any]]:
    api_url = DEFAULT_APIS[queue]
    rows: list[Mapping[str, Any]] = []
    offset = 0
    seen: set[int] = set()
    while True:
        if offset in seen:
            raise QueueRunError("trajectory reporting API returned a paging loop")
        seen.add(offset)
        page = get_json(
            trajectory_reporting_url(api_url, offset=offset, limit=1_000),
            token,
        )
        items = page.get("trajectories")
        if not isinstance(items, list):
            raise QueueRunError("trajectory reporting response lacks trajectories[]")
        rows.extend(item for item in items if isinstance(item, Mapping))
        page_info = page.get("page") if isinstance(page.get("page"), Mapping) else {}
        next_offset = page_info.get("next_offset")
        if next_offset is None:
            return rows
        offset = int(next_offset)


def aws_json(arguments: Sequence[str]) -> Mapping[str, Any]:
    result = subprocess.run(
        ["aws", *arguments, "--output", "json"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    value = json.loads(result.stdout)
    if not isinstance(value, Mapping):
        raise QueueRunError(f"AWS returned a non-object for {' '.join(arguments)}")
    return value


def inbox_marker(creator_pid: str, manifest_key: str, queue: str) -> str:
    encoded = base64.urlsafe_b64encode(manifest_key.encode()).decode().rstrip("=")
    prefix = "pc-review" if queue == "pc" else "v2-review"
    return f"{prefix}/trajectory-inbox/{creator_pid}/{encoded}"


def verify_batch(
    batch_dir: Path,
    *,
    bucket: str,
    queue: str,
    token: str,
    reporting_attempts: int,
    reporting_delay: float,
) -> list[dict[str, Any]]:
    job = read_json(batch_dir / "job.json")
    summary = read_json(batch_dir / "trajectory_review/prepare-summary.json")
    task_ids = set(job.get("task_ids") or [])
    prepared = summary.get("prepared")
    if not isinstance(prepared, list):
        raise QueueRunError("trajectory prepare summary lacks prepared[]")
    if not prepared:
        raise QueueRunError(
            f"prepared 0 trajectories for {len(task_ids)} tasks"
        )

    verified: list[dict[str, Any]] = []
    wanted_runs: set[tuple[str, str]] = set()
    prepared_task_ids: set[str] = set()
    for item in prepared:
        task_id = str(item.get("task_id") or "")
        run_id = str(item.get("run_id") or "")
        manifest_key = str(item.get("manifest_key") or "")
        creator_pid = str(item.get("creator_pid") or "")
        manifest_path = Path(str(item.get("manifest_path") or ""))
        if task_id not in task_ids or not all((run_id, manifest_key, creator_pid)):
            raise QueueRunError(f"invalid prepared entry for {task_id or '<missing>'}")
        if task_id in prepared_task_ids:
            raise QueueRunError(f"duplicate prepared entry for {task_id}")
        prepared_task_ids.add(task_id)
        manifest = read_json(manifest_path)
        metrics = manifest.get("metrics") if isinstance(manifest.get("metrics"), Mapping) else {}
        steps = int(metrics.get("num_steps", -1))
        prefix = manifest_key.rsplit("/", 1)[0] + "/"
        objects = aws_json(
            ["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix]
        ).get("Contents", [])
        if len(objects) != steps + 1:
            raise QueueRunError(
                f"{task_id} has {len(objects)} S3 objects; expected {steps + 1}"
            )
        subprocess.run(
            [
                "aws",
                "s3api",
                "head-object",
                "--bucket",
                bucket,
                "--key",
                inbox_marker(creator_pid, manifest_key, queue),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        wanted_runs.add((task_id, run_id))
        verified.append(
            {
                "task_id": task_id,
                "run_id": run_id,
                "status": "pending",
                "num_steps": steps,
                "average_rubric_score": metrics.get("average_rubric_score"),
                "judge_errors": metrics.get("judge_errors"),
                "s3_objects": len(objects),
                "manifest_key": manifest_key,
            }
        )

    found: set[tuple[str, str]] = set()
    for attempt in range(reporting_attempts):
        rows = reporting_rows(queue, token)
        found = {
            (str(row.get("task_id") or ""), str(row.get("run_id") or ""))
            for row in rows
        }
        if wanted_runs <= found:
            return verified
        if attempt + 1 < reporting_attempts:
            time.sleep(reporting_delay)
    missing = sorted(wanted_runs - found)
    raise QueueRunError(f"reporting API did not index run(s): {missing}")


def batch_verification_record(
    batch_dir: Path,
    verified: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    job = read_json(batch_dir / "job.json")
    requested = {str(task_id) for task_id in job.get("task_ids") or []}
    published = {str(run.get("task_id") or "") for run in verified}
    return {
        "runs": list(verified),
        "requested_task_count": len(requested),
        "published_task_count": len(published),
        "failed_task_ids": sorted(requested - published),
    }


def record_completed_batch(
    state: dict[str, Any],
    batch_dir: Path,
    verified: Sequence[Mapping[str, Any]],
) -> None:
    known_runs = {
        (str(run.get("task_id") or ""), str(run.get("run_id") or ""))
        for run in state.get("runs") or []
        if isinstance(run, Mapping)
    }
    new_runs = [
        dict(run)
        for run in verified
        if (str(run.get("task_id") or ""), str(run.get("run_id") or ""))
        not in known_runs
    ]
    state["batches_completed"] += 1
    state["tasks_published"] += len(new_runs)
    state["runs"].extend(new_runs)
    state["last_batch"] = str(batch_dir)
    state["updated_at_utc"] = utc_now()


def recover_published_batches(
    root: Path,
    state: dict[str, Any],
    *,
    bucket: str,
    queue: str,
    token: str,
    reporting_attempts: int,
    reporting_delay: float,
) -> None:
    """Finish verification for a publish that outlived its queue worker."""
    for batch_dir in sorted(root.glob("batch-[0-9][0-9][0-9][0-9][0-9][0-9]")):
        if (batch_dir / "verified.json").exists():
            continue
        if not (batch_dir / "job.json").exists():
            continue
        if not (batch_dir / "trajectory_review/prepare-summary.json").exists():
            continue
        verified = verify_batch(
            batch_dir,
            bucket=bucket,
            queue=queue,
            token=token,
            reporting_attempts=reporting_attempts,
            reporting_delay=reporting_delay,
        )
        record = batch_verification_record(batch_dir, verified)
        write_private_json(batch_dir / "verified.json", record)
        compact_batch(batch_dir)
        record_completed_batch(state, batch_dir, verified)
        write_private_json(root / "queue-state.json", state)
        log(
            f"recovered {batch_dir.name}: published {len(verified)} of "
            f"{record['requested_task_count']}; total published "
            f"{state['tasks_published']}"
        )


def compact_batch(batch_dir: Path) -> None:
    """Delete only uploaded bulk artifacts while retaining the audit record."""
    bulk_paths = [batch_dir / "results", batch_dir / "logs", batch_dir / "command.log"]
    bulk_paths.extend((batch_dir / "trajectory_review").glob("*/*/screens"))
    for path in bulk_paths:
        if not path.exists():
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def command_base(args: argparse.Namespace, batch_dir: Path) -> list[str]:
    return [
        sys.executable,
        str(Path(__file__).resolve().with_name("run.py")),
        "--queue", args.queue,
        "--work-dir", str(batch_dir),
        "--max-steps", str(args.max_steps),
        "--max-trajectory-length", str(args.max_trajectory_length),
        "--request-timeout", str(args.request_timeout),
        "--max-retries", str(args.max_retries),
        "--s3-bucket", args.s3_bucket,
        "--osworld-root", str(args.osworld_root),
        "--provider-name", args.provider_name,
        "--path-to-vm", str(args.path_to_vm),
        "--meta-session-id", args.meta_session_id,
        "--shard-count", str(args.shard_count),
        "--shard-index", str(args.shard_index),
    ]


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--queue", choices=("v2", "pc"), default="v2")
    value.add_argument("--batch-size", type=int, default=3)
    value.add_argument("--num-envs", type=int, default=3)
    value.add_argument("--judge-workers", type=int, default=3)
    value.add_argument("--max-steps", type=int, default=120)
    value.add_argument("--max-trajectory-length", type=int, default=120)
    value.add_argument("--request-timeout", type=float, default=600.0)
    value.add_argument("--max-retries", type=int, default=3)
    value.add_argument("--min-free-gib", type=float, default=35.0)
    value.add_argument("--work-root", type=Path, required=True)
    value.add_argument("--s3-bucket", default="journeys-prolific")
    value.add_argument("--osworld-root", type=Path, default=DEFAULT_OSWORLD_ROOT)
    value.add_argument("--provider-name", choices=("vmware", "docker", "aws"), default="docker")
    value.add_argument("--path-to-vm", type=Path, default=DEFAULT_DOCKER_VM_PATH)
    value.add_argument("--meta-session-id", default=DEFAULT_META_SESSION_ID)
    value.add_argument("--shard-count", type=int, default=1)
    value.add_argument("--shard-index", type=int, default=0)
    value.add_argument("--max-batches", type=int, default=0)
    value.add_argument("--reporting-attempts", type=int, default=12)
    value.add_argument("--reporting-delay", type=float, default=5.0)
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if min(args.batch_size, args.num_envs, args.judge_workers) < 1:
        raise SystemExit("batch size, environments, and judge workers must be positive")
    if args.shard_count < 1 or args.shard_index < 0 or args.shard_index >= args.shard_count:
        raise SystemExit("shard index must be between 0 and shard-count - 1")
    token = os.environ.get("APOLLO_REPORTING_TOKEN", "").strip()
    meta_key = os.environ.get("MUSE_SPARK_API_KEY", "").strip()
    if not token or not meta_key:
        raise SystemExit("APOLLO_REPORTING_TOKEN and MUSE_SPARK_API_KEY are required")

    root = args.work_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock_handle = (root / ".lock").open("a+")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        raise SystemExit(f"another queue worker holds {root / '.lock'}") from exc
    state_path = root / "queue-state.json"
    if state_path.exists():
        loaded = read_json(state_path)
        if not isinstance(loaded, dict) or loaded.get("queue") != args.queue:
            raise SystemExit(f"invalid or mismatched queue state: {state_path}")
        if int(loaded.get("shard_count", args.shard_count)) != args.shard_count:
            raise SystemExit(f"shard-count does not match queue state: {state_path}")
        if int(loaded.get("shard_index", args.shard_index)) != args.shard_index:
            raise SystemExit(f"shard-index does not match queue state: {state_path}")
        state = loaded
        state["status"] = "running"
        state.pop("stop_reason", None)
        state["updated_at_utc"] = utc_now()
    else:
        state = {
            "schema_version": "apollo-osworld-queue-v1",
            "status": "running",
            "started_at_utc": utc_now(),
            "updated_at_utc": utc_now(),
            "queue": args.queue,
            "batch_size": args.batch_size,
            "num_envs": args.num_envs,
            "judge_workers": args.judge_workers,
            "batches_completed": 0,
            "tasks_published": 0,
            "runs": [],
            "shard_count": args.shard_count,
            "shard_index": args.shard_index,
        }
    state["batch_size"] = args.batch_size
    state["num_envs"] = args.num_envs
    state["judge_workers"] = args.judge_workers
    state["shard_count"] = args.shard_count
    state["shard_index"] = args.shard_index
    write_private_json(state_path, state)

    try:
        recover_published_batches(
            root,
            state,
            bucket=args.s3_bucket,
            queue=args.queue,
            token=token,
            reporting_attempts=args.reporting_attempts,
            reporting_delay=args.reporting_delay,
        )
        while not args.max_batches or state["batches_completed"] < args.max_batches:
            free_gib = disk_free_gib(root)
            if free_gib < args.min_free_gib:
                state["status"] = "low_disk"
                state["stop_reason"] = (
                    f"{free_gib:.1f} GiB free is below {args.min_free_gib:.1f} GiB floor"
                )
                log(state["stop_reason"])
                break

            remaining, existing = available_tasks(
                args.queue,
                token,
                shard_count=args.shard_count,
                shard_index=args.shard_index,
            )
            state["remaining_runnable"] = remaining
            state["existing_trajectory_task_ids"] = existing
            state["updated_at_utc"] = utc_now()
            write_private_json(state_path, state)
            if remaining == 0:
                state["status"] = "complete"
                log("queue complete: no runnable tasks remain")
                break

            existing_numbers = [
                int(path.name.removeprefix("batch-"))
                for path in root.glob("batch-[0-9][0-9][0-9][0-9][0-9][0-9]")
            ]
            batch_number = max(existing_numbers, default=0) + 1
            batch_dir = root / f"batch-{batch_number:06d}"
            command_log = batch_dir / "command.log"
            selected_count = min(args.batch_size, remaining)
            run_label = (
                f"Apollo author-approved Meta production shard "
                f"{args.shard_index + 1}/{args.shard_count} batch {batch_number:06d}"
            )
            log(
                f"starting batch {batch_number}: {selected_count} of {remaining} runnable "
                f"tasks; {free_gib:.1f} GiB free"
            )

            base = command_base(args, batch_dir)
            run_command(
                [*base, "--stage", "fetch", "--limit", str(selected_count)],
                command_log,
            )
            job = read_json(batch_dir / "job.json")
            task_count = int(job["task_count"])
            workers = min(args.num_envs, task_count)
            judges = min(args.judge_workers, task_count)
            run_command(
                [
                    *base,
                    "--stage", "run",
                    "--num-envs", str(workers),
                    "--run-label", run_label,
                ],
                command_log,
            )
            run_command(
                [
                    *base,
                    "--stage", "publish",
                    "--judge-workers", str(judges),
                    "--run-label", run_label,
                ],
                command_log,
            )
            verified = verify_batch(
                batch_dir,
                bucket=args.s3_bucket,
                queue=args.queue,
                token=token,
                reporting_attempts=args.reporting_attempts,
                reporting_delay=args.reporting_delay,
            )
            record = batch_verification_record(batch_dir, verified)
            write_private_json(batch_dir / "verified.json", record)
            compact_batch(batch_dir)

            record_completed_batch(state, batch_dir, verified)
            write_private_json(state_path, state)
            log(
                f"completed batch {batch_number}: published {len(verified)} of "
                f"{record['requested_task_count']}; "
                f"total published {state['tasks_published']}"
            )
        else:
            state["status"] = "batch_limit"
            state["stop_reason"] = f"reached max-batches={args.max_batches}"
    except Exception as exc:
        state["status"] = "error"
        state["stop_reason"] = str(exc)
        state["updated_at_utc"] = utc_now()
        write_private_json(state_path, state)
        log(f"stopped on error: {exc}")
        return 1

    state["updated_at_utc"] = utc_now()
    write_private_json(state_path, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
