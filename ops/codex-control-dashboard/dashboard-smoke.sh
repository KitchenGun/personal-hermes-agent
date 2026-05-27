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
dashboard_html="$tmpdir/dashboard.html"
asset_out="$tmpdir/asset.out"
summary_json="$tmpdir/summary.json"
post_json="$tmpdir/post.json"
supervisor_snapshot_json="$tmpdir/supervisor-snapshot.json"

health_code="$(code GET "$BASE/api/health" "$health_json")"
expect_code 200 "$health_code" "health"

dashboard_code="$(code GET "$BASE/" "$dashboard_html")"
expect_code 200 "$dashboard_code" "dashboard root"

node - "$dashboard_html" <<'JS'
const fs = require('node:fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
if (!html.includes('Kanban Control Dashboard')) {
  throw new Error('dashboard root did not include expected title');
}
JS
echo "PASS dashboard root content"

app_code="$(code GET "$BASE/app.js" "$asset_out")"
expect_code 200 "$app_code" "dashboard app.js"

styles_code="$(code GET "$BASE/styles.css" "$asset_out")"
expect_code 200 "$styles_code" "dashboard styles.css"

tick_get_code="$(code GET "$BASE/api/supervisor/tick" "$post_json" -H 'accept: text/html')"
expect_code 302 "$tick_get_code" "browser GET supervisor tick redirects"

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

supervisor_snapshot_code="$(code GET "$BASE/api/supervisor" "$supervisor_snapshot_json")"
expect_code 200 "$supervisor_snapshot_code" "supervisor snapshot"

node - "$supervisor_snapshot_json" <<'JS'
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (data.intervalMs !== 300000) {
  throw new Error(`supervisor default intervalMs expected 300000 got ${data.intervalMs}`);
}
JS
echo "PASS supervisor default intervalMs"
read -r initial_supervisor_enabled initial_supervisor_interval < <(node - "$supervisor_snapshot_json" <<'JS'
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(`${Boolean(data.enabled)} ${Number(data.intervalMs)}`);
JS
)

start_code="$(code POST "$BASE/api/supervisor/start" "$post_json" -H 'content-type: application/json' -H "authorization: Bearer $CONTROL_SHARED_SECRET" --data '{"intervalMs":300000}')"
expect_code 200 "$start_code" "supervisor start intervalMs 300000"

node - "$post_json" <<'JS'
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (data.intervalMs !== 300000) {
  throw new Error(`supervisor start intervalMs expected 300000 got ${data.intervalMs}`);
}
JS
echo "PASS supervisor start intervalMs preserved"

if [[ "$initial_supervisor_enabled" == "false" ]]; then
  supervisor_stop_code="$(code POST "$BASE/api/supervisor/stop" "$post_json" -H 'content-type: application/json' -H "authorization: Bearer $CONTROL_SHARED_SECRET" --data '{}')"
  expect_code 200 "$supervisor_stop_code" "supervisor stop cleanup"
else
  if [[ "$initial_supervisor_interval" != "300000" ]]; then
    supervisor_restore_code="$(code POST "$BASE/api/supervisor/start" "$post_json" -H 'content-type: application/json' -H "authorization: Bearer $CONTROL_SHARED_SECRET" --data "{\"intervalMs\":$initial_supervisor_interval}")"
    expect_code 200 "$supervisor_restore_code" "supervisor restore interval"
  fi
fi

task_no_token_code="$(code POST "$BASE/api/tasks/create" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$task_no_token_code" "task create no token"

task_bad_token_code="$(code POST "$BASE/api/tasks/create" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$task_bad_token_code" "task create bad token"

state_no_token_code="$(code GET "$BASE/api/state?board=$BOARD" "$post_json")"
expect_forbidden "$state_no_token_code" "raw state no token"

state_bad_token_code="$(code GET "$BASE/api/state?board=$BOARD" "$post_json" -H 'authorization: Bearer invalid')"
expect_forbidden "$state_bad_token_code" "raw state bad token"

task_detail_no_token_code="$(code GET "$BASE/api/task-detail?board=$BOARD&id=t_example" "$post_json")"
expect_forbidden "$task_detail_no_token_code" "task detail no token"

task_detail_bad_token_code="$(code GET "$BASE/api/task-detail?board=$BOARD&id=t_example" "$post_json" -H 'authorization: Bearer invalid')"
expect_forbidden "$task_detail_bad_token_code" "task detail bad token"

sns_approval_no_token_code="$(code POST "$BASE/api/sns/approval" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$sns_approval_no_token_code" "sns approval no token"

sns_approval_bad_token_code="$(code POST "$BASE/api/sns/approval" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$sns_approval_bad_token_code" "sns approval bad token"

discord_task_no_token_code="$(code POST "$BASE/api/discord/task" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$discord_task_no_token_code" "discord task no token"

discord_task_bad_token_code="$(code POST "$BASE/api/discord/task" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$discord_task_bad_token_code" "discord task bad token"

discord_resume_no_token_code="$(code POST "$BASE/api/discord/resume" "$post_json" -H 'content-type: application/json' --data '{}')"
expect_forbidden "$discord_resume_no_token_code" "discord resume no token"

discord_resume_bad_token_code="$(code POST "$BASE/api/discord/resume" "$post_json" -H 'content-type: application/json' -H 'authorization: Bearer invalid' --data '{}')"
expect_forbidden "$discord_resume_bad_token_code" "discord resume bad token"
