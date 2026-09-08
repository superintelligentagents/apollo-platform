#!/usr/bin/env python3
"""Choose a small, diverse, hard-but-fair task set for comparing strong agents.

Three constraints pull against each other and the order they are applied in is
the whole design:

Fair first. A task the weak agent failed is worth showing only if a capable
agent could have passed it; one that is stale, gated, or ungradeable is a
defect on display, not a hard problem. Screened verdicts decide this, and
nothing later can readmit a task they rejected.

Diverse second. Category share in the corpus reflects what authors happened to
write, not what a browser agent should be measured on, so a proportional sample
would hand a third of the set to three categories. Every category present gets
a floor before any category gets a surplus.

Hard last. Only inside a category, and only among fair tasks, does the weak
agent's score break ties -- lower first, because that is the headroom a stronger
model has to show. Difficulty never buys a task past the first two rules.

    select_subset.py --screens screen/ --candidates ids.json --tasks api.json \
        --rejudged rejudged-all.json --size 100 --out subset.json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

SCHEMA_VERSION = "apollo-showcase-subset-v1"


def load_screens(directory: Path) -> dict[str, dict[str, Any]]:
    """Screen verdicts, with any re-screen replacing the first pass.

    A re-screen exists because the first pass saw a task through a lossy
    export. Its verdict is the one taken on the real text, so it wins
    outright rather than being averaged with the reading it corrects.
    """
    screens: dict[str, dict[str, Any]] = {}
    for pattern in ("out-*.json", "rescreen-*.json"):
        for path in sorted(directory.glob(pattern)):
            for verdict in json.loads(path.read_text(encoding="utf-8")):
                task_id = str(verdict.get("task_id") or "")
                if task_id:
                    screens[task_id] = verdict
    return screens


def top_category(subjects: Sequence[str] | None) -> str:
    for subject in subjects or []:
        head = str(subject).split(" > ")[0].strip()
        if head:
            return head
    return "Uncategorized"


def allocate(sizes: Mapping[str, int], total: int, floor: int) -> dict[str, int]:
    """Floor for every category, then surplus by remaining availability.

    A category with 2 eligible tasks contributes 2, not 2/225 of the set; the
    floor is what keeps the long tail of the taxonomy visible at all.
    """
    quota = {name: min(floor, count) for name, count in sizes.items()}
    while sum(quota.values()) < total:
        room = [n for n in sizes if sizes[n] > quota[n]]
        if not room:
            break
        # Level up, rather than feeding the biggest category: the next slot
        # goes to the smallest quota that can still take one. Awarding by raw
        # headroom instead would pour every spare slot into the one largest
        # category, which is the opposite of what this set is selected for.
        quota[min(room, key=lambda n: (quota[n], -(sizes[n] - quota[n]), n))] += 1
    return quota


def pick(
    candidates: Sequence[Mapping[str, Any]],
    quota: Mapping[str, int],
    author_cap: int,
    total: int | None = None,
) -> list[Mapping[str, Any]]:
    by_category: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for item in candidates:
        by_category[item["category"]].append(item)
    for rows in by_category.values():
        # Best-screened first, then hardest; sub-label spread is enforced below.
        rows.sort(key=lambda r: (-r["quality"], r["luna_score"], r["task_id"]))
    chosen: list[Mapping[str, Any]] = []
    taken: set[str] = set()
    authors: Counter[str] = Counter()

    def take(row: Mapping[str, Any]) -> None:
        taken.add(row["task_id"])
        authors[row["participant_id"]] += 1
        chosen.append(row)

    # Scarcest category first. A few authors write a large share of the corpus,
    # and filling the big categories first spends their cap there -- leaving a
    # thin category with nine eligible tasks unable to seat even one.
    order = sorted(quota, key=lambda c: (len(by_category.get(c, [])), quota[c], c))
    for category in order:
        want = quota[category]
        seen_labels: set[str] = set()
        for attempt in (1, 2):  # first pass prefers an unused sub-label
            for row in by_category.get(category, []):
                if sum(1 for c in chosen if c["category"] == category) >= want:
                    break
                if row["task_id"] in taken or authors[row["participant_id"]] >= author_cap:
                    continue
                if attempt == 1 and row["label"] in seen_labels:
                    continue
                seen_labels.add(row["label"])
                take(row)

    # Slots a category could not seat (its authors were spent) are re-offered to
    # the rest of the pool rather than silently shrinking the set.
    if total is not None:
        spare = sorted(
            (r for r in candidates if r["task_id"] not in taken),
            key=lambda r: (-r["quality"], r["luna_score"], r["task_id"]),
        )
        for row in spare:
            if len(chosen) >= total:
                break
            if authors[row["participant_id"]] < author_cap:
                take(row)
    return chosen


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--screens", type=Path, required=True)
    value.add_argument("--candidates", type=Path, required=True)
    value.add_argument("--tasks", type=Path, required=True)
    value.add_argument("--rejudged", type=Path, required=True)
    value.add_argument("--out", type=Path, required=True)
    value.add_argument("--size", type=int, default=100)
    value.add_argument("--floor", type=int, default=4)
    value.add_argument("--author-cap", type=int, default=8)
    value.add_argument("--min-quality", type=int, default=3)
    value.add_argument(
        "--min-gradeable-frac", type=float, default=0.8,
        help="reject a task unless this fraction of its rubrics is checkable from a "
             "trajectory; a screener can call a task fair and still note rubrics that "
             "need a human tester, and those cost the run points it cannot earn",
    )
    value.add_argument("--screener", default="claude-opus-5")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    screens = load_screens(args.screens)
    tasks = {t["task_id"]: t for t in json.loads(args.tasks.read_text(encoding="utf-8"))}
    rejudged = json.loads(args.rejudged.read_text(encoding="utf-8"))
    candidate_ids = json.loads(args.candidates.read_text(encoding="utf-8"))

    rejected: Counter[str] = Counter()
    pool = []
    for task_id in candidate_ids:
        verdict = screens.get(task_id)
        if verdict is None:
            rejected["not screened"] += 1
            continue
        if verdict.get("fair") is not True:
            for reason in verdict.get("reasons") or ["unspecified"]:
                rejected[str(reason)[:60]] += 1
            continue
        if int(verdict.get("quality") or 0) < args.min_quality:
            rejected[f"quality below {args.min_quality}"] += 1
            continue
        task = tasks[task_id]
        total_rubrics = len([r for r in (task.get("content") or {}).get("rubrics") or []
                             if isinstance(r, Mapping)])
        gradeable = verdict.get("gradeable_rubrics")
        if isinstance(gradeable, (int, float)) and total_rubrics:
            if gradeable / total_rubrics < args.min_gradeable_frac:
                rejected["too many rubrics ungradeable from a trajectory"] += 1
                continue
        subjects = task.get("subjects") or []
        pool.append({
            "task_id": task_id,
            "participant_id": task.get("participant_id", ""),
            "category": top_category(subjects),
            "label": (subjects[0] if subjects else "Uncategorized"),
            "subjects": subjects,
            "quality": int(verdict.get("quality") or 0),
            "gradeable_rubrics": verdict.get("gradeable_rubrics"),
            "screen_notes": str(verdict.get("notes") or "")[:200],
            "luna_score": round(rejudged[task_id]["average_rubric_score"], 4),
            "luna_steps": rejudged[task_id].get("num_steps"),
        })

    sizes = Counter(item["category"] for item in pool)
    quota = allocate(sizes, args.size, args.floor)
    chosen = pick(pool, quota, args.author_cap, args.size)

    out_tasks = []
    for item in sorted(chosen, key=lambda r: (r["category"], r["task_id"])):
        task = tasks[item["task_id"]]
        content = task.get("content") or {}
        final = content.get("final") or {}
        out_tasks.append({
            "task_id": item["task_id"],
            # Named for the trajectory judge's task loader, so this file can be
            # handed straight to the runner as well as read by a person.
            "confirmed_task": final.get("request") or "",
            "level": final.get("difficulty") or "unknown",
            "creator_pid": item["participant_id"],
            "subjects": item["subjects"],
            "category": item["category"],
            "rubrics": [
                {
                    "rubric_id": rubric.get("rubric_id"),
                    "requirement": rubric.get("final") or "",
                    "verification": "",
                }
                for rubric in (content.get("rubrics") or [])
                if isinstance(rubric, Mapping)
            ],
            "baseline_gpt_5_6_luna": {
                "average_rubric_score": item["luna_score"],
                "trajectory_steps": item["luna_steps"],
            },
            "screen": {
                "quality": item["quality"],
                "gradeable_rubrics": item["gradeable_rubrics"],
                "notes": item["screen_notes"],
            },
        })

    document = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "purpose": "Hard-but-fair subset for comparing strong browser agents against a "
                   "gpt-5.6-luna baseline. Tasks are Apollo author-approved gold, unmodified.",
        "provenance": {
            "task_source": "Apollo v2 reporting API, status=approved, author signed off",
            "baseline": "gpt-5.6-luna, canonical judge, every screenshot",
            "fairness_screener": args.screener,
            "screener_caveat": "The screener shares a family with one evaluated model "
                               "(Claude Opus 5). It judged fairness and well-posedness only, "
                               "never difficulty, but selection is not model-blind.",
            "taxonomy": "SimilarWeb-style category paths carried on each task",
        },
        "selection_policy": {
            "candidate_filter": "luna average rubric score < 0.35, >=5 rubrics, "
                                ">=20 trajectory steps, 0 judge errors, has a taxonomy label",
            "fairness": f"screened fair, quality >= {args.min_quality}, "
                        f">= {args.min_gradeable_frac:.0%} of rubrics gradeable from a trajectory",
            "diversity": f"per-category floor {args.floor}, author cap {args.author_cap}, "
                         "sub-label spread preferred within a category",
            "ordering": "quality desc, then luna score asc",
        },
        "summary": {
            "tasks": len(out_tasks),
            "categories": len({t["category"] for t in out_tasks}),
            "authors": len({t["creator_pid"] for t in out_tasks}),
            "rubrics": sum(len(t["rubrics"]) for t in out_tasks),
            "baseline_mean_rubric_score": round(
                sum(t["baseline_gpt_5_6_luna"]["average_rubric_score"] for t in out_tasks)
                / len(out_tasks), 4) if out_tasks else 0.0,
            "screened_candidates": len(candidate_ids),
            "passed_fairness_screen": len(pool),
            "per_category": dict(sorted(Counter(t["category"] for t in out_tasks).items())),
        },
        "rejected_by_screen": dict(rejected.most_common(20)),
        "tasks": out_tasks,
    }
    args.out.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(document["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
