# Personal Hermes Agent

Public-safe operating profile and operations source for a personal Hermes Agent.

This repository documents how the agent is run, what is allowed to be published,
and which repeatable jobs, skills, prompts, scripts, and VM operations artifacts
belong under version control.

## Current Operating Model

- The Hermes VM is the single operating source of truth.
- Local WSL is limited to SSH tunneling plus inactive backup/cache roles.
- Secrets, tokens, sessions, cookies, raw logs, raw DB files, gateway state, and
  private workspace paths are not committed.
- Runtime state lives outside this repository and is represented here only by
  sanitized examples.
- Dashboard/control API security is a required acceptance condition, not an
  optional hardening task.

## What This Repository Contains

| Path | Purpose |
| --- | --- |
| `docs/` | Architecture, jobs, memory, tools, gateway, cron, delegation, and operations notes. |
| `jobs/` | Sanitized Job Registry YAML files for repeatable work. |
| `skills/` | Reusable Hermes skill examples and conventions. |
| `prompts/` | Reusable system, workflow, and template prompts. |
| `scripts/examples/` | Public-safe validation and registry helper scripts. |
| `config/` | Placeholder-only configuration examples. |
| `ops/` | Public-safe VM operations source and deployment examples. |

## VM Dashboard And Control API

The current VM operation includes a versioned Codex Control Dashboard under:

```text
ops/codex-control-dashboard/
```

It contains:

- dashboard/control API runtime
- static dashboard UI
- Discord relay runtime
- summary DTO and auth smoke tests
- placeholder-only environment example
- systemd user service examples

Security model:

- dashboard binds to `127.0.0.1`
- mutating control endpoints require `CONTROL_SHARED_SECRET` or localhost CSRF
- Discord relay endpoints require `DISCORD_SHARED_SECRET`
- `DISCORD_PUBLIC_KEY` is required only when Discord Interactions are enabled
- `/api/summary` returns an allowlist DTO, not redacted raw task objects
- raw `/api/state` requires auth

See:

- `ops/README.md`
- `docs/12-codex-control-dashboard.md`

## Summary Endpoint Contract

`/api/summary` may expose only:

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

It must not expose raw task body, workspace path, raw command, stdout, stderr,
environment key names, token-like strings, cookie/session material, or private
filesystem paths.

## Validation

Run before publishing:

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
```

Run on the VM after dashboard deployment:

```bash
set -a
. ~/.hermes/codex-control.env
set +a
bash ~/.hermes/codex-control-dashboard/dashboard-smoke.sh
```

Expected smoke coverage:

- health endpoint returns `200`
- summary endpoint matches the allowlist schema
- summary strings do not match sensitive deny patterns
- no-token mutating requests return `401` or `403`
- bad-token mutating requests return `401` or `403`
- valid bearer token dry-run returns `200`
- valid localhost CSRF dry-run returns `200`
- raw state endpoint rejects unauthenticated access
- Discord relay mutation endpoints reject unauthenticated access

## Publication Rules

Never commit:

- filled `.env` files
- real API keys, OAuth tokens, cookies, sessions, or Discord bot tokens
- real Discord user, channel, or server IDs
- raw Hermes sessions, checkpoints, DB files, logs, or gateway state
- private memory, prompts, workspace paths, or personal identifiers

Use placeholders such as:

- `<YOUR_DISCORD_BOT_TOKEN>`
- `<YOUR_DISCORD_CHANNEL_ID>`
- `<GENERATE_WITH_PASSWORD_MANAGER>`
- `${HERMES_MODEL}`

## Deployment Notes

The files in `ops/` are public-safe source artifacts, not a blind copy of the
live VM state. A deployment should:

1. copy runtime files to the VM dashboard directory
2. keep the filled environment file VM-local only
3. set the environment file to mode `600`
4. keep the dashboard directory at mode `750` or stricter
5. restart only the relevant user services
6. run the dashboard smoke test

Rollback should restore from a timestamped backup before service restart.

## Status

As of this README, the repository has been aligned with the current VM dashboard
operation at a source level while keeping live secrets and private runtime state
out of git.
