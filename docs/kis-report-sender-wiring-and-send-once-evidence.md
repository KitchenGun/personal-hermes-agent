# KIS Report Sender Wiring and Send Once Evidence

Date: 2026-06-22

## Scope

This evidence records the approved Hermes/Gateway KIS report sender wiring attempt and one send-once route call for the KIS Trading Lab Daily Learning Report.

Required boundary statement:

`This evidence records one Hermes/Gateway KIS report send-once attempt to the approved report channel. The deprecated direct Discord client path was not used. No direct Discord retry was attempted. Cron and timers were not changed.`

## Preconditions

- Hermes repo: `/home/ubuntu/work/personal-hermes-agent`
- Hermes branch: `main`
- Hermes `origin/main..HEAD` before this work: empty
- KIS repo: `/home/ubuntu/.hermes/jobs/repos/kis-trading-lab`
- KIS tests: `569 passed`
- active service: `codex-control-api.service`
- gateway health before: `200`
- target channel: `1512691418605420634`
- cron status: `blocked`
- order path status: `disabled`

## Sender Wiring

- discord_relay_module_found: true
- discord_sender_provider_found: true in source patch
- sender_can_be_injected: true in source patch
- target_channel_allowed: true
- source files changed:
  - `ops/codex-control-dashboard/server.js`
  - `ops/codex-control-dashboard/discord-relay.js`
  - `ops/codex-control-dashboard/kis-report-delivery-adapter.js`
  - `ops/codex-control-dashboard/kis-report-delivery-adapter.test.js`

## Runtime Sync / Restart

- runtime_synced: attempted
- backup_dir: `/home/ubuntu/.hermes/backups/kis-report-sender-wiring-20260622T074751Z`
- restart_or_reload_attempted: true
- restart_or_reload_count: 1
- gateway_health_after: `200`
- env_copied: false
- secret_copied: false
- db_copied: false

## Dry-run Result

- dry_run_called: true
- dry_run_http_status: 200
- dry_run_passed: true
- payload_validated: true
- message_built: true
- discord_sent: false
- send_attempt_count: 0
- error_class: none

## Send-once Result

- executed: true
- transport: `hermes_gateway`
- target_channel_id: `1512691418605420634`
- send_once_http_status: 200
- status: fail
- route_status: `adapter_discord_send_failed`
- discord_sent: false
- send_attempt_count: 1
- direct_discord_client_used: false
- direct_discord_retry: false
- restart_or_reload_count: 1
- cron_changed: false
- recommendation_output: false
- error_class: `sender_missing`

## Root Cause

The active runtime accepted and validated the KIS report payload, but the loaded runtime `discord-relay.js` did not expose `sendDiscordRelayMessage` to `server.js` during the single allowed restart window. The send-once call therefore failed closed with `sender_missing` before any Discord message was sent.

No second restart and no second send-once attempt were made because the approval allowed at most one restart/reload and exactly one send-once attempt.

## Forbidden Condition Check

- send_attempt_count_le_1: true
- approved_channel_only: true
- direct Discord client: false
- direct Discord retry: false
- restart_reload_count_le_1: true
- token, webhook, or secret output: false
- raw response output: false
- row values output: false
- numeric score values output: false
- PnL values output: false
- DB write: false
- prod DB touch: false
- cron or timer change: false
- KIS API call: false
- order, account, balance, condition-search, or WebSocket call: false
- recommendation output: false
- forbidden files staged: false

## Validation

- source node checks: pass
- KIS adapter unit test: pass
- KIS repo tests: `569 passed`
- Hermes repo broad test command: `npm` unavailable, Python pytest found no tests

## Runtime Export Addendum

- addendum date: 2026-06-22
- runtime file patched after fail-closed result: `/home/ubuntu/.hermes/codex-control-dashboard/discord-relay.js`
- runtime backup: `/home/ubuntu/.hermes/backups/kis-report-runtime-relay-export-20260622T075410Z`
- exported sender check: `exported_sender=true`
- extra service restart: false
- extra dry-run call: false
- extra send-once call: false
- note: the active process still requires a new approved restart/reload before it can load the patched runtime export.

## Result

Conclusion: `HERMES_KIS_REPORT_SEND_ONCE_FAIL_CLOSED`
