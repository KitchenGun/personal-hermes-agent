#!/usr/bin/env bash
set -euo pipefail

# Secret-safe VM runtime drift audit. Run on the VM. It prints paths, hashes,
# service state, and MCP command executability without dumping config values.

REPO_ROOT="${1:-/home/ubuntu/work/personal-hermes-agent}"
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes}"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

echo "== repo =="
if [[ -d "$REPO_ROOT/.git" ]]; then
  git -C "$REPO_ROOT" status --short
  git -C "$REPO_ROOT" status -sb
fi

echo
echo "== dashboard runtime hashes =="
for rel in server.js discord-relay.js dashboard-healthcheck.sh dashboard-smoke.sh public/app.js; do
  repo="$REPO_ROOT/ops/codex-control-dashboard/$rel"
  runtime="$HERMES_HOME/codex-control-dashboard/$rel"
  [[ -e "$repo" && -e "$runtime" ]] || { echo "missing $rel"; continue; }
  repo_hash=$(sha256sum "$repo" | awk '{print $1}')
  runtime_hash=$(sha256sum "$runtime" | awk '{print $1}')
  status="ok"
  [[ "$repo_hash" == "$runtime_hash" ]] || status="diff"
  echo "$status $rel repo=$repo_hash runtime=$runtime_hash"
done

echo
echo "== user services =="
if command -v systemctl >/dev/null 2>&1; then
  for svc in codex-control-api.service codex-discord-relay.service hermes-dashboard.service codex-control-api-healthcheck.timer; do
    systemctl --user is-active "$svc" >/dev/null 2>&1 && active=active || active=inactive
    echo "$svc $active"
  done
fi

echo
echo "== user systemd files =="
for file in codex-control-api.service codex-discord-relay.service codex-control-api-healthcheck.service codex-control-api-healthcheck.timer hermes-dashboard.service; do
  repo="$REPO_ROOT/ops/systemd/user/$file"
  runtime="$USER_SYSTEMD_DIR/$file"
  [[ -e "$repo" || -e "$runtime" ]] || continue
  repo_hash="missing"
  runtime_hash="missing"
  [[ -e "$repo" ]] && repo_hash=$(sha256sum "$repo" | awk '{print $1}')
  [[ -e "$runtime" ]] && runtime_hash=$(sha256sum "$runtime" | awk '{print $1}')
  status="ok"
  [[ "$repo_hash" == "$runtime_hash" ]] || status="diff"
  echo "$status $file repo=$repo_hash runtime=$runtime_hash"
done

echo
echo "== mcp commands =="
python3 - <<'PY'
from pathlib import Path
import re
config = Path('/home/ubuntu/.hermes/config.yaml')
if not config.exists():
    print('missing config')
    raise SystemExit
current = None
command = None
enabled = None
for raw in config.read_text(encoding='utf-8').splitlines():
    if re.match(r'^  [A-Za-z0-9_.-]+:', raw):
        if current and command:
            path = Path(command).expanduser()
            print(f'{current} enabled={enabled} command_exists={path.exists()} executable={path.exists() and path.is_file() and bool(path.stat().st_mode & 0o111)}')
        current = raw.strip().rstrip(':')
        command = None
        enabled = None
    elif current and raw.strip().startswith('command:'):
        command = raw.split(':', 1)[1].strip().strip('"').strip("'")
    elif current and raw.strip().startswith('enabled:'):
        enabled = raw.split(':', 1)[1].strip()
if current and command:
    path = Path(command).expanduser()
    print(f'{current} enabled={enabled} command_exists={path.exists()} executable={path.exists() and path.is_file() and bool(path.stat().st_mode & 0o111)}')
PY
