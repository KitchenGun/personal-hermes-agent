#!/usr/bin/env bash
set -euo pipefail

base="${ORACLE_HERMES_DASHBOARD_HEALTH_BASE:-http://127.0.0.1:17640}"
timeout="${ORACLE_HERMES_DASHBOARD_HEALTH_TIMEOUT_SECONDS:-5}"
service="${ORACLE_HERMES_DASHBOARD_TUNNEL_SERVICE:-oracle-hermes-vm-dashboard-tunnel.service}"
recheck_delay="${ORACLE_HERMES_DASHBOARD_RECHECK_DELAY_SECONDS:-3}"

if curl -fsS --max-time "$timeout" "$base/api/health" >/dev/null; then
  exit 0
fi

echo "oracle hermes dashboard tunnel health failed; restarting ${service}"
systemctl --user restart "$service"
sleep "$recheck_delay"
curl -fsS --max-time "$timeout" "$base/api/health" >/dev/null
