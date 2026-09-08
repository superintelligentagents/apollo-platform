#!/usr/bin/env python3
"""Judge trajectories with Odysseys' canonical `run_full_trajectory_per_rubric.py`.

The canonical judge is fetched verbatim from the public Odysseys repository and
verified against a pinned SHA-256 before it runs, so this pipeline evaluates
with exactly the upstream file rather than a local reimplementation.

Two adaptations are unavoidable and both happen around the file, never inside it:

* **Task source.** The canonical judge reads Odysseys task JSON — a list whose
  items carry ``task_id``, ``confirmed_task``, ``level`` and a ``rubrics``
  mapping. Apollo stores raw reporting rows, so the task source is translated
  first, reusing ``judge.normalize_task`` so both judges agree on what a task is.

* **Judge errors.** The canonical judge records a provider or parser failure as
  ``success: false`` — indistinguishable from an agent that genuinely failed the
  rubric. Apollo keeps the two apart (``judge_status: ERROR``, null score,
  excluded from the average), because an errored rubric must not be read as
  agent failure. Its error reasoning is prefixed, so those rows are restored to
  ERROR afterwards.

The output is written in Apollo's schema, so ``prepare.py`` consumes it
unchanged.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from judge import JudgeError, load_task_index, utc_now  # type: ignore
else:  # pragma: no cover - package import path
    from .judge import JudgeError, load_task_index, utc_now

CANONICAL_REPO = "ljang0/Odysseys"
CANONICAL_COMMIT = "837814633ef948479abb3d142458f0acdb73fa65"
CANONICAL_PATH = "scripts/python/run_full_trajectory_per_rubric.py"
CANONICAL_SHA256 = "736c3c20a6d1d00d6fa1ffb34ae2b7c7835618bea0fe735bab99d036ee26983f"
ERROR_REASONING_PREFIX = "Error judging rubric"


def fetch_canonical_judge(cache_dir: Path) -> Path:
    """Return the pinned canonical judge, downloading it once per cache dir."""
    destination = cache_dir / CANONICAL_COMMIT / Path(CANONICAL_PATH).name
    if destination.is_file():
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if digest == CANONICAL_SHA256:
            return destination
    url = (
        f"https://raw.githubusercontent.com/{CANONICAL_REPO}/{CANONICAL_COMMIT}/{CANONICAL_PATH}"
    )
    request = Request(url, headers={"User-Agent": "apollo-trajectory-review/1"})
    try:
        with urlopen(request, timeout=60) as response:
            content = response.read()
    except (HTTPError, URLError, TimeoutError) as exc:
        raise JudgeError(f"could not fetch the canonical Odysseys judge: {exc}") from exc
    digest = hashlib.sha256(content).hexdigest()
    if digest != CANONICAL_SHA256:
        raise JudgeError(
            f"canonical judge hash mismatch: expected {CANONICAL_SHA256}, got {digest}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    return destination


def run_dir_name(task_id: str) -> str:
    """The directory name Apollo gives a run, which is what the canonical judge keys on.

    Its ``infer_task_id`` only recognises Odysseys' hex-hash directories and
    otherwise falls back to the directory name verbatim, so the task source has
    to be keyed by that name rather than by the Apollo task ID.
    """
    encoded = base64.urlsafe_b64encode(task_id.encode("utf-8")).decode("ascii").rstrip("=")
    return f"apollo_b64_{encoded}"


def odysseys_task_source(task_source_json: Path, destination: Path) -> dict[str, str]:
    """Rewrite Apollo's task rows as Odysseys task JSON; returns dir-name -> task ID."""
    index = load_task_index(task_source_json)
    rows = []
    identifiers: dict[str, str] = {}
    for task in index.values():
        key = run_dir_name(task.task_id)
        identifiers[key] = task.task_id
        rows.append({
            "task_id": key,
            "confirmed_task": task.prompt,
            "level": task.level or "unknown",
            # Odysseys keys rubrics by id; Apollo keeps them ordered.
            "rubrics": {
                rubric["id"]: {
                    "requirement": rubric.get("requirement", ""),
                    "verification": rubric.get("verification", ""),
                }
                for rubric in task.rubrics
            },
        })
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return identifiers


