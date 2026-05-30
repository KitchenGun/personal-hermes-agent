#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="${CODEX_CONTROL_HEALTH_SERVICE:-codex-control-api.service}"
RELAY_SERVICE="${CODEX_CONTROL_RELAY_SERVICE:-codex-discord-relay.service}"
CHECK_RELAY="${CODEX_CONTROL_HEALTH_CHECK_RELAY:-1}"
CHECK_AUTH="${CODEX_CONTROL_HEALTH_CHECK_AUTH:-1}"
PORT="${PORT:-17640}"
BASE="${CODEX_CONTROL_HEALTH_BASE:-http://127.0.0.1:${PORT}}"
TIMEOUT="${CODEX_CONTROL_HEALTH_TIMEOUT_SECONDS:-5}"
RECHECK_DELAY="${CODEX_CONTROL_HEALTH_RECHECK_DELAY_SECONDS:-3}"
CHECK_ENV="${CODEX_CONTROL_CHECK_ENV:-0}"
ENV_FILE="${CODEX_CONTROL_ENV_FILE:-/home/ubuntu/.hermes/codex-control.env}"

usage() {
  cat <<'EOF'
Usage: dashboard-healthcheck.sh [options]

Options:
  --check-env               Run codex-control-env-lint.sh before healthcheck
  --no-check-env            Skip env lint (default)
  --env-file PATH           Env file path used for lint/source fallback (default: /home/ubuntu/.hermes/codex-control.env)
  --help                    Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-env)
      CHECK_ENV=1
      shift
      ;;
    --no-check-env)
      CHECK_ENV=0
      shift
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ "$CHECK_ENV" == "1" ]]; then
  if [[ ! -x "$SCRIPT_DIR/codex-control-env-lint.sh" ]]; then
    echo "codex-control-env-lint.sh not found or not executable"
    exit 1
  fi
  "$SCRIPT_DIR/codex-control-env-lint.sh" --env-file "$ENV_FILE"
fi

check_api() {
  curl -fsS --max-time "$TIMEOUT" "$BASE/api/health" >/dev/null || return 1
  curl -fsS --max-time "$TIMEOUT" "$BASE/" >/dev/null || return 1
  curl -fsS --max-time "$TIMEOUT" "$BASE/api/summary?board=codex-control" >/dev/null || return 1
  if [[ "$CHECK_AUTH" == "1" && -n "${CONTROL_SHARED_SECRET:-}" ]]; then
    curl -fsS --max-time "$TIMEOUT" -H "authorization: Bearer ${CONTROL_SHARED_SECRET}" "$BASE/api/summary?board=codex-control" >/dev/null || return 1
  fi
}

check_relay() {
  [[ "$CHECK_RELAY" == "1" ]] || return 0
  systemctl --user is-active --quiet "$RELAY_SERVICE"
}

if check_api && check_relay; then
  exit 0
fi

echo "codex-control normal-service health check failed; restarting ${SERVICE} and ${RELAY_SERVICE} if needed"
systemctl --user restart "$SERVICE"
if [[ "$CHECK_RELAY" == "1" ]]; then
  systemctl --user restart "$RELAY_SERVICE"
fi
sleep "$RECHECK_DELAY"
check_api
check_relay
