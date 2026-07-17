# KIS Prediction V2 Bounded Validation

## Runtime Contract

- canonical task ID: `kis-prediction-validation-cycle-v2`
- owner: `hermes`
- timezone: `Asia/Seoul`
- schedule: weekdays at `16:10 KST`
- state file: `/home/ubuntu/.hermes/state/kis-prediction-validation-cycle-v2.json`
- maximum distinct trading days: `20`
- maximum concurrent runs: `1`
- retry on failure: `false`
- orders enabled: `false`
- OS cron/systemd timers: unused

The legacy task `kis-prediction-validation-cycle` must remain `PAUSED`. Model v2 activation reads and validates that persisted legacy state while holding the shared cutover lock, and the server does not start the legacy scheduler loop. A legacy manual run is rejected while Model v2 is active or its persisted state is invalid.

## Fixed KIS Command

```text
python3 -m kis_trading_lab prediction-v2-validation-auto-once --approval APPROVE_KIS_MODEL_V2_BOUNDED_VALIDATION_START_V1 --db /var/lib/kis-trading-lab/kis-vps.sqlite3
```

- cwd: `/home/ubuntu/.hermes/jobs/repos/kis-trading-lab`
- canonical VPS mock DB only
- production and alternate DB paths are rejected
- stdout is reduced to the strict 45-key sanitized contract
- child process timeout and output buffer are bounded

## State Mapping

- valid `ready`, `waiting`, and `market_closed_no_op` results keep the task `ACTIVE`
- valid `completed` at 20 distinct decision days moves the task to `COMPLETED`
- blocked output, malformed output, process failure, timeout, or any unsafe effect moves the task to `PAUSED`
- there is no automatic retry

The parser requires the canonical task contract, including `target_definition=direction_label_next_official_krx_session_from_preregistered_chart_features`. Missing, duplicate, mistyped, inconsistent, or unsafe fields fail closed.

## Cutover

1. Prepare the Model v2 state as `DISABLED`.
2. Confirm the legacy task is `PAUSED` with no in-flight run.
3. Sync only the task, test, server, and this document to runtime.
4. Restart the user `codex-control-api.service` at most once and verify health.
5. Activate Model v2 through the persisted state guard.
6. Confirm one active scheduler: legacy `PAUSED`, Model v2 `ACTIVE`.
7. Run one initial action only when the existing KST decision window permits it.

If runtime registration or health validation fails, keep Model v2 `PAUSED` or `DISABLED`. Do not reactivate the legacy task until any Model v2 process has ended and the KIS lock/idempotency state is verified.

## Deployment Result

- cutover time: `2026-07-17 12:51 KST`
- legacy task: `PAUSED`, no next run
- Model v2 task: `ACTIVE`
- next run: `2026-07-17 16:10 KST`
- scheduler/server registration: `true` / `true`
- active scheduler count: `1`
- initial runner call: skipped because the current time was outside `15:30-17:50 Asia/Seoul`
- Model v2 rows at cutover: predictions `0`, outcomes `0`
- runtime restart count: `1`; health after restart: `200`
- runtime-only unrelated server changes were preserved by applying the registration patch to the deployed server rather than replacing it with the repository copy

## Safety Boundary

The Hermes task schedules and interprets the existing KIS CLI only. Prediction logic, calendar checks, schema integrity, leakage controls, locks, idempotency, and VPS mock DB writes remain in KIS Trading Lab. This integration does not enable production DB access, API collection, orders, account/balance calls, condition search, WebSocket, OS cron, secret output, raw response persistence, or Discord reporting.
