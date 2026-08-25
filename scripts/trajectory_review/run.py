#!/usr/bin/env python3
"""One-command trajectory judge -> Apollo human-QC publisher.

The model judge runs locally (or on a dedicated worker).  Only the validated,
immutable review package is uploaded to Apollo's trajectory prefixes.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Sequence

if __package__:
    from .prepare import task_belongs_to_queue
else:
    from prepare import task_belongs_to_queue


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_BUCKET = "journeys-prolific"


class RunnerError(RuntimeError):
    pass


def aws_base(args: argparse.Namespace) -> list[str]:
    command = [args.aws_cli]
    if args.aws_profile:
        command.extend(["--profile", args.aws_profile])
    if args.aws_region:
        command.extend(["--region", args.aws_region])
    return command


def aws_environment(args: argparse.Namespace) -> dict[str, str]:
    environment = dict(os.environ)
    if args.aws_profile:
        environment["AWS_PROFILE"] = args.aws_profile
    if args.aws_region:
        environment["AWS_REGION"] = args.aws_region
        environment["AWS_DEFAULT_REGION"] = args.aws_region
    return environment


def aws_identity(args: argparse.Namespace) -> dict[str, str]:
    command = [*aws_base(args), "sts", "get-caller-identity", "--output", "json"]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, env=aws_environment(args))
        value = json.loads(result.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        raise RunnerError(f"AWS identity check failed: {exc}") from exc
    return {
        "account": str(value.get("Account") or ""),
        "arn": str(value.get("Arn") or ""),
    }


def check_bucket(args: argparse.Namespace, bucket: str) -> None:
    command = [*aws_base(args), "s3api", "get-bucket-location", "--bucket", bucket, "--output", "json"]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, env=aws_environment(args))
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RunnerError(f"cannot access S3 bucket {bucket}: {exc}") from exc


def judge_command(args: argparse.Namespace, eval_results: Path, *, plan: bool | None = None) -> list[str]:
    command = [
        sys.executable,
        str(SCRIPT_DIR / "judge.py"),
        "--runs-dir", str(args.runs_dir),
        "--task-source-json", str(args.task_source_json),
        "--output", str(eval_results),
        "--provider", args.provider,
        "--model", args.model,
        "--num-workers", str(args.num_workers),
        "--max-images", str(args.max_images),
        "--max-steps", str(args.max_steps),
        "--max-history-chars", str(args.max_history_chars),
    ]
    if args.env_file:
        command.extend(["--env-file", str(args.env_file)])
    if args.include_incomplete:
        command.append("--include-incomplete")
    if args.plan if plan is None else plan:
        command.append("--plan")
    return command


def validate_judge_plan_queue(plan: dict[str, object], queue: str) -> None:
    task_ids = plan.get("task_ids")
    if not isinstance(task_ids, list) or not all(isinstance(task_id, str) for task_id in task_ids):
        raise RunnerError("trajectory judge plan did not include valid task_ids")
    wrong = [task_id for task_id in task_ids if not task_belongs_to_queue(task_id, queue)]
    if wrong:
        preview = ", ".join(wrong[:3])
        raise RunnerError(f"--queue {queue} cannot process task(s) from the other Apollo queue: {preview}")


def judge_plan(args: argparse.Namespace, eval_results: Path) -> dict[str, object]:
    try:
        result = subprocess.run(
            judge_command(args, eval_results, plan=True),
            check=True,
            capture_output=True,
            text=True,
        )
        plan = json.loads(result.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        raise RunnerError(f"trajectory assignment plan failed: {exc}") from exc
    if not isinstance(plan, dict):
        raise RunnerError("trajectory judge plan must be a JSON object")
    validate_judge_plan_queue(plan, args.queue)
    return plan


def prepare_command(args: argparse.Namespace, eval_results: Path, bucket: str | None) -> list[str]:
    command = [
        sys.executable,
        str(SCRIPT_DIR / "prepare.py"),
        "--eval-results", str(eval_results),
        "--runs-root", str(args.runs_dir),
        "--output-dir", str(args.output_dir),
        "--aws-cli", args.aws_cli,
        "--queue", args.queue,
        "--model", args.model,
    ]
    if bucket:
        command.extend(["--s3-bucket", bucket])
    creator_map = getattr(args, "creator_map", None)
    if creator_map:
        command.extend(["--creator-map", str(creator_map)])
    return command


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Run the repo-local trajectory judge and queue validated packages for Apollo human QC."
    )
    value.add_argument("--runs-dir", type=Path, required=True)
    value.add_argument("--task-source-json", type=Path, required=True)
    value.add_argument("--output-dir", type=Path, default=Path(".work/trajectory_review"))
    value.add_argument("--eval-results", type=Path, default=None)
    value.add_argument("--provider", choices=("auto", "gemini", "openai"), default="auto")
    value.add_argument("--model", default="gemini-3.1-flash-lite-preview")
    value.add_argument(
        "--queue",
        choices=("v2", "pc"),
        default="v2",
        help="Publish to the Apollo v2 or Apollo PC human trajectory queue",
    )
    value.add_argument("--env-file", type=Path, default=None)
    value.add_argument("--num-workers", type=int, default=4)
    value.add_argument("--max-images", type=int, default=0)
    value.add_argument("--max-steps", type=int, default=0)
    value.add_argument("--max-history-chars", type=int, default=400_000)
    value.add_argument("--include-incomplete", action="store_true")
    value.add_argument(
        "--creator-map",
        type=Path,
        default=None,
        help="JSON task_id-to-creator mapping for legacy external IDs without an Apollo participant",
    )
    value.add_argument("--skip-judge", action="store_true", help="Publish an existing --eval-results file")
    value.add_argument("--plan", action="store_true", help="Validate inputs, model routing, and AWS access only")
    upload = value.add_mutually_exclusive_group()
    upload.add_argument("--s3-bucket", default=None, help="Production upload bucket")
    upload.add_argument("--prod", action="store_true", help=f"Upload to the production bucket ({DEFAULT_BUCKET})")
    value.add_argument("--aws-cli", default="aws")
    value.add_argument("--aws-profile", default=None)
    value.add_argument("--aws-region", default="us-east-1")
    return value


def main(argv: Sequence[str] | None = None) -> None:
    args = parser().parse_args(argv)
    args.output_dir = args.output_dir.expanduser().resolve()
    args.runs_dir = args.runs_dir.expanduser().resolve()
    args.task_source_json = args.task_source_json.expanduser().resolve()
    if args.creator_map:
        args.creator_map = args.creator_map.expanduser().resolve()
        if not args.creator_map.is_file():
            raise SystemExit(f"error: --creator-map does not exist: {args.creator_map}")
    eval_results = (
        args.eval_results.expanduser().resolve()
        if args.eval_results
        else args.output_dir / "eval_results_full_traj_per_rubric.json"
    )
    bucket = DEFAULT_BUCKET if args.prod else args.s3_bucket

    if args.skip_judge and args.plan:
        raise SystemExit("error: --skip-judge and --plan cannot be combined")
    if args.skip_judge and not eval_results.is_file():
        raise SystemExit(f"error: --skip-judge requires an existing file: {eval_results}")
    if not args.runs_dir.is_dir() or not args.task_source_json.is_file():
        raise SystemExit("error: --runs-dir and --task-source-json must exist")

    try:
        plan = None if args.skip_judge else judge_plan(args, eval_results)
        identity = None
        if bucket:
            identity = aws_identity(args)
            check_bucket(args, bucket)
        if args.plan:
            print(json.dumps({
                "judge": plan,
                "upload": bool(bucket),
                "bucket": bucket,
                "aws_identity": identity,
                "queue": args.queue,
                "writes": [
                    f"{'pc-review' if args.queue == 'pc' else 'v2-review'}/trajectory-runs/*",
                    f"{'pc-review' if args.queue == 'pc' else 'v2-review'}/trajectory-inbox/*",
                ] if bucket else [],
                "task_or_gold_writes": False,
            }, indent=2))
            return

        args.output_dir.mkdir(parents=True, exist_ok=True)
        if not args.skip_judge:
            subprocess.run(judge_command(args, eval_results, plan=False), check=True)
        subprocess.run(
            prepare_command(args, eval_results, bucket),
            check=True,
            env=aws_environment(args),
        )
    except (RunnerError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"error: {exc}") from exc


if __name__ == "__main__":
    main()
