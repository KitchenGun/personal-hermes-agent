# Codex Control Dashboard

This document records the public-safe operating state for the Hermes VM control dashboard.

## Compared State

Live VM state checked before versioning:

- dashboard/control API runs as `codex-control-api.service`
- Discord bot relay runs as `codex-discord-relay.service`
- dashboard listens on `127.0.0.1:17640`
- local access is via SSH tunnel
- repo previously had no versioned dashboard runtime source

Sensitive live values were not copied. The repository contains placeholders and examples only.

## Security Requirements

- `CONTROL_SHARED_SECRET` is required for dashboard/control mutating APIs.
- `DISCORD_SHARED_SECRET` is required for relay-to-control API calls.
- `DISCORD_PUBLIC_KEY` is required only when Discord Interactions are enabled.
- `/api/summary` must return an allowlist DTO only.
- `/api/task-detail` requires relay auth and returns sanitized blocked-task context only.
- `/api/state` is raw state and requires auth.
- `/api/sns/approval` accepts only authenticated control traffic or relay traffic and returns sanitized status only.
- Dashboard must bind to `127.0.0.1`, not `0.0.0.0`.
- `codex-control.env` must be mode `600`.
- dashboard directory should be mode `750` or stricter.
- VM runtime should use `HERMES_EXEC_MODE=direct`; `native` is only for Windows-to-WSL control.
- If `DASHBOARD_STATE_MODE=sqlite` is configured but `board-state.py` is not deployed, the dashboard falls back to `hermes kanban list`.

## VM-local heartbeat sweep

- Supervisor heartbeat sweep runs on the VM with local binding (`127.0.0.1`) and non-secret runtime state.
- The dashboard service does not auto-start the internal supervisor timer by default; VM-local Codex heartbeat calls one active sweep every 5m.
- The default interval is `300000` ms (5m), and it can be changed only through authenticated control actions.
- Immediate dispatch is retained after task create, user-input resume, and manual tick (`/api/supervisor/tick`) for urgent queue drain.
- All mutating control traffic uses `CONTROL_SHARED_SECRET` or localhost CSRF, while inter-component relay calls use `DISCORD_SHARED_SECRET`.

Heartbeat command template:

```bash
. ~/.hermes/codex-control.env
curl -fsS -X POST "http://127.0.0.1:17640/api/supervisor/tick" \
  -H "Authorization: Bearer $CONTROL_SHARED_SECRET" \
  -H "content-type: application/json" \
  -d "{}"
```

## Summary DTO

Allowed fields:

- `board`
- `updated_at`
- `summary.total`
- `summary.done`
- `summary.running`
- `summary.ready`
- `summary.blocked`
- `tasks[].id`
- `tasks[].title`
- `tasks[].status`
- `tasks[].assignee`
- `tasks[].age_seconds`
- `tasks[].retry_count`
- `tasks[].sanitized_error_class`
- `tasks[].updated_at`

Forbidden in responses:

- raw task body
- workspace path
- command text
- stdout or stderr
- env key names or values
- token, secret, key, cookie, session material
- private `/home/` or `/mnt/` paths

## Acceptance

Run `ops/codex-control-dashboard/dashboard-smoke.sh` after deployment.

Expected checks:

- health endpoint returns `200`
- dashboard root `/` returns HTML and static assets
- browser GET `/api/supervisor/tick` redirects to `/`
- summary endpoint returns only allowlisted keys
- task detail endpoint rejects unauthenticated access
- summary strings do not match sensitive deny patterns
- no-token mutating POST returns `401` or `403`
- bad-token mutating POST returns `401` or `403`
- valid bearer token dry-run returns `200`
- localhost CSRF dry-run returns `200`
- supervisor default `intervalMs` is `300000`
- starting supervisor with `intervalMs=300000` preserves the 5m interval
- raw `/api/state` rejects unauthenticated access
- Discord relay mutation endpoints reject unauthenticated access
- SNS approval endpoint rejects unauthenticated access
