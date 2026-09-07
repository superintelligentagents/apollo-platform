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
        "state_glob": "h100opus-s*/queue-state.json",
        # Opus was judged by luna at run time; the Gemini verdicts live in the
        # re-judge output, so both models are shown on the same judge.
        "grades": D / "rejudge-opus-gemini" / "results.json",
    },
    "gpt-5.6-sol": {
        "label": "GPT-5.6 sol",
        "state_glob": "h100v2sol-s*/queue-state.json",
        "grades": None,          # already judged by Gemini in its own run
    },
}


def summarise(request: str, limit: int = 130) -> str:
    """A one-line title that ends on a word, not mid-syllable."""
    text = " ".join(request.split())
    if len(text) <= limit:
        return text
    return text[:text.rfind(" ", 0, limit)].rstrip(",;:") + "…"


def runs_for(glob_pattern: str) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for path in sorted(D.glob(glob_pattern)):
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
        "tasks": sorted(index.values(), key=lambda t: t["task_id"]),
    }, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(index)} tasks to {args.out}")
    return 0


def passed_scored(detail: Mapping[str, Any]) -> str:
    return f"{detail['rubrics_passed']}/{detail['rubrics_scored']}"


if __name__ == "__main__":
    raise SystemExit(main())
