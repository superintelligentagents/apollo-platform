#!/usr/bin/env python3
"""Publish judge identity for immutable trajectory packages that omitted it.

The registry contains no scores or verdicts. It lets the reporting API name
the judge for an existing packaged judgment without rewriting the package or
mislabeling that judgment as a re-judgment.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

SCHEMA_VERSION = "apollo-trajectory-judge-provenance-v1"
REGISTRY_KEY = "v2-review/trajectory-judge-provenance.json"


def registry_document(
    rows: Sequence[Mapping[str, Any]],
    *,
    run_model: str,
    judge_model: str,
    repo: str | None = None,
    commit: str | None = None,
    path: str | None = None,
    sha256: str | None = None,
    screenshots: str | None = None,
) -> dict[str, Any]:
    judge = {
        "model": judge_model,
        "repo": repo,
        "commit": commit,
        "path": path,
        "sha256": sha256,
        "screenshots": screenshots,
    }
    entries = [
        {"manifest_key": str(row["manifest_key"]), "judge": judge}
        for row in rows
        if row.get("model") == run_model and row.get("manifest_key")
    ]
    keys = [entry["manifest_key"] for entry in entries]
    if len(keys) != len(set(keys)):
        raise ValueError("trajectory rows contain duplicate manifest_key values")
    return {
        "schema_version": SCHEMA_VERSION,
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "entries": entries,
    }


def upload(document: Mapping[str, Any], key: str, bucket: str, aws_cli: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        result = subprocess.run(
            [aws_cli, "s3api", "put-object", "--bucket", bucket, "--key", key,
             "--body", handle.name, "--content-type", "application/json",
             "--if-none-match", "*"],
            check=False, capture_output=True, text=True,
        )
    return "" if result.returncode == 0 else (result.stderr or "").strip()[-500:]


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--trajectories", type=Path, required=True)
    value.add_argument("--run-model", required=True)
    value.add_argument("--judge-model", required=True)
    value.add_argument("--repo")
    value.add_argument("--commit")
    value.add_argument("--path")
    value.add_argument("--sha256")
    value.add_argument("--screenshots")
    value.add_argument("--bucket", default="journeys-prolific")
    value.add_argument("--key", default=REGISTRY_KEY)
    value.add_argument("--aws-cli", default="aws")
    value.add_argument("--plan", action="store_true")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    raw = json.loads(args.trajectories.read_text(encoding="utf-8"))
    rows = raw.get("trajectories") if isinstance(raw, Mapping) else raw
    if not isinstance(rows, list):
        raise ValueError("trajectories must be a list or an API response with trajectories")
    document = registry_document(
        rows,
        run_model=args.run_model,
        judge_model=args.judge_model,
        repo=args.repo,
        commit=args.commit,
        path=args.path,
        sha256=args.sha256,
        screenshots=args.screenshots,
    )
    summary = {
        "entries": len(document["entries"]),
        "bucket": args.bucket,
        "key": args.key,
        "run_model": args.run_model,
        "judge_model": args.judge_model,
    }
    if args.plan:
        print(json.dumps(summary, indent=2))
        return 0
    error = upload(document, args.key, args.bucket, args.aws_cli)
    print(json.dumps({**summary, "uploaded": not bool(error), "error": error or None}, indent=2))
    return 1 if error else 0


if __name__ == "__main__":
    raise SystemExit(main())
