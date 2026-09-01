#!/usr/bin/env python3
"""Launch upstream OSWorld Muse Spark while attaching Meta's session header."""

from __future__ import annotations

import os
import runpy
from pathlib import Path
from typing import Any

import httpx
import openai
from docker.models.containers import Container


def _session_headers(headers: Any = None) -> dict[str, str]:
    result = dict(headers or {})
    result.setdefault("x-session-id", os.environ["MUSE_SPARK_SESSION_ID"])
    return result


_OpenAI = openai.OpenAI


def _openai_with_session(*args: Any, **kwargs: Any) -> Any:
    kwargs["default_headers"] = _session_headers(kwargs.get("default_headers"))
    return _OpenAI(*args, **kwargs)


_httpx_post = httpx.post
_docker_remove = Container.remove


def _post_with_session(*args: Any, **kwargs: Any) -> Any:
    kwargs["headers"] = _session_headers(kwargs.get("headers"))
    return _httpx_post(*args, **kwargs)


def _remove_with_anonymous_volumes(self: Container, **kwargs: Any) -> Any:
    """Remove OSWorld's disposable /storage volume with its VM container."""
    kwargs.setdefault("v", True)
    return _docker_remove(self, **kwargs)


def main() -> None:
    runner = Path(os.environ["MUSE_SPARK_RUNNER_PATH"]).resolve()
    if not runner.is_file():
        raise SystemExit(f"Muse Spark runner not found: {runner}")
    openai.OpenAI = _openai_with_session
    httpx.post = _post_with_session
    Container.remove = _remove_with_anonymous_volumes
    runpy.run_path(str(runner), run_name="__main__")


if __name__ == "__main__":
    main()
