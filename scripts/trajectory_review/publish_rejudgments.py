#!/usr/bin/env python3
"""Publish canonical full-trajectory re-judgments beside their run packages.

A published manifest is immutable — it is content-addressed and written with
``--if-none-match`` — so a re-judgment cannot replace the scores inside it.
This writes a separate ``rejudgment.json`` next to each ``manifest.json`` under
the same run prefix, which the reporting API prefers over the manifest's own
metrics when it is present.

The original judgment is never destroyed: the manifest keeps it, and every
re-judgment records the judge it came from (repo, commit, SHA-256, model, how
many screenshots were used) so a grader can tell the two apart.

    publish_rejudgments.py --results rejudged-all.json --trajectories all-traj.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Mapping, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from canonical_judge import (  # type: ignore
        CANONICAL_COMMIT, CANONICAL_PATH, CANONICAL_REPO, CANONICAL_SHA256,
    )
else:  # pragma: no cover - package import path
    from .canonical_judge import (
        CANONICAL_COMMIT, CANONICAL_PATH, CANONICAL_REPO, CANONICAL_SHA256,
    )

SCHEMA_VERSION = "apollo-trajectory-rejudgment-v1"


def rejudgment_document(
    task: Mapping[str, Any], model: str, screenshots: int | None = None
) -> dict[str, Any]:
    """The sidecar payload: verdicts plus the provenance to trust them."""
    rubrics = []
    for rubric in task.get("rubric_results") or []:
        status = str(rubric.get("judge_status") or "").upper()
        if status not in {"SUCCESS", "FAILURE", "ERROR"}:
            status = "SUCCESS" if rubric.get("success") is True else "FAILURE"
        score = None if status == "ERROR" else (1 if status == "SUCCESS" else 0)
        rubrics.append({
            "rubric_id": str(rubric.get("rubric_id") or ""),
            "requirement": str(rubric.get("requirement") or "")[:30_000],
            "verification": str(rubric.get("verification") or "")[:20_000],
            "llm_status": status,
            "llm_score": score,
            "llm_success": None if score is None else score == 1,
            "llm_reasoning": str(rubric.get("final_reasoning") or "")[:30_000],
        })
    scored = [r["llm_score"] for r in rubrics if r["llm_score"] is not None]
    return {
        "schema_version": SCHEMA_VERSION,
        "task_id": task.get("task_id"),
        "judge": {
            "repo": CANONICAL_REPO,
            "commit": CANONICAL_COMMIT,
            "path": CANONICAL_PATH,
            "sha256": CANONICAL_SHA256,
            "model": model,
            "screenshots": "all" if screenshots is None else screenshots,
        },
        "created_at_utc": task.get("created_at_utc"),
        "metrics": {
            "average_rubric_score": round(sum(scored) / len(scored), 4) if scored else 0.0,
            "perfect": bool(scored) and len(scored) == len(rubrics) and all(s == 1 for s in scored),
            "judge_errors": sum(1 for r in rubrics if r["llm_status"] == "ERROR"),
            "rubrics_total": len(rubrics),
            "rubrics_scored": len(scored),
        },
        "rubrics": rubrics,
    }


def sidecar_key(manifest_key: str) -> str:
    return f"{manifest_key.rsplit('/', 1)[0]}/rejudgment.json"


def upload(document: Mapping[str, Any], key: str, bucket: str, aws_cli: str) -> tuple[str, str]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.flush()
        result = subprocess.run(
            [aws_cli, "s3api", "put-object", "--bucket", bucket, "--key", key,
             "--body", handle.name, "--content-type", "application/json"],
            check=False, capture_output=True, text=True,
        )
    return (key, "" if result.returncode == 0 else (result.stderr or "").strip()[-200:])


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--results", type=Path, required=True,
                       help="task_id -> canonical judge result, as written by the re-judge batches")
    value.add_argument("--trajectories", type=Path, required=True,
                       help="reporting rows, used to map task_id to its manifest key")
    value.add_argument("--model", default="gpt-5.6-luna")
    value.add_argument("--bucket", default="journeys-prolific")
    value.add_argument("--aws-cli", default="aws")
    value.add_argument("--workers", type=int, default=16)
    value.add_argument("--limit", type=int, default=0)
    value.add_argument("--plan", action="store_true", help="report what would be written, upload nothing")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    results = json.loads(args.results.read_text(encoding="utf-8"))
    rows = json.loads(args.trajectories.read_text(encoding="utf-8"))
    keys = {
        r["task_id"]: r["manifest_key"]
        for r in rows
        if r.get("model") == args.model and r.get("manifest_key") and r.get("task_id")
    }
    planned = []
    for task_id, task in results.items():
        manifest_key = keys.get(task_id)
        if not manifest_key:
            continue
        planned.append((sidecar_key(manifest_key), rejudgment_document(task, args.model)))
    if args.limit:
        planned = planned[: args.limit]
    if args.plan:
        sample = planned[0] if planned else (None, None)
        print(json.dumps({
            "rejudgments": len(planned),
            "unmatched": len(results) - len(planned),
            "bucket": args.bucket,
            "sample_key": sample[0],
            "sample_metrics": (sample[1] or {}).get("metrics"),
        }, indent=2))
        return 0
    failures = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for key, error in pool.map(
            lambda item: upload(item[1], item[0], args.bucket, args.aws_cli), planned
        ):
            if error:
                failures.append((key, error))
    print(json.dumps({
        "uploaded": len(planned) - len(failures),
        "failed": len(failures),
        "first_failures": failures[:3],
    }, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
