#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${BASE:-http://127.0.0.1:17640}"
BOARD="${BOARD:-codex-control}"
CHECK_ENV="${CODEX_CONTROL_CHECK_ENV:-0}"
ENV_FILE="${CODEX_CONTROL_ENV_FILE:-/home/ubuntu/.hermes/codex-control.env}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" && -x /home/ubuntu/.local/bin/node ]]; then
  NODE_BIN=/home/ubuntu/.local/bin/node
fi

usage() {
  cat <<'USAGE'
Usage: dashboard-smoke.sh [options]

Options:
  --check-env               Run codex-control-env-lint.sh before smoke checks
  --no-check-env            Skip env lint (default)
  --base URL                Base URL for dashboard API (default: http://127.0.0.1:17640)
  --board NAME              Board slug for summary/state checks (default: codex-control)
  --env-file PATH           Env file path used for lint/source fallback (default: /home/ubuntu/.hermes/codex-control.env)
  --help                    Show this help
USAGE
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
    --base)
      BASE="${2:?--base requires a URL}"
      shift 2
      ;;
    --board)
      BOARD="${2:?--board requires a board name}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?--env-file requires a path}"
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

if [[ "$CHECK_ENV" == "1" ]]; then
  if [[ ! -x "$SCRIPT_DIR/codex-control-env-lint.sh" ]]; then
    echo "codex-control-env-lint.sh not found or not executable"
    exit 1
  fi
  "$SCRIPT_DIR/codex-control-env-lint.sh" --env-file "$ENV_FILE"
fi

# Load private env only as a local fallback for required auth tokens. Do not print values.
if [[ -f "${ENV_FILE}" && ( -z "${CONTROL_SHARED_SECRET:-}" || -z "${DISCORD_SHARED_SECRET:-}" ) ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${CONTROL_SHARED_SECRET:?CONTROL_SHARED_SECRET must be set}"
: "${DISCORD_SHARED_SECRET:?DISCORD_SHARED_SECRET must be set}"
: "${NODE_BIN:?node executable not found}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

code() {
  local method="$1"
  local url="$2"
  local out="$3"
  shift 3
  curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" "$@"
}

expect_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL $label expected=$expected actual=$actual"
    return 1
  fi
  echo "PASS $label"
}

expect_forbidden() {
  local actual="$1"
  local label="$2"
  if [[ "$actual" != "401" && "$actual" != "403" ]]; then
    echo "FAIL $label expected=401/403 actual=$actual"
    return 1
  fi
  echo "PASS $label"
}

health_json="$tmpdir/health.json"
summary_json="$tmpdir/summary.json"
post_json="$tmpdir/post.json"

health_code="$(code GET "$BASE/api/health" "$health_json")"
expect_code 200 "$health_code" "health"

summary_code="$(code GET "$BASE/api/summary?board=$BOARD" "$summary_json")"
expect_code 200 "$summary_code" "summary"

"$NODE_BIN" - "$summary_json" <<'NODE'
const allowed = new Set([
  'board', 'updated_at', 'summary', 'tasks',
  'total', 'done', 'running', 'ready', 'blocked', 'overallProgress', 'currentTask',
  'id', 'title', 'status', 'assignee', 'age_seconds',
  'retry_count', 'sanitized_error_class', 'progress', 'progressStage'
]);

function walk(value, path = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walk(value[i], `${path}[${i}]`);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!allowed.has(k)) throw new Error(`unexpected key: ${path}.${k}`);
      walk(v, `${path}.${k}`);
    }
    return;
  }

  if (typeof value === 'string') {
    const deny = /\/home\/|\/mnt\/|\.env|client_secret|refresh_token|authorization|OPENAI_|DISCORD_|GOOGLE_|GITHUB_|COOKIE|BEARER|TOKEN|SECRET|KEY|stdout|stderr|body|workspace|path/i;
    if (deny.test(value)) throw new Error(`sensitive string at ${path}`);
  }
}

const fs = require('node:fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('summary root must be object');
if (!Array.isArray(data.tasks)) throw new Error('summary.tasks must be an array');
if (!data.summary || typeof data.summary !== 'object' || Array.isArray(data.summary)) throw new Error('summary.summary must be an object');
walk(data);
NODE
echo "PASS summary allowlist"

no_token_code="$(code POST "$BASE/api/supervisor/tick?dryRun=1" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$no_token_code" "supervisor no token"

bad_token_code="$(code POST "$BASE/api/supervisor/tick?dryRun=1" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer bad-token' --data '{}')"
expect_forbidden "$bad_token_code" "supervisor bad token"

good_token_code="$(code POST "$BASE/api/supervisor/tick?dryRun=1" "$post_json" -H 'content-type: application/json' -H "authorization: Bearer ${CONTROL_SHARED_SECRET}" --data '{}')"
expect_code 200 "$good_token_code" "supervisor valid token dry-run"

csrf_code="$("$NODE_BIN" - "$BASE" <<'NODE'
const base = process.argv[2];
const health = await fetch(`${base}/api/health`).then((r) => r.json());
const response = await fetch(`${base}/api/supervisor/tick?dryRun=1`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    referer: `${base}/`,
    'x-control-csrf': health.csrf_token || '',
  },
  body: '{}',
});
process.stdout.write(String(response.status));
NODE
)"
expect_code 200 "$csrf_code" "supervisor valid csrf dry-run"

task_no_token_code="$(code POST "$BASE/api/tasks/create" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$task_no_token_code" "task create no token"

task_bad_token_code="$(code POST "$BASE/api/tasks/create" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer bad-token' --data '{}')"
expect_forbidden "$task_bad_token_code" "task create bad token"

state_no_token_code="$(code GET "$BASE/api/state?board=$BOARD" "$post_json")"
expect_forbidden "$state_no_token_code" "raw state no token"

state_bad_token_code="$(code GET "$BASE/api/state?board=$BOARD" "$post_json" -H 'authorization: Bearer bad-token')"
expect_forbidden "$state_bad_token_code" "raw state bad token"

discord_task_no_token_code="$(code POST "$BASE/api/discord/task" "$post_json" -H 'content-type: application/json' --data '{}')"
discord_task_bad_token_code="$(code POST "$BASE/api/discord/task" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer bad-token' --data '{}')"
expect_forbidden "$discord_task_no_token_code" "discord task no token"
expect_forbidden "$discord_task_bad_token_code" "discord task bad token"

discord_resume_no_token_code="$(code POST "$BASE/api/discord/resume" "$post_json" -H 'content-type: application/json' --data '{}')"
discord_resume_bad_token_code="$(code POST "$BASE/api/discord/resume" "$post_json" -H 'content-type: application/json' -H 'x-codex-secret: bad-token' --data '{}')"
expect_forbidden "$discord_resume_no_token_code" "discord resume no token"
expect_forbidden "$discord_resume_bad_token_code" "discord resume bad token"

echo "PASS discord authorization checks"
