#!/usr/bin/env python3
"""Ensure Hermes Tool Search is enabled for gateway/profile workers."""

from __future__ import annotations

import os
from pathlib import Path
import sys

import yaml

HOME = Path(os.environ.get("HERMES_HOME", "/home/ubuntu/.hermes"))
POLICY = {
    "enabled": "on",
    "threshold_pct": 0,
    "search_default_limit": 8,
    "max_search_limit": 30,
}


def _config_paths() -> list[Path]:
    paths = [HOME / "config.yaml"]
    profiles = HOME / "profiles"
    if profiles.exists():
        paths.extend(sorted(profiles.glob("*/config.yaml")))
    return [path for path in paths if path.exists()]


def _ensure_config(path: Path) -> bool:
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        data = {}
    tools = data.get("tools")
    if not isinstance(tools, dict):
        tools = {}
        data["tools"] = tools
    if tools.get("tool_search") == POLICY:
        return False
    tools["tool_search"] = dict(POLICY)
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
    return True


def main() -> int:
    changed = [str(path) for path in _config_paths() if _ensure_config(path)]
    tool_search_impl = HOME / "hermes-agent" / "tools" / "tool_search.py"
    if not tool_search_impl.exists():
        print(f"warning: Hermes Tool Search implementation missing: {tool_search_impl}", file=sys.stderr)
    if changed:
        print("hermes tool-search policy repaired")
        for path in changed:
            print(f"updated: {path}")
    else:
        print("hermes tool-search policy ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
