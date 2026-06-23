# KIS Prediction Automation Owner Migration

## Status

- migration_date: `2026-06-23`
- canonical_task_id: `kis-prediction-validation-cycle`
- previous_owner: `codex`
- current_owner: `hermes`
- Codex task state: `PAUSED`
- Hermes task state: `ACTIVE`
- active scheduler count: `1`
- duplicate scheduler detected: `false`

## Schedule

- timezone: `Asia/Seoul`
- schedule: `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=16;BYMINUTE=10;BYSECOND=0`
- next_run_at: `2026-06-24T07:10:00.000Z`
- max_distinct_trading_days: `20`
- max_prediction_batches_per_trade_date: `1`
- pause_on_failure: `true`
- retry_on_failure: `false`
- max_concurrent_runs: `1`

## Ownership Boundary

KIS Trading Lab keeps the prediction, persistence, reconciliation, leakage prevention, kill-switch, lock, and idempotency logic.

Hermes only owns:

- schedule state
- one-at-a-time invocation
- KIS CLI execution
- sanitized stdout parsing
- ACTIVE/PAUSED/COMPLETED mapping
- operator-visible status

Codex is paused and is no longer the daily repeating execution owner.

## Runtime

- runtime: `/home/ubuntu/.hermes/codex-control-dashboard`
- service: `codex-control-api.service`
- restart_or_reload_count: `1`
- health_after: `200`
- status endpoint: `/api/kis/prediction-validation/status`
- run endpoint: `/api/kis/prediction-validation/run-once`

## Handoff Validation

- invoked_by: `hermes_cli`
- action_type: `reconcile_only`
- market_data_api_calls: `3`
- predictions_inserted: `0`
- outcomes_resolved: `6`
- fail_closed: `false`
- error_class: `none`
- state_after: `ACTIVE`

## Current Validation Counts

- distinct_trading_days: `2 / 20`
- total_predictions: `6`
- resolved_predictions: `6`
- correct_predictions: `3`
- incorrect_predictions: `1`
- neutral_predictions: `2`
- pending_predictions: `0`
- sample_status: `insufficient_sample`

No performance claim is made from the current sample size.

## Safety Boundary

- prod DB touched: `false`
- order attempted: `false`
- OS cron changed: `false`
- systemd timer changed: `false`
- secret exposed: `false`
- raw response persisted: `false`
- unrelated files staged: `false`

## Rollback Policy

If Hermes scheduling fails before a KIS run starts, keep Hermes `PAUSED` or `DISABLED` and reactivate the existing Codex task only after confirming no active Hermes execution exists. If Hermes has already invoked KIS, wait for that invocation to finish and rely on KIS idempotency before any rollback.
