#!/usr/bin/env python3
"""Lint codex-control.env without printing secret values."""

from __future__ import annotations

import argparse
import json
import os
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, List, Tuple

KNOWN_KEYS: Dict[str, str] = {
    # Core server
    "HOST": "string",
    "PORT": "int:1:65535",
    "HERMES_BIN": "path",
    "HERMES_EXEC_MODE": "enum:native,direct,wsl",
    # Dashboard
    "DASHBOARD_BOARDS": "csv",
    "DASHBOARD_STATE_MODE": "enum:sqlite,sqlite3,both,none",
    "DASHBOARD_FAST_STATE": "bool",
    "DASHBOARD_INCLUDE_ARCHIVED": "bool",
    # Supervisor
    "SUPERVISOR_AUTO_START": "bool",
    "SUPERVISOR_BOARD": "string",
    "SUPERVISOR_CONCURRENCY": "int:1:32",
    "SUPERVISOR_HEALTH_GATE_ENABLED": "bool",
    "SUPERVISOR_HEALTH_GATE_PROBE_INTERVAL_SECONDS": "int:60:3600",
    "SUPERVISOR_CRASH_STORM_THRESHOLD": "int:2:8",
    "SUPERVISOR_CRASH_STORM_WINDOW_SECONDS": "int:60:86400",
    "SUPERVISOR_CRASH_STORM_SCAN_LIMIT": "int:1:100",
    "SUPERVISOR_IDLE_BACKOFF_MAX_MS": "int:1000:300000",
    # Cache / queue behavior
    "SUMMARY_CACHE_TTL_MS": "int:1:600000",
    "SUMMARY_CACHE_SWR_MS": "int:1:600000",
    "QUEUE_EXECUTION_PROFILE": "string",
    "QUEUE_SPAWNABLE_PROFILES": "csv",
    "QUEUE_AUTO_SWARM": "bool",
    "QUEUE_AUTO_SWARM_MAX_WORKERS": "int:1:20",
    # Control/discord auth
    "CONTROL_SHARED_SECRET": "secret",
    "DISCORD_SHARED_SECRET": "secret",
    "DISCORD_BOT_TOKEN": "secret",
    "DISCORD_PUBLIC_KEY": "string",
    "DISCORD_INTERACTIONS_ENABLED": "bool",
    # Discord relay runtime knobs
    "DISCORD_ALLOWED_USER_IDS": "csv",
    "DISCORD_CHANNEL_IDS": "csv",
    "DISCORD_GATEWAY_QUEUE_CHANNEL_IDS": "csv",
    "DISCORD_RELAY_ENDPOINT": "url",
    "DISCORD_RESUME_ENDPOINT": "url",
    "DISCORD_STATE_ENDPOINT": "url",
    "DISCORD_RELAY_PRUNE_AFTER_MS": "int:1000:604800000",
    "DISCORD_QUEUE_ONLY": "bool",
    "DISCORD_MAX_ATTACHMENT_BYTES": "int:1024:20000000",
    "DISCORD_QUEUE_NOTICE_COOLDOWN_MS": "int:1000:3600000",
    "DISCORD_RELAY_STATE": "path",
    "DISCORD_NOTIFY_INTERVAL_MS": "int:1000:3600000",
    # Misc
    "SUMMARY_FILTER_TEXT": "string",
}


