#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
try:
    import yaml
except Exception as exc:
    print(f"PyYAML is required for validation: {exc}")
    sys.exit(1)

root = Path(sys.argv[1])
required = ["name", "description", "schedule", "trigger", "input", "steps", "output", "tools", "model", "safety", "status"]
paths = sorted((root / "jobs").rglob("*.yaml"))
if not paths:
    print("No registry YAML files found under jobs/.")
    sys.exit(1)
failed = False
for path in paths:
    data = yaml.safe_load(path.read_text()) or {}
    missing = [field for field in required if field not in data]
    if missing:
        print(f"{path}: missing {', '.join(missing)}")
        failed = True
    if data.get("status") not in {"enabled", "disabled", "draft"}:
        print(f"{path}: status must be enabled, disabled, or draft")
        failed = True
if failed:
    sys.exit(1)
print(f"Validated {len(paths)} job registry file(s).")
PY
