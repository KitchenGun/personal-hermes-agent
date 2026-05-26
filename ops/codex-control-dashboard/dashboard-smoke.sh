#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:17640}"
BOARD="${BOARD:-codex-control}"
: "${CONTROL_SHARED_SECRET:?CONTROL_SHARED_SECRET must be set}"

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

node - "$summary_json" <<'JS'
const allowed = new Set([
  'board','updated_at','summary','tasks',
  'total','done','running','ready','blocked',
  'id','title','status','assignee','age_seconds',
  'retry_count','sanitized_error_class'
]);

function walk(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`));
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
if (!Array.isArray(data.tasks)) throw new Error('summary.tasks must be array');
if (!data.summary || typeof data.summary !== 'object' || Array.isArray(data.summary)) throw new Error('summary.summary must be object');
walk(data);
JS
echo "PASS summary allowlist"

no_token_code="$(code POST "$BASE/api/supervisor/tick?dryRun=1" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$no_token_code" "supervisor no token"

bad_token_code="$(code POST "$BASE/api/supervisor/tick?dryRun=1" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$bad_token_code" "supervisor bad token"

good_token_code="$(code POST "$BASE/api/supervisor/tick?dryRun=1" "$post_json" -H 'content-type: application/json' -H "authorization: Bearer $CONTROL_SHARED_SECRET" --data '{}')"
expect_code 200 "$good_token_code" "supervisor valid token dry-run"

csrf_code="$(node - "$BASE" <<'JS'
const base = process.argv[2];
const health = await fetch(`${base}/api/health`).then((r) => r.json());
const response = await fetch(`${base}/api/supervisor/tick?dryRun=1`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'referer': `${base}/`,
    'x-control-csrf': health.csrf_token || '',
  },
  body: '{}',
});
process.stdout.write(String(response.status));
JS
)"
expect_code 200 "$csrf_code" "supervisor valid csrf dry-run"

task_no_token_code="$(code POST "$BASE/api/tasks/create" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$task_no_token_code" "task create no token"

task_bad_token_code="$(code POST "$BASE/api/tasks/create" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$task_bad_token_code" "task create bad token"

state_no_token_code="$(code GET "$BASE/api/state?board=$BOARD" "$post_json")"
expect_forbidden "$state_no_token_code" "raw state no token"

state_bad_token_code="$(code GET "$BASE/api/state?board=$BOARD" "$post_json" -H 'authorization: Bearer invalid')"
expect_forbidden "$state_bad_token_code" "raw state bad token"

discord_task_no_token_code="$(code POST "$BASE/api/discord/task" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$discord_task_no_token_code" "discord task no token"

discord_task_bad_token_code="$(code POST "$BASE/api/discord/task" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$discord_task_bad_token_code" "discord task bad token"

discord_resume_no_token_code="$(code POST "$BASE/api/discord/resume" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$discord_resume_no_token_code" "discord resume no token"

discord_resume_bad_token_code="$(code POST "$BASE/api/discord/resume" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$discord_resume_bad_token_code" "discord resume bad token"