_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def split_csv(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def parse_bool(value: str) -> bool:
    return bool(re.fullmatch(r"(?i)(0|1|true|false|yes|no|on|off)", value.strip()))


def parse_int(value: str, min_value: int | None = None, max_value: int | None = None) -> Tuple[bool, str]:
    if not re.fullmatch(r"[-+]?\d+", value.strip()):
        return False, "not an integer"
    num = int(value)
    if min_value is not None and num < min_value:
        return False, f"too small ({num} < {min_value})"
    if max_value is not None and num > max_value:
        return False, f"too large ({num} > {max_value})"
    return True, ""


def suggest_key(key: str) -> List[str]:
    # Find close known keys by similarity/typo pattern
    candidates = []
    for known in KNOWN_KEYS:
        score = SequenceMatcher(None, key, known).ratio()
        if score >= 0.8:
            candidates.append((score, known))
    candidates.sort(reverse=True)
    return [name for _, name in candidates[:3]]


def validate_key(key: str, value: str, seen: set[str], warnings: List[str], errors: List[str]) -> None:
    if not _KEY_RE.fullmatch(key):
        errors.append(f"Malformed env key [{key}] (invalid characters or format)")
        return

    if key in seen:
        errors.append(f"Duplicated key: {key}")
        return
    seen.add(key)

    if key not in KNOWN_KEYS:
        # Flag likely typo patterns like nSUPERVISOR_*
        if (key.startswith("n") and key[1:] in KNOWN_KEYS) or (key[:-1] in KNOWN_KEYS and key.endswith(" ")):
            errors.append(f"Unknown key '{key}' looks like typo for '{key[1:]}'")
        else:
            suggestions = suggest_key(key)
            if suggestions:
                warnings.append(f"Unknown key '{key}' (possible typo). did you mean: {', '.join(suggestions)}")
            else:
                warnings.append(f"Unknown key '{key}' (not in current schema)")
        return

    spec = KNOWN_KEYS[key]
    kind, *params = spec.split(":", 1)

    if kind == "int":
        if ":" in spec:
            _, minmax = spec.split(":", 1)
            min_value, max_value = (int(x) for x in minmax.split(":"))
        else:
            min_value = max_value = None
        ok, reason = parse_int(value, min_value, max_value)
        if not ok:
            errors.append(f"Invalid integer for {key}: {reason}")
        return

    if kind == "bool":
        if not parse_bool(value):
            errors.append(f"Invalid boolean for {key}: {value}")
        return

    if kind == "enum":
        _, allowed = spec.split(":", 1)
        values = {v.strip() for v in allowed.split(",") if v.strip()}
        if value.strip() not in values:
            errors.append(f"Invalid value for {key}: '{value}' (allowed: {', '.join(sorted(values))})")
        return

    if kind == "csv":
        if value.strip() == "":
            return
        if key.endswith("_IDS"):
            items = split_csv(value)
            bad = [x for x in items if not re.fullmatch(r"\d+", x)]
            if bad:
                errors.append(f"Invalid numeric ID list for {key}: {bad[:5]}")
        return

    if kind == "url":
        if not re.match(r"^https?://", value.strip()):
            errors.append(f"Invalid URL for {key}: {value}")
        return

    if kind in {"string", "path", "secret"}:
        if kind == "path" and value.strip() and not os.path.isabs(value.strip()):
            warnings.append(f"Path-like value for {key} is not absolute: {value}")
        return

    # fallthrough: no schema rule


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate codex-control.env keys and values")
    parser.add_argument("--env-file", default=os.environ.get("CODEX_CONTROL_ENV_PATH", "/home/ubuntu/.hermes/codex-control.env"))
    parser.add_argument("--treat-warnings-as-errors", action="store_true", help="Fail when unknown keys exist")
    parser.add_argument("--json", action="store_true", help="Output machine-readable result")
    args = parser.parse_args()

    path = Path(args.env_file)
    if not path.exists():
        msg = f"[ERROR] env file not found: {path}"
        if args.json:
            print(json.dumps({"ok": False, "errors": [msg], "warnings": [], "path": str(path)}, sort_keys=True))
        else:
            print(msg)
        return 2

    env_text = path.read_text().splitlines()
    seen: set[str] = set()
    errors: List[str] = []
    warnings: List[str] = []

    for lineno, raw_line in enumerate(env_text, 1):
        line = raw_line.strip("\n\r")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if stripped.startswith("export "):
            stripped = stripped[7:].strip()

        if "=" not in stripped:
            errors.append(f"Line {lineno}: malformed line (missing '=')")
            continue

        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip()
        validate_key(key, value, seen, warnings, errors)

    if not env_text:
        warnings.append("Empty env file")

    ok = not errors and (not (args.treat_warnings_as_errors and warnings))

    if args.json:
        print(json.dumps({
            "ok": ok,
            "file": str(path),
            "errors": errors,
            "warnings": warnings,
            "unknown_count": len([w for w in warnings if w.startswith("Unknown key")]),
        }, sort_keys=True))
    else:
        if errors:
            print("codex-control env lint: FAILED")
            for item in errors:
                print(f"- ERROR: {item}")
        elif warnings:
            print("codex-control env lint: WARN")
            for item in warnings:
                print(f"- WARN: {item}")
        else:
            print("codex-control env lint: PASS")

    if not ok:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