def restore_judge_status(
    payload: Mapping[str, Any], model: str, identifiers: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Re-separate judge errors from agent failures in canonical output."""
    tasks = []
    for task in payload.get("tasks") or []:
        if not isinstance(task, Mapping):
            continue
        rubrics = []
        scores: list[int] = []
        for rubric in task.get("rubric_results") or []:
            if not isinstance(rubric, Mapping):
                continue
            reasoning = str(rubric.get("final_reasoning") or "")
            errored = reasoning.startswith(ERROR_REASONING_PREFIX)
            entry = dict(rubric)
            entry["judge_status"] = "ERROR" if errored else (
                "SUCCESS" if rubric.get("success") is True or rubric.get("score") == 1 else "FAILURE"
            )
            if errored:
                # An unjudged rubric carries no score and must not drag the
                # average down as though the agent had failed it.
                entry["score"] = None
                entry["success"] = None
            else:
                scores.append(int(entry.get("score") or 0))
            rubrics.append(entry)
        updated = dict(task)
        # Canonical keyed the run by its directory name; restore the Apollo ID
        # so prepare.py can match the package back to its task.
        raw_id = str(task.get("task_id") or "")
        updated["task_id"] = (identifiers or {}).get(raw_id, raw_id)
        updated["rubric_results"] = rubrics
        updated["rubric_scores"] = {
            str(rubric.get("rubric_id")): rubric.get("score")
            for rubric in rubrics
            if rubric.get("score") is not None
        }
        updated["average_rubric_score"] = round(sum(scores) / len(scores), 4) if scores else 0.0
        updated["perfect"] = bool(scores) and len(scores) == len(rubrics) and all(s == 1 for s in scores)
        updated["judge_errors"] = sum(1 for rubric in rubrics if rubric["judge_status"] == "ERROR")
        tasks.append(updated)
    return {
        "schema_version": "apollo-trajectory-judge-canonical-v1",
        "judge_source": {
            "repo": CANONICAL_REPO,
            "commit": CANONICAL_COMMIT,
            "path": CANONICAL_PATH,
            "sha256": CANONICAL_SHA256,
        },
        "model": model,
        "created_at_utc": utc_now(),
        "tasks": tasks,
    }


# OpenAI rejects a request whose images total more than 50 MB. Judge every
# screenshot when they fit -- that is what makes a verdict trustworthy -- and
# thin them evenly only when they do not.
IMAGE_PAYLOAD_BUDGET_BYTES = 40_000_000


JPEG_QUALITY = 75
TRAJECTORY_FILES = ("steps.jsonl", "traj.jsonl")
SCREENSHOT_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def _rewrite_screenshot_fields(line: str, renamed: Mapping[str, str]) -> str:
    try:
        row = json.loads(line)
    except ValueError:
        return line
    if not isinstance(row, dict):
        return line
    for field in ("screenshot", "screenshot_file"):
        value = row.get(field)
        if isinstance(value, str) and value:
            new_name = renamed.get(Path(value).name)
            if new_name:
                row[field] = new_name
    return json.dumps(row, ensure_ascii=False)


def jpeg_view(runs_dir: Path, destination: Path, quality: int = JPEG_QUALITY) -> Path:
    """A copy of the runs whose screenshots are JPEG, for the judge to read.

    Full-resolution PNG screenshots of a busy page reach ~1.8 MB each, so a
    hundred-step trajectory exceeds the provider's 50 MB request limit and every
    rubric comes back a 400. Re-encoding is what makes the whole trajectory
    sendable: the same frames cost roughly a fifth as many bytes.

    It is a view, not a conversion. The published package keeps the lossless
    originals; only the bytes shown to the judge are re-encoded. Resolution is
    left alone deliberately -- the judge has to read page text, and dropping
    below 768px on the short edge is where that stops being possible, while
    costing no fewer image tokens than full size does.
    """
    from PIL import Image  # only the judging path needs an image library

    destination.mkdir(parents=True, exist_ok=True)
    run_dirs = {path.parent for name in TRAJECTORY_FILES for path in runs_dir.rglob(name)}
    for run_dir in sorted(run_dirs):
        target = destination / run_dir.relative_to(runs_dir)
        target.mkdir(parents=True, exist_ok=True)
        renamed: dict[str, str] = {}
        for path in sorted(run_dir.iterdir()):
            if not path.is_file():
                continue
            if path.suffix.lower() in SCREENSHOT_SUFFIXES:
                new_name = f"{path.stem}.jpg"
                try:
                    with Image.open(path) as image:
                        image.convert("RGB").save(target / new_name, "JPEG", quality=quality)
                except OSError:
                    shutil.copyfile(path, target / path.name)
                    continue
                renamed[path.name] = new_name
            elif path.name not in TRAJECTORY_FILES:
                shutil.copyfile(path, target / path.name)
        # The judge reads the screenshot name out of the trajectory, so the
        # copy has to point at the re-encoded file rather than the original.
        for name in TRAJECTORY_FILES:
            source = run_dir / name
            if source.is_file():
                (target / name).write_text(
                    "".join(
                        _rewrite_screenshot_fields(line.rstrip("\n"), renamed) + "\n"
                        for line in source.read_text(encoding="utf-8").splitlines()
                        if line.strip()
                    ),
                    encoding="utf-8",
                )
    return destination


def run_screenshot_totals(runs_dir: Path) -> list[tuple[int, int]]:
    """(count, base64 bytes) of the screenshots each run would attach."""
    totals: list[tuple[int, int]] = []
    run_dirs = {path.parent for name in ("traj.jsonl", "steps.jsonl")
                for path in runs_dir.rglob(name)}
    for run_dir in sorted(run_dirs):
        sizes = [
            path.stat().st_size
            for pattern in ("*.png", "*.jpg", "*.jpeg", "*.webp")
            for path in run_dir.rglob(pattern)
        ]
        if sizes:
            totals.append((len(sizes), sum(sizes) * 4 // 3))  # base64 is what ships
    return totals


def image_cap_for(runs_dir: Path, requested: int, budget: int = IMAGE_PAYLOAD_BUDGET_BYTES) -> int:
    """A --max-images that keeps every run under the provider's payload limit.

    A trajectory long enough to blow the limit fails every one of its rubrics
    with a 400, and an all-errored task still reports average_rubric_score 0.0 --
    a silent zero indistinguishable from a model that did nothing. Capping the
    count costs some evidence; not capping it costs the whole verdict.

    The cap is set by whichever run is worst off, so one long trajectory cannot
    take down the batch, and runs that already fit are left alone.
    """
    totals = [t for t in run_screenshot_totals(runs_dir) if t[1] > budget]
    if not totals:
        return requested
    fitted = min(max(1, count * budget // payload) for count, payload in totals)
    return fitted if requested <= 0 else min(requested, fitted)


def canonical_command(
    judge_path: Path, args: argparse.Namespace, task_source: Path, raw_output: Path
) -> list[str]:
    command = [
        sys.executable,
        str(judge_path),
        "--runs-dir", str(args.runs_dir),
        "--task-source-json", str(task_source),
        "--output", str(raw_output),
        "--model", args.model,
        "--num-workers", str(args.num_workers),
        "--max-images", str(image_cap_for(args.runs_dir, args.max_images)),
        "--max-steps", str(args.max_steps),
    ]
    if args.api_base:
        command.extend(["--api-base", args.api_base])
    if args.include_incomplete:
        command.append("--include-incomplete")
    return command


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--runs-dir", type=Path, required=True)
    value.add_argument("--task-source-json", type=Path, required=True)
    value.add_argument("--output", type=Path, required=True)
    value.add_argument("--model", required=True)
    value.add_argument("--num-workers", type=int, default=1)
    value.add_argument("--max-images", type=int, default=0, help="0 = every screenshot")
    value.add_argument("--max-steps", type=int, default=0)
    value.add_argument("--api-base", default="")
    value.add_argument("--include-incomplete", action="store_true")
    value.add_argument("--cache-dir", type=Path, default=None)
    value.add_argument(
        "--no-jpeg-view", action="store_true",
        help="send the original screenshots instead of a re-encoded copy; a long "
             "trajectory will then exceed the provider's request limit",
    )
    value.add_argument("--plan", action="store_true")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    cache_dir = args.cache_dir or (args.output.parent / "canonical_judge")
    work_dir = args.output.parent
    work_dir.mkdir(parents=True, exist_ok=True)
    task_source = work_dir / "canonical_task_source.json"
    raw_output = work_dir / "canonical_raw_results.json"
    try:
        identifiers = odysseys_task_source(args.task_source_json, task_source)
        judge_path = fetch_canonical_judge(cache_dir)
        if not args.plan and not args.no_jpeg_view:
            args.runs_dir = jpeg_view(args.runs_dir, work_dir / "jpeg_runs")
        if args.plan:
            print(json.dumps({
                "judge": "odysseys-canonical",
                "commit": CANONICAL_COMMIT,
                "tasks": len(identifiers),
                # The caller refuses a plan that would judge another Apollo
                # queue's tasks, and can only check that against the IDs
                # themselves. Without them the whole canonical path is
                # unrunnable through run.py, not merely unchecked.
                "task_ids": sorted(identifiers.values()),
                "model": args.model,
                "max_images": args.max_images,
            }, indent=2))
            return 0
        subprocess.run(canonical_command(judge_path, args, task_source, raw_output), check=True)
        payload = json.loads(raw_output.read_text(encoding="utf-8"))
    except (JudgeError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    result = restore_judge_status(payload, args.model, identifiers)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    errored = sum(task.get("judge_errors", 0) for task in result["tasks"])
    print(json.dumps({
        "tasks": len(result["tasks"]),
        "rubric_errors": errored,
        "output": str(args.output),
    }, indent=2))
    return 2 if errored else 0


if __name__ == "__main__":
    raise SystemExit(main())
