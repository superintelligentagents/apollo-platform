#!/usr/bin/env python3
"""Build the showcase dataset: tasks, per-model runs, grades, trajectories.

Screenshots are referenced by S3 key, never copied. The runs hold ~13,000
frames and roughly a gigabyte; a deployment that bundled them would be
unshippable, and the site signs them on demand instead.

    export_dataset.py --out showcase/data
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Mapping

D = Path("/data/user_data/ljang/apollo-osworld")
BUCKET = "journeys-prolific"

MODELS = {
    "claude-opus-5": {
        "label": "Claude Opus 5",
        "state_glob": ["h100opus-s*/queue-state.json"],
        # Opus was judged by luna at run time; the Gemini verdicts live in the
        # re-judge output, so both models are shown on the same judge.
        "grades": D / "rejudge-opus-gemini" / "results.json",
    },
    "gpt-5.6-sol": {
        "label": "GPT-5.6 sol",
        # The tail of the campaign ran under its own work root, so both are
        # listed; a wildcard covering them by accident would be one rename away
        # from silently dropping published runs.
        "state_glob": ["h100v2sol-s*/queue-state.json", "h100v2fill-s*/queue-state.json"],
        "grades": None,          # already judged by Gemini in its own run
    },
}

FAILURE_PATTERNS = {
    "unfinished_outcome": re.compile(
        r"failed to (produce|provide|create|compile|assemble|deliver|generate|synthesize|compare|rank|summarize)"
        r"|never (produced|provided|created|compiled|assembled|delivered|generated|synthesized|compared|ranked|summarized)"
        r"|did not (produce|provide|create|compile|assemble|deliver|generate|synthesize|compare|rank|summarize)"
        r"|no (final|written|completed) (output|response|document|deliverable|report|plan|comparison)"
        r"|trajectory ended|simply navigat|only (navigated|searched|visited)|research phase",
        re.I,
    ),
    "missing_details": re.compile(
        r"missing|omitted|did not (include|record|capture|extract|address|cover)"
        r"|failed to (include|record|capture|extract|address|cover)|incomplete|lacks? the required",
        re.I,
    ),
    "weak_verification": re.compile(
        r"not (verify|verified)|failed to verify|did not verify|no (source|citation)"
        r"|without (source|citation)|third.party|official source|authoritative source|unsupported",
        re.I,
    ),
    "access_failure": re.compile(
        r"site can.t be reached|failed to load|unable to access|could not access|paywall|login"
        r"|blocked|access denied|connectivity|page did not load",
        re.I,
    ),
}


def summarise(request: str, limit: int = 130) -> str:
    """A one-line title that ends on a word, not mid-syllable."""
    text = " ".join(request.split())
    if len(text) <= limit:
        return text
    return text[:text.rfind(" ", 0, limit)].rstrip(",;:") + "…"


def runs_for(patterns: list[str]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for pattern in patterns:
        for path in sorted(D.glob(pattern)):
            for run in json.loads(path.read_text()).get("runs") or []:
                found[run["task_id"]] = run
    return found


def fetch_manifest(key: str, aws_cli: str = "aws") -> dict[str, Any] | None:
    result = subprocess.run(
        [aws_cli, "s3", "cp", f"s3://{BUCKET}/{key}", "-"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except ValueError:
        return None


def trajectory_from(manifest: Mapping[str, Any], prefix: str) -> list[dict[str, Any]]:
    steps = []
    for step in manifest.get("steps") or []:
        path = step.get("screenshot_path")
        steps.append({
            "index": step.get("index"),
            "step": step.get("step_number"),
            "action": (step.get("action") or "")[:4000],
            "response": (step.get("response") or "")[:8000],
            # A key, not a URL: signing happens per request, at view time.
            "screenshot_key": f"{prefix}/{path}" if path else None,
        })
    return steps


def grades_from(manifest: Mapping[str, Any], override: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    if override is not None:
        rows = override.get("rubric_results") or []
        return [{
            "rubric_id": r.get("rubric_id"),
            "requirement": (r.get("requirement") or "")[:6000],
            "status": str(r.get("judge_status") or "").upper() or ("SUCCESS" if r.get("success") else "FAILURE"),
            "reasoning": (r.get("final_reasoning") or "")[:6000],
        } for r in rows]
    return [{
        "rubric_id": r.get("rubric_id"),
        "requirement": (r.get("requirement") or "")[:6000],
        "status": str(r.get("llm_status") or "").upper(),
        "reasoning": (r.get("llm_reasoning") or "")[:6000],
    } for r in manifest.get("rubrics") or []]


def score_of(grades: list[dict[str, Any]]) -> tuple[float, int, int]:
    scored = [g for g in grades if g["status"] in {"SUCCESS", "FAILURE"}]
    passed = sum(1 for g in scored if g["status"] == "SUCCESS")
    return (round(passed / len(scored), 4) if scored else 0.0, passed, len(scored))


def build_analysis(details: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate reproducible story metrics from the exported judge records."""
    model_stats: dict[str, dict[str, Any]] = {}
    for model_id in MODELS:
        rows = [row for row in details if row["model"] == model_id]
        scored = sum(row["rubrics_scored"] for row in rows)
        passed = sum(row["rubrics_passed"] for row in rows)
        model_stats[model_id] = {
            "runs": len(rows),
            "mean_score": round(sum(row["score"] for row in rows) / len(rows), 4) if rows else 0,
            "mean_steps": round(sum(row["steps"] for row in rows) / len(rows), 1) if rows else 0,
            "cap_runs": sum(1 for row in rows if row["truncated"]),
            "rubrics_passed": passed,
            "rubrics_scored": scored,
            "rubric_pass_rate": round(passed / scored, 4) if scored else 0,
            "zero_score_runs": sum(1 for row in rows if row["score"] == 0),
            "perfect_runs": sum(1 for row in rows if row["score"] == 1),
        }

    by_task: dict[str, dict[str, dict[str, Any]]] = {}
    for row in details:
        by_task.setdefault(row["task_id"], {})[row["model"]] = row
    shared = wins_sol = wins_opus = ties = 0
    for task_runs in by_task.values():
        sol = task_runs.get("gpt-5.6-sol")
        opus = task_runs.get("claude-opus-5")
        if not sol or not opus:
            continue
        shared += 1
        if sol["score"] > opus["score"]:
            wins_sol += 1
        elif opus["score"] > sol["score"]:
            wins_opus += 1
        else:
            ties += 1

    failure_modes = {key: 0 for key in FAILURE_PATTERNS}
    failed_rubrics = 0
    for row in details:
        for grade in row["grades"]:
            if grade["status"] != "FAILURE":
                continue
            failed_rubrics += 1
            reasoning = grade.get("reasoning") or ""
            for key, pattern in FAILURE_PATTERNS.items():
                if pattern.search(reasoning):
                    failure_modes[key] += 1

    opus_rows = [row for row in details if row["model"] == "claude-opus-5"]

    def failure_rate(rows: list[dict[str, Any]]) -> dict[str, Any]:
        scored = sum(row["rubrics_scored"] for row in rows)
        failed = sum(row["rubrics_scored"] - row["rubrics_passed"] for row in rows)
        return {"failed": failed, "scored": scored, "rate": round(failed / scored, 4) if scored else 0}

    return {
        "total_runs": len(details),
        "total_rubrics": sum(row["rubrics_scored"] for row in details),
        "failed_rubrics": failed_rubrics,
        "model_stats": model_stats,
        "head_to_head": {
            "shared_tasks": shared,
            "sol_wins": wins_sol,
            "opus_wins": wins_opus,
            "ties": ties,
        },
        "opus_cap_comparison": {
            "capped": failure_rate([row for row in opus_rows if row["truncated"]]),
            "uncapped": failure_rate([row for row in opus_rows if not row["truncated"]]),
        },
        # Categories overlap by design: one judge explanation may cite multiple modes.
        "failure_modes": failure_modes,
    }


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--out", type=Path, required=True)
    value.add_argument("--subset", type=Path, default=D / "showcase-subset-100.json")
    value.add_argument("--aws-cli", default=str(D / "bin" / "aws"))
    value.add_argument("--workers", type=int, default=16)
    return value


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    subset = json.loads(args.subset.read_text())
    tasks = {t["task_id"]: t for t in subset["tasks"]}

    index: dict[str, Any] = {}
    details: list[dict[str, Any]] = []
    for model_id, spec in MODELS.items():
        runs = runs_for(spec["state_glob"])
        override = {}
        if spec["grades"] and Path(spec["grades"]).is_file():
            override = {t["task_id"]: t for t in json.loads(Path(spec["grades"]).read_text())["tasks"]}
        print(f"{model_id}: {len(runs)} runs, {len(override)} re-judged", flush=True)

        def one(item: tuple[str, dict[str, Any]]) -> tuple[str, dict[str, Any]] | None:
            task_id, run = item
            manifest = fetch_manifest(run["manifest_key"], args.aws_cli)
            if not manifest:
                return None
            prefix = run["manifest_key"].rsplit("/", 1)[0]
            grades = grades_from(manifest, override.get(task_id))
            score, passed, scored = score_of(grades)
            detail = {
                "task_id": task_id,
                "model": model_id,
                "run_id": run["run_id"],
                "score": score,
                "rubrics_passed": passed,
                "rubrics_scored": scored,
                "steps": run["num_steps"],
                "truncated": run["num_steps"] >= 120,
                "grades": grades,
                "trajectory": trajectory_from(manifest, prefix),
            }
            return task_id, detail

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for got in pool.map(one, runs.items()):
                if not got:
                    continue
                task_id, detail = got
                details.append(detail)
                (args.out / "runs").mkdir(exist_ok=True)
                slug = f"{model_id}__{detail['run_id']}"
                (args.out / "runs" / f"{slug}.json").write_text(
                    json.dumps(detail, ensure_ascii=False), encoding="utf-8")
                entry = index.setdefault(task_id, {
                    "task_id": task_id,
                    "title": summarise(tasks.get(task_id, {}).get("confirmed_task") or ""),
                    "request": tasks.get(task_id, {}).get("confirmed_task") or "",
                    "category": tasks.get(task_id, {}).get("category"),
                    "subjects": tasks.get(task_id, {}).get("subjects"),
                    "rubric_count": len(tasks.get(task_id, {}).get("rubrics") or []),
                    "baseline_luna": (tasks.get(task_id, {}).get("baseline_gpt_5_6_luna") or {}).get("average_rubric_score"),
                    "runs": {},
                })
                entry["runs"][model_id] = {
                    "run": slug, "score": detail["score"], "steps": detail["steps"],
                    "truncated": detail["truncated"],
                    "rubrics_passed": passed_scored(detail),
                }
    (args.out / "index.json").write_text(json.dumps({
        "generated_from": str(args.subset),
        "judge": "gemini-3.1-flash-lite-preview",
        "max_steps": 120,
        "prompt": "canonical upstream (no Apollo operator prompt)",
        "models": {k: v["label"] for k, v in MODELS.items()},
        "analysis": build_analysis(details),
        "tasks": sorted(index.values(), key=lambda t: t["task_id"]),
    }, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(index)} tasks to {args.out}")
    return 0


def passed_scored(detail: Mapping[str, Any]) -> str:
    return f"{detail['rubrics_passed']}/{detail['rubrics_scored']}"


if __name__ == "__main__":
    raise SystemExit(main())
