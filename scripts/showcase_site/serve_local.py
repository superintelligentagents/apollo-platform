#!/usr/bin/env python3
"""Serve the showcase site locally, screenshots included.

Vercel resolves /task and /run to their .html files and runs /api/shot as a
function. A plain static server does neither, so a local preview would show
every trajectory with blank frames -- exactly the part worth checking. This
stands in for both, signing screenshots with the AWS CLI.

    scripts/showcase_site/serve_local.py [--port 8791]
"""

from __future__ import annotations

import argparse
import http.server
import os
import re
import socketserver
import subprocess
import urllib.parse
from pathlib import Path

SITE = Path(__file__).resolve().parent / "site"
BUCKET = os.environ.get("SHOWCASE_BUCKET", "journeys-prolific")
AWS = os.environ.get("AWS_CLI", "/data/user_data/ljang/apollo-osworld/bin/aws")
# Mirrors the deployed function: only trajectory screenshots may be signed.
ALLOWED = re.compile(
    r"^v2-review/trajectory-runs/[A-Za-z0-9_-]+/[a-f0-9]{16,40}/screens/\d{1,6}\.(png|jpg|jpeg|webp)$"
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/shot":
            return self._shot(urllib.parse.parse_qs(parsed.query).get("key", [""])[0])
        return super().do_GET()

    def _shot(self, key: str) -> None:
        if not ALLOWED.match(key):
            self.send_error(400, "not a trajectory screenshot key")
            return
        result = subprocess.run(
            [AWS, "s3", "presign", f"s3://{BUCKET}/{key}", "--expires-in", "3600"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            self.send_error(502, "could not sign the screenshot")
            return
        self.send_response(302)
        self.send_header("Location", result.stdout.strip())
        self.end_headers()

    def translate_path(self, path: str) -> str:
        clean = urllib.parse.urlparse(path).path
        if clean == "/":
            clean = "/index.html"
        elif "." not in clean.rsplit("/", 1)[-1]:
            clean += ".html"          # /task and /run, as Vercel's cleanUrls does
        return str(SITE / clean.lstrip("/"))

    def log_message(self, *args) -> None:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8791)
    args = parser.parse_args()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"showcase on http://127.0.0.1:{args.port}  (ctrl-c to stop)")
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
