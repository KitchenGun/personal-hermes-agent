#!/usr/bin/env bash
set -euo pipefail

service="${CODEX_CONTROL_HEALTH_SERVICE:-codex-control-api.service}"
port="${PORT:-17640}"
base="${CODEX_CONTROL_HEALTH_BASE:-http://127.0.0.1:${port}}"
timeout="${CODEX_CONTROL_HEALTH_TIMEOUT_SECONDS:-5}"
recheck_delay="${CODEX_CONTROL_HEALTH_RECHECK_DELAY_SECONDS:-3}"

if curl -fsS --max-time "$timeout" "$base/api/health" >/dev/null; then
  exit 0
fi

echo "codex-control-api health check failed; restarting ${service}"
systemctl --user restart "$service"
sleep "$recheck_delay"
curl -fsS --max-time "$timeout" "$base/api/health" >/dev/null
