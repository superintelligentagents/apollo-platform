#!/usr/bin/env python3
"""Export human-passed Apollo tasks as stock OSWorld task configs.

The export is deliberately downstream of human trajectory QC. It reads the
authenticated Apollo trajectory reporting response, keeps only runs whose
human final grade is YES and whose rubric verdicts are all SUCCESS, then emits
one OSWorld task per Apollo task. The source reporting data is never modified.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "apollo-osworld-export-v1"
APOLLO_OSWORLD_NAMESPACE = uuid.UUID("7aa8f833-8ea6-4a38-a64f-2d56a9db9de5")


class ExportError(ValueError):
    pass


def _text(value: Any, limit: int = 200_000) -> str:
    return str(value or "").strip()[:limit]


def _human_outcome(row: dict[str, Any]) -> str:
    direct = _text(row.get("human_final_grade"), 30).upper()
    if direct:
        return direct
    trajectory = row.get("human_judgment", {}).get("trajectory", {})
    current = _text(trajectory.get("overall_outcome"), 30).upper()
    if current:
        return current
    legacy = _text(trajectory.get("task_satisfied"), 30).upper()
    return {"SUCCESS": "YES", "FAILURE": "NO", "UNJUDGEABLE": "NEEDS_RERUN"}.get(legacy, "")


def accepted_human_pass(row: dict[str, Any]) -> bool:
    """Return true only for a complete, affirmative human trajectory grade."""
    if _text(row.get("status"), 30).lower() != "reviewed" or _human_outcome(row) != "YES":
        return False
    manifest = row.get("manifest")
    judgment = row.get("human_judgment")
    if not isinstance(manifest, dict) or not isinstance(judgment, dict):
        return False
    manifest_ids = {
        _text(rubric.get("rubric_id"), 100)
        for rubric in manifest.get("rubrics", [])
        if isinstance(rubric, dict) and _text(rubric.get("rubric_id"), 100)
    }
    verdicts = {
        _text(rubric.get("rubric_id"), 100): _text(rubric.get("human_verdict"), 30).upper()
        for rubric in judgment.get("rubrics", [])
        if isinstance(rubric, dict) and _text(rubric.get("rubric_id"), 100)
    }
    return bool(manifest_ids) and set(verdicts) == manifest_ids and all(
        verdicts[rubric_id] == "SUCCESS" for rubric_id in manifest_ids
    )


def _inert_external_evaluator() -> dict[str, Any]:
    """A stock OSWorld evaluator that cannot be mistaken for the Apollo grade.

    Apollo tasks use rubric/trajectory judging after the run, not an OSWorld
    state getter. This valid stock evaluator returns zero for normal browser
    URLs (and also for FAIL), while allowing an unmodified OSWorld checkout to
    load and execute the task. The exported metadata makes that contract clear.
    """
    return {
        "func": "is_expected_url_pattern_match",
        "result": {"type": "active_url_from_accessTree"},
        "expected": {
            "type": "rule",
            "rules": {"expected": ["^apollo-external-human-qc-only$"]},
        },
    }


def osworld_task(row: dict[str, Any], snapshot: str = "chrome") -> dict[str, Any]:
    if not accepted_human_pass(row):
        raise ExportError("trajectory row is not a complete human pass")
    manifest = row["manifest"]
    task_id = _text(manifest.get("task_id") or row.get("task_id"), 300)
    instruction = _text(manifest.get("task_prompt"))
    if not task_id or not instruction:
        raise ExportError("passed trajectory is missing task_id or task_prompt")
    osworld_id = str(uuid.uuid5(APOLLO_OSWORLD_NAMESPACE, task_id))
    rubrics = []
    for rubric in manifest.get("rubrics", []):
        rubric_id = _text(rubric.get("rubric_id"), 100)
        requirement = _text(rubric.get("requirement"), 30_000)
        if not rubric_id or not requirement:
            raise ExportError(f"task {task_id} contains an incomplete rubric")
        rubrics.append({
            "rubric_id": rubric_id,
            "requirement": requirement,
            "verification": _text(rubric.get("verification"), 20_000),
        })
    return {
        "id": osworld_id,
        "snapshot": snapshot,
        "instruction": instruction,
        "source": "Apollo",
        "config": [
            {
                "type": "launch",
                "parameters": {"command": ["google-chrome", "--remote-debugging-port=1337"]},
            },
            {
                "type": "launch",
                "parameters": {"command": ["socat", "tcp-listen:9222,fork", "tcp:localhost:1337"]},
            },
            {"type": "activate_window", "parameters": {"window_name": "Google Chrome"}},
        ],
        "trajectory": "trajectories/",
        "related_apps": ["chrome"],
        "evaluator": _inert_external_evaluator(),
        "proxy": False,
        "fixed_ip": False,
        "possibility_of_env_change": "low",
        "apollo": {
            "schema_version": SCHEMA_VERSION,
            "task_id": task_id,
            "creator_pid": _text(manifest.get("creator_pid"), 80) or None,
            "accepted_run_id": _text(manifest.get("run_id") or row.get("run_id"), 120),
            "accepted_manifest_key": _text(row.get("manifest_key"), 2_000),
            "human_reviewed_at": _text(row.get("reviewed_at"), 80) or None,
            "human_final_grade": "YES",
            "rubrics": rubrics,
            "evaluation": "Run scripts/trajectory_review/run.py and complete Apollo human Grade; ignore OSWorld result.txt.",
        },
    }


def select_latest_passes(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the newest accepted run for each task, deterministically."""
    selected: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not accepted_human_pass(row):
            continue
        task_id = _text(row.get("manifest", {}).get("task_id") or row.get("task_id"), 300)
        if not task_id:
            continue
        current = selected.get(task_id)
        candidate_order = (_text(row.get("reviewed_at"), 80), _text(row.get("run_id"), 120))
        current_order = (
            _text(current.get("reviewed_at"), 80),
            _text(current.get("run_id"), 120),
        ) if current else ("", "")
        if current is None or candidate_order > current_order:
            selected[task_id] = row
    return [selected[task_id] for task_id in sorted(selected)]


