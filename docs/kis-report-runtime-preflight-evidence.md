# KIS Report Runtime Preflight Evidence

## Purpose

This runtime preflight checks whether the committed KIS report delivery adapter is visible to the currently running Hermes/Gateway runtime.

This runtime preflight does not restart Hermes services, does not send a Discord message, and does not call the send-once route. It only checks whether the committed KIS report adapter is visible to the running Hermes/Gateway runtime.

## Source Repo State

- repo: `/home/ubuntu/work/personal-hermes-agent`
- branch: `main`
- latest adapter commit: `a9184f5 feat: add KIS report delivery adapter dry run`
- `origin/main..HEAD`: empty at preflight time
- source route registration: present
- source adapter module: present

Existing unrelated working tree changes were left untouched.

## KIS Repo State

- repo: `/home/ubuntu/.hermes/jobs/repos/kis-trading-lab`
- existing untracked audit file: unchanged
- `origin/master..HEAD`: empty at preflight time
- tests: `569 passed`

## Runtime State

- user `hermes-gateway` unit: inactive
- system `hermes-gateway` unit: active
- running dashboard server path: `/home/ubuntu/.hermes/codex-control-dashboard/server.js`
- running Discord relay path: `/home/ubuntu/.hermes/codex-control-dashboard/discord-relay.js`
- dashboard health endpoint: available
- dashboard root endpoint: available

## Adapter Visibility

- runtime adapter file present: false
- runtime server route registration: false
- source server route registration: true
- runtime commit matches source commit: false
- restart or runtime sync required: true

## Dry-run Route Check

- endpoint checked: `POST /api/kis/report/dry-run`
- port checked: `127.0.0.1:17640`
- send-once called: false
- Discord sent: false
- KIS API called: false
- HTTP status: `404`
- route available in runtime: false
- payload validated by runtime: false
- send attempt count: `0`
- error class: `route_not_found`

## Boundary Confirmation

- Hermes service restart: not performed
- systemd reload: not performed
- process kill/restart: not performed
- Discord send: not performed
- send-once route call: not performed
- cron/timer change: not performed
- KIS API call: not performed
- DB write: not performed
- order/account/balance/condition/WebSocket call: not performed

## Conclusion

`HERMES_KIS_REPORT_RUNTIME_RESTART_REQUIRED`

The adapter is committed and present in source, but the currently running runtime copy does not include the adapter file or route registration. The next approved action should be a runtime sync and one Hermes/Gateway restart or reload window, followed by another dry-run preflight.
