#!/usr/bin/env python3
"""Extract retained run durations or apply them to an existing showcase export."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import export_dataset


def extract() -> dict[str, int]:
    timings: dict[str, int] = {}
    for spec in export_dataset.MODELS.values():
        for run in export_dataset.runs_for(spec["state_glob"]).values():
            duration = run.get("duration_seconds")
            if isinstance(duration, int):
                timings[run["run_id"]] = duration
    return timings


def apply(data_dir: Path, timings: dict[str, int]) -> tuple[int, int]:
    index_path = data_dir / "index.json"
    index = json.loads(index_path.read_text())
    updated = 0
    details = []
    for run_path in sorted((data_dir / "runs").glob("*.json")):
        detail = json.loads(run_path.read_text())
        duration = timings.get(detail["run_id"])
        if duration is not None:
            detail["duration_seconds"] = duration
            run_path.write_text(json.dumps(detail, ensure_ascii=False), encoding="utf-8")
            updated += 1
        details.append(detail)

    tasks = {task["task_id"]: task for task in index["tasks"]}
    for task in index["tasks"]:
        for reference in task["runs"].values():
            run_id = reference["run"].split("__", 1)[-1]
            reference["duration_seconds"] = timings.get(run_id)
    index["analysis"] = export_dataset.build_analysis(details, tasks)
    index_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    return updated, len(details)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--out", type=Path)
    value.add_argument("--apply", type=Path)
    value.add_argument("--data", type=Path)
    return value


def main() -> int:
    args = parser().parse_args()
    if args.out:
        timings = extract()
        args.out.write_text(json.dumps(timings, sort_keys=True), encoding="utf-8")
        print(f"wrote {len(timings)} run durations to {args.out}")
        return 0
    if args.apply and args.data:
        timings = json.loads(args.apply.read_text())
        updated, total = apply(args.data, timings)
        print(f"added durations to {updated} of {total} runs")
        return 0
    raise SystemExit("use --out, or use --apply with --data")


if __name__ == "__main__":
    raise SystemExit(main())
