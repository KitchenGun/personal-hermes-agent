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
- `/api/state` is raw state and requires auth.
- Dashboard must bind to `127.0.0.1`, not `0.0.0.0`.
- `codex-control.env` must be mode `600`.
- dashboard directory should be mode `750` or stricter.

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
- summary endpoint returns only allowlisted keys
- summary strings do not match sensitive deny patterns
- no-token mutating POST returns `401` or `403`
- bad-token mutating POST returns `401` or `403`
- valid bearer token dry-run returns `200`
- localhost CSRF dry-run returns `200`
- raw `/api/state` rejects unauthenticated access
- Discord relay mutation endpoints reject unauthenticated access