def load_rows(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExportError(f"could not read {path}: {exc}") from exc
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("trajectories"), list):
        return value["trajectories"]
    raise ExportError("input must be a trajectory reporting response or a trajectory array")


def fetch_rows(api_url: str, token: str, page_size: int = 10) -> list[dict[str, Any]]:
    if not token:
        raise ExportError("reporting bearer token is missing")
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        parsed = urllib.parse.urlsplit(api_url)
        query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        query.update({"status": "reviewed", "include": "full", "limit": str(page_size), "offset": str(offset)})
        url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                value = json.load(response)
        except Exception as exc:  # urllib exposes several transport subclasses.
            raise ExportError(f"trajectory reporting request failed: {exc}") from exc
        page = value.get("trajectories", []) if isinstance(value, dict) else []
        if not isinstance(page, list):
            raise ExportError("trajectory reporting API returned an invalid page")
        rows.extend(page)
        next_offset = value.get("page", {}).get("next_offset")
        if next_offset is None:
            break
        offset = int(next_offset)
    return rows


def write_export(rows: Iterable[dict[str, Any]], output_dir: Path, snapshot: str = "chrome") -> dict[str, Any]:
    selected = select_latest_passes(rows)
    tasks = [osworld_task(row, snapshot=snapshot) for row in selected]
    example_dir = output_dir / "examples" / snapshot
    example_dir.mkdir(parents=True, exist_ok=True)
    for task in tasks:
        (example_dir / f"{task['id']}.json").write_text(json.dumps(task, indent=2) + "\n", encoding="utf-8")
    meta = {snapshot: [task["id"] for task in tasks]}
    summary = {
        "schema_version": SCHEMA_VERSION,
        "exported": len(tasks),
        "task_ids": [task["apollo"]["task_id"] for task in tasks],
        "osworld_ids": [task["id"] for task in tasks],
        "stock_osworld_meta": "test_apollo.json",
        "generic_task_array": "tasks.json",
        "native_result_txt_is_authoritative": False,
    }
    (output_dir / "tasks.json").write_text(json.dumps(tasks, indent=2) + "\n", encoding="utf-8")
    (output_dir / "test_apollo.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    (output_dir / "export-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Saved Apollo trajectory reporting JSON")
    source.add_argument("--api-url", help="Authenticated /reporting/trajectories endpoint")
    parser.add_argument("--token-env", default="APOLLO_REPORTING_TOKEN", help="Environment variable holding the bearer token")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--snapshot", default="chrome")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        rows = load_rows(args.input) if args.input else fetch_rows(args.api_url, os.environ.get(args.token_env, ""))
        summary = write_export(rows, args.output_dir, args.snapshot)
    except ExportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
