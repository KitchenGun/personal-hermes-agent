# KIS Report Runtime Activation Evidence

Date: 2026-06-19

## Scope

This evidence records the runtime activation of the KIS Trading Lab report delivery adapter in the Hermes/Codex Control runtime.

Mandatory boundary statement:

`This runtime activation syncs the KIS report adapter into the Hermes runtime and restarts or reloads the active Gateway at most once. It does not send a Discord message and does not call the send-once route.`

## Source State

- repository: `/home/ubuntu/work/personal-hermes-agent`
- branch: `main`
- upstream delta before runtime sync: empty
- relevant source commits:
  - `a9184f5 feat: add KIS report delivery adapter dry run`
  - `9aeafc1 docs: record KIS report runtime preflight`
- source files used:
  - `ops/codex-control-dashboard/kis-report-delivery-adapter.js`
  - `ops/codex-control-dashboard/server.js`
- unrelated dirty files existed before this evidence and were not staged by this activation.

## Runtime Copy

- runtime directory: `/home/ubuntu/.hermes/codex-control-dashboard`
- backup directory: `/home/ubuntu/.hermes/backups/kis-report-runtime-sync-20260619T071851Z`
- runtime adapter copied: true
- runtime route patched: true
- runtime adapter present after sync: true
- runtime route present after sync: true
- env copied: false
- secret copied: false
- db copied: false
- private ops files copied: false

## Syntax Checks

- runtime adapter node check: pass
- runtime server node check: pass
- KIS Trading Lab safety tests before activation: `569 passed`

## Active Service Decision

- route port: `127.0.0.1:17640`
- active route provider: `codex-control-api.service`
- Python `hermes-gateway.service` restarted: false
- reason: the live `/api` route provider for port `17640` was the Codex Control API node service.

## Restart / Reload Evidence

- restart_or_reload_attempted: true
- restarted service: `codex-control-api.service`
- restart_or_reload_count: 1
- service_after_active: active
- main_pid_after: recorded without secret output
- health_after: 200

## Dry-run Route Evidence

- endpoint called: `/api/kis/report/dry-run`
- send-once endpoint called: false
- dry_run_endpoint_available: true
- http_status: 200
- payload_validated: true
- message_built: true
- discord_sent: false
- send_attempt_count: 0
- send_once_called: false
- error_class: none
- target channel: `1512691418605420634`

## Boundary Confirmation

- Discord message sent: false
- direct Discord client retry: false
- raw API response output: false
- raw API response persisted: false
- KIS API call: false
- DB write: false
- cron or timer enabled: false
