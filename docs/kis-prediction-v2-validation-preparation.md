# KIS Prediction V2 Validation Preparation

## Status

- canonical_task_id: `kis-prediction-v2-validation`
- owner: `hermes`
- task_state: `DISABLED`
- scheduler_registered: `false`
- server_registered: `false`
- live_execution_enabled: `false`
- orders_enabled: `false`
- retry: `false`
- retry_on_failure: `false`
- max_concurrent_runs: `1`

## Bounded CLI Contract

The wrapper records, but does not invoke, only this command:

```text
python3 -m kis_trading_lab prediction-v2-validation-auto-once --approval APPROVE_KIS_MODEL_V2_BOUNDED_VALIDATION_START_V1
```

- cwd: `/home/ubuntu/.hermes/jobs/repos/kis-trading-lab`
- canonical VPS mock DB path: `/var/lib/kis-trading-lab/kis-vps.sqlite3`
- production DB path blocked: `/var/lib/kis-trading-lab/kis-prod.sqlite3`

No scheduler, server hook, runtime sync, state file, environment mutation, database access, or process execution is included in this preparation wrapper.
Caller overrides cannot change the fixed cwd or the disabled, non-executing, non-registered, no-order, no-retry, single-run invariants.

## Accepted Output and State Mapping

Only the module's explicit key allowlist is retained. Action values are limited to:

- `reconcile_only`
- `predict_only`
- `reconcile_then_predict`
- `idempotent_no_op`
- `market_closed_no_op`
- `waiting_for_horizon`
- `paused`
- `completed`

The accepted key allowlist exactly matches the current Stage P formatter:

- status/action: `status`, `action`, `blocked`, `automation_paused`, `completed`, `error_class`, `sample_status`
- execution safety: `db_opened`, `db_written`, `schema_evidence_checked`, `integrity_checked`, `api_called`, `order_attempted`, `scheduler_changed`, `cron_changed`, `raw_values_printed`, `executed`, `fail_closed`, `prod_db_touched`, `secret_exposed`, `raw_response_persisted`, `new_nonessential_features`
- action/contract: `action_type`, `prediction_horizon`, `target_definition`, `timezone`, `prediction_window`, `reconciliation_window`
- counts: `prediction_inserted_count`, `outcome_inserted_count`, `pending_matured_count`, `distinct_decision_day_count`, `max_distinct_trading_days`, `market_data_api_calls`, `predictions_inserted`, `outcomes_resolved`, `distinct_trading_days`, `total_predictions`, `resolved_predictions`, `correct_predictions`, `incorrect_predictions`, `neutral_predictions`, `pending_predictions`, `paper_trade_count`, `live_trade_count`

All 45 Stage P formatter keys must appear exactly once. Unknown keys are discarded, while duplicate allowed keys, missing keys, invalid actions, invalid booleans, and non-integer or negative counts make the contract invalid. The following strings are fixed:

- `prediction_horizon=next_session`
- `target_definition=direction_label_next_session_from_chart_features`
- `timezone=Asia/Seoul`
- `prediction_window=15:30-17:50 Asia/Seoul`
- `reconciliation_window=after_next_official_session_quote_available`

Accepted status/action pairs are `ready` with one of the four prediction/reconciliation actions, `waiting/waiting_for_horizon`, `market_closed_no_op/market_closed_no_op`, `completed/completed`, and fail-closed `blocked/paused`. `sample_status`, `blocked`, `fail_closed`, `automation_paused`, `completed`, and `error_class` must agree with the status.

Count aliases must match, pending must equal total minus resolved, and resolved must equal correct plus incorrect plus neutral. Every positive status also requires `total_predictions = distinct_trading_days * 3` and `db_written = (predictions_inserted + outcomes_resolved > 0)`.

Action semantics are fixed:

- `idempotent_no_op`: no inserts and no DB write
- `predict_only`: exactly three predictions, no outcomes, and a DB write
- `reconcile_then_predict`: exactly three predictions, one or more outcomes, and a DB write
- `reconcile_only`: no predictions, one or more outcomes, and a DB write
- `waiting_for_horizon`: no inserts or write; either pre-window with no execution/DB/integrity or post-DB with all three true
- `market_closed_no_op`: no execution, DB, integrity, or aggregate counts
- `completed`: execution, open DB, integrity, exactly 20 trading days, and either no inserts or a zero/three-prediction write pattern

Positive `ready` and `completed` summaries require `executed`, `db_opened`, and `integrity_checked`. `schema_evidence_checked=true` is accepted only with an open DB and integrity evidence, but it is not required for a nonempty ledger. True execution or DB flags are accepted only when the status, action, and counts are consistent.

API calls, order attempts, scheduler or cron changes, paper/live trades, raw output, prod DB touches, secret exposure, and nonessential features must remain zero or false. Any contract violation maps to `PAUSED`. Safe noncompleted statuses remain `DISABLED`; this module cannot activate or invoke the CLI.

## Approval Handoff

Sol must separately approve an integration task before any registration, scheduling, activation, runtime wiring, or real CLI invocation is considered. That task must revalidate the KIS v2 output contract against the target CLI before enabling execution.
