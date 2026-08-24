'use strict';

const { execFile: defaultExecFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ACTIVATION_APPROVAL = 'APPROVE_KIS_HERMES_AI_MARKET_OPEN_DRY_RUN_V1';
const RESUME_AFTER_IO_FIX_APPROVAL = 'APPROVE_KIS_HERMES_AI_DRY_RUN_RESUME_AFTER_IO_FIX_V1';
const ORDER_ACTIVATION_APPROVAL = 'APPROVE_KIS_HERMES_VPS_AUTONOMOUS_PILOT_V1';
const INTRADAY_PROVIDER_CUTOVER_APPROVAL = 'APPROVE_KIS_INTRADAY_AI_PROVIDER_CUTOVER_V1';
const MODEL_V3_RESEARCH_APPROVAL = 'APPROVE_KIS_MODEL_V3_30D_RESEARCH_API_VPS_V1';
const DAILY_ENTRY_CAP_5_APPROVAL = 'APPROVE_KIS_VPS_MOCK_DAILY_ENTRY_CAP_5_V1';
const DAILY_ENTRY_CAP_5_APPROVAL_HASH = crypto.createHash('sha256')
  .update(DAILY_ENTRY_CAP_5_APPROVAL).digest('hex');
const INTRADAY_PROVIDER_ID = 'intraday_v1';
const LEGACY_INTRADAY_FEATURE_VERSION = 'intraday-quote-10m-v2-dynamic-universe';
const LEGACY_INTRADAY_POLICY_VERSION = 'intraday-fast-track-v2-dynamic-universe';
const LEGACY_INTRADAY_PROVIDER_ATTESTATION = Object.freeze({
  decision_provider: INTRADAY_PROVIDER_ID,
  intraday_feature_version: LEGACY_INTRADAY_FEATURE_VERSION,
  intraday_policy_version: LEGACY_INTRADAY_POLICY_VERSION,
  intraday_feature_hash: crypto.createHash('sha256').update(LEGACY_INTRADAY_FEATURE_VERSION).digest('hex'),
  intraday_policy_hash: crypto.createHash('sha256').update(LEGACY_INTRADAY_POLICY_VERSION).digest('hex'),
});
const INTRADAY_FEATURE_VERSION = 'intraday-quote-10m-v2-dynamic-universe';
const INTRADAY_POLICY_VERSION = 'intraday-fast-track-v3-intraday-discovery';
const INTRADAY_PROVIDER_ATTESTATION = Object.freeze({
  decision_provider: INTRADAY_PROVIDER_ID,
  intraday_feature_version: INTRADAY_FEATURE_VERSION,
  intraday_policy_version: INTRADAY_POLICY_VERSION,
  intraday_feature_hash: crypto.createHash('sha256').update(INTRADAY_FEATURE_VERSION).digest('hex'),
  intraday_policy_hash: crypto.createHash('sha256').update(INTRADAY_POLICY_VERSION).digest('hex'),
  daily_entry_cap: null,
});
const KIS_REPO = '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab';
const KIS_VENV_PYTHON = '/home/ubuntu/.hermes/venvs/kis-trading-lab/bin/python';
const VPS_DB_PATH = '/var/lib/kis-trading-lab/kis-vps.sqlite3';
const STRATEGY_MANIFEST = 'config/adaptive_ai_dry_run_strategy_v1.json';
const DEFAULT_CALENDAR_SNAPSHOT_PATH = path.join(KIS_REPO, 'data/market_calendar/krx_market_calendar_snapshot_20260623_v2.json');
const DEFAULT_STATE_PATH = '/home/ubuntu/.hermes/state/kis-ai-market-open-dry-run-v1.json';
const ORDER_ATTESTATION_DIR = '/home/ubuntu/.hermes/state/kis-vps-model-v3-attestations';
const LEGACY_V1_STATE_PATH = '/home/ubuntu/.hermes/state/kis-prediction-validation-cycle.json';
const LEGACY_V2_STATE_PATH = '/home/ubuntu/.hermes/state/kis-prediction-validation-cycle-v2.json';
const LEGACY_V1_RUN_LOCK_PATH = '/tmp/kis-trading-lab-prediction-validation-auto.lock';
const LEGACY_V2_RUN_LOCK_PATH = '/tmp/kis-prediction-validation-cycle-v2-hermes.lock';
const DEFAULT_RUN_LOCK_PATH = '/tmp/kis-ai-market-open-dry-run-hermes.lock';
const DEFAULT_SCHEDULER_OWNER_LOCK_PATH = '/tmp/kis-ai-market-open-scheduler-owner.lock';
const RESUME_BLOCKING_LOCK_PATHS = Object.freeze([
  '/tmp/kis-trading-lab-ai-market-open-dry-run.lock',
  '/tmp/kis-trading-lab-manual-quote-run.lock',
  '/tmp/kis-trading-lab-prediction-validation-auto.lock',
  '/tmp/kis-prediction-validation-cycle-v2-hermes.lock',
  '/tmp/kis-trading-lab-model-v2-schema-apply.lock',
  '/tmp/kis-trading-lab-vps-order.lock',
  '/tmp/kis-trading-lab-vps-preflight-only-0910.lock',
]);
const APPROVED_SOURCE_TASK_PATH = '/home/ubuntu/work/personal-hermes-agent/ops/codex-control-dashboard/kis-ai-market-open-dry-run-task.js';
const REPORT_TARGET_CHANNEL_ID = '1512691418605420634';
const POLL_INTERVAL_MS = 60_000;
const EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER_BYTES = 64 * 1024;
const LLM_RESPONSE_TIMEOUT_MS = 120_000;
const LLM_MODEL_ID = 'gpt-5.6-terra';
const REQUIRED_RUNTIME_CONTRACT = Object.freeze({
  contract_version: 'runtime_contract_v1',
  universe_min: 30,
  universe_max: 50,
  slot_review_limit: 20,
  quote_api_calls_per_slot: 20,
  pre_submit_quote_calls: 1,
  max_open_positions: 5,
  max_order_posts_per_invocation: 1,
  daily_entry_cap: null,
  max_symbol_equity_pct: 50,
  planned_position_loss_pct: 1,
  max_aggregate_open_risk_pct: 3,
});
const MAX_AI_CANDIDATES = REQUIRED_RUNTIME_CONTRACT.slot_review_limit;
const MIN_VPS_CUTOVER_DAYS = 20;
const MIN_RECONCILED_ROUND_TRIPS = 30;
const AI_DECISION_ACTIONS = new Set(['ENTER', 'EXIT', 'HOLD', 'HOLD_OVERNIGHT', 'REJECT']);
const AI_CONFIDENCE_BUCKETS = new Set(['low', 'medium', 'high']);
const AI_REASON_CODES = new Set([
  'DATA_QUALITY', 'MOMENTUM_CONFIRMATION', 'RELATIVE_STRENGTH', 'EVENT_RISK',
  'RISK_REDUCTION', 'EXIT_SIGNAL', 'OVERNIGHT_THESIS', 'NO_EDGE', 'CONFLICTING_SIGNALS',
]);
const TIMEZONE = 'Asia/Seoul';
const CANONICAL_TASK_ID = 'kis-ai-market-open-dry-run-v1';
const TASK_OWNER = 'hermes';
const KRX_SYMBOL_RE = /^\d{6}$/;
const LEGACY_WATCHLIST_SYMBOLS = Object.freeze(['005930', '000660', '005380']);
const ERROR_POLICY = Object.freeze(Object.fromEntries([
  ['dns_failed', { transient: true, autoResume: true, resumable: true, orderRecovery: true, safetyAwait: true }],
  ['connection_failed', { transient: true, autoResume: true, resumable: true, orderRecovery: true, safetyAwait: true }],
  ['connection_reset', { transient: true, autoResume: true, resumable: true, orderRecovery: true, safetyAwait: true }],
  ['timeout', { transient: true, autoResume: true, resumable: true, orderRecovery: true, safetyAwait: true }],
  ['http_transport_failed', { transient: true, autoResume: true, resumable: true, orderRecovery: true, safetyAwait: true }],
  ['response_read_failed', { transient: true, autoResume: true, resumable: true, orderRecovery: true, safetyAwait: true }],
  ['database_busy', { transient: true, autoResume: true, resumable: true, orderRecovery: true, safetyAwait: true }],
  ['tls_failed', {}],
  ['quote_api_failed', {}],
  ['local_file_io_failed', { autoRepair: true, resumable: true }],
  ['unknown_runtime_io_failed', {}],
  ['llm_response_timeout', { slotDegradeOnly: true, orderRecovery: true }],
  ['llm_candidate_limit_exceeded', { orderRecovery: true }],
  ['scheduler_state_fault', { autoRepair: true }],
  ['runtime_io_failed', { autoRepair: true, resumable: true }],
  ['process_error', { autoRepair: true, resumable: true, safetyAwait: true }],
  ['database_file_io_failed', { autoRepair: true, resumable: true }],
  ['invalid_output_fields', { autoRepair: true, resumable: true }],
  ['invalid_safety_output', { autoRepair: true, resumable: true }],
  ['invalid_intraday_output_contract', { autoRepair: true, resumable: true }],
  ['invalid_report_message', { autoRepair: true, resumable: true }],
  ['report_sender_missing', { autoRepair: true }],
  ['report_delivery_failed', { autoRepair: true }],
  ['decision_context_process_error', { autoRepair: true }],
  ['decision_context_failed', { autoRepair: true, orderRecovery: true }],
  ['invalid_decision_context', { autoRepair: true }],
  ['intraday_position_signal_missing', { autoRepair: true, orderRecovery: true }],
  ['intraday_universe_unavailable', { autoRepair: true, resumable: true }],
  ['intraday_shortlist_unavailable', { autoRepair: true }],
  ['account_risk_evidence_missing', { autoRepair: true, resumable: true, autoResume: true }],
  ['model_v3_refresh_failed', { autoRepair: true }],
  ['model_v3_shadow_failed', { autoRepair: true }],
  ['model_v3_shadow_batch_failed', { autoRepair: true, orderRecovery: true, postCloseRecovery: true }],
  ['model_v3_backfill_failed', { autoRepair: true, orderRecovery: true, postCloseRecovery: true }],
  ['model_v3_shadow_execution_failed', { autoRepair: true, orderRecovery: true, postCloseRecovery: true }],
  ['model_v3_artifact_load_failed', { autoRepair: true, orderRecovery: true, postCloseRecovery: true }],
  ['model_v3_artifact_verify_failed', { autoRepair: true, orderRecovery: true, postCloseRecovery: true }],
  ['scheduled_shadow_refresh_slot_invalid', { autoRepair: true, orderRecovery: true, postCloseRecovery: true }],
  ['post_close_shadow_process_error', { autoRepair: true }],
  ['safety_monitor_failed', { autoResume: true, resumable: true, safetyAwait: true }],
  ['open_order_status_unavailable', { autoResume: true, resumable: true, safetyAwait: true }],
  ['order_submission_unknown', { persistent: true, orderRecovery: true }],
  ['reconciliation_status_active', { persistent: true, resumable: true }],
  ['scheduler_lock_active', { persistent: true }],
  ['scheduler_owner_lock_active', { persistent: true }],
  ['model_v3_post_close_promotion_forbidden', { persistent: true }],
  ['hermes_scheduler_attestation_unavailable', { persistent: true, orderRecovery: true }],
  ['order_action_not_allowed_for_schedule_slot', { persistent: true }],
  ['runtime_unhandled_error', { resumable: true }],
  ['unsafe_output', { resumable: true }],
  ['account_risk_status_active', { persistent: true, resumable: true }],
  ['intraday_universe_invalid', { resumable: true }],
  ['invalid_failure_evidence', { resumable: true }],
  ['balance_mismatch', { orderRecovery: true }],
  ['order_not_fully_filled', { orderRecovery: true }],
  ['invalid_order_output_contract', { orderRecovery: true }],
  ['unsafe_order_count', { orderRecovery: true }],
  ['intraday_prediction_contract_mismatch', { orderRecovery: true }],
  ['symbol_not_allowed', { orderRecovery: true }],
  ['unmanaged_position_present', { orderRecovery: true }],
  ['preflight_or_reconciliation_invalid', { orderRecovery: true }],
  ['risk_guard_blocked', { orderRecovery: true }],
  ['model_v3_artifact_attestation_mismatch', { orderRecovery: true }],

].map(([errorClass, policy]) => [errorClass, Object.freeze({ visible: true, autoRepair: false, autoResume: false, transient: false, persistent: false, ...policy })])));
const TRANSIENT_TRANSPORT_ERRORS = new Set(Object.entries(ERROR_POLICY)
  .filter(([, policy]) => policy.transient).map(([errorClass]) => errorClass));
const TRANSIENT_SAFETY_MONITOR_ERRORS = new Set(Object.entries(ERROR_POLICY)
  .filter(([, policy]) => policy.safetyAwait).map(([errorClass]) => errorClass));
const OPEN_ORDER_STATUS_FAILURE_LIMIT = 5;
const AUTO_RESUME_AFTER_CLEAR_SAFETY = new Set(Object.entries(ERROR_POLICY)
  .filter(([, policy]) => policy.autoResume).map(([errorClass]) => errorClass));
const errorsWith = (flag) => new Set(Object.entries(ERROR_POLICY)
  .filter(([, policy]) => policy[flag] === true).map(([errorClass]) => errorClass));
const RESUMABLE_PAUSE_REASONS = errorsWith('resumable');
const PREFLIGHT_RESUMABLE_PAUSE_REASONS = new Set(['database_file_io_failed', 'account_risk_evidence_missing']
  .filter((errorClass) => ERROR_POLICY[errorClass]?.resumable));
const ORDER_TASK_RECOVERY_PAUSE_REASONS = errorsWith('orderRecovery');
const POST_CLOSE_REFRESH_RECOVERY_PAUSE_REASONS = errorsWith('postCloseRecovery');
const DISCORD_ERROR_CLASSES = new Set(Object.keys(ERROR_POLICY));

const AUTO_REPAIRABLE_ERROR_CLASSES = new Set(Object.entries(ERROR_POLICY)
  .filter(([, policy]) => policy.autoRepair).map(([errorClass]) => errorClass));
const FAILURE_PHASES = new Set([
  'none', 'strategy_manifest_read', 'calendar_read', 'kill_switch_read', 'lock_acquire',
  'database_open', 'database_begin', 'database_commit', 'client_initialize', 'auth_token_request',
  'account_balance_request', 'open_orders_read_request', 'quote_request',
  'quote_response_read', 'quote_parse', 'quote_persist', 'hermes_state_write',
]);
const FAILURE_EXCEPTION_TYPES = new Set([
  'none', 'HTTPError', 'URLError', 'SSLCertVerificationError', 'SSLError', 'gaierror',
  'timeout', 'TimeoutError', 'ConnectionResetError', 'ConnectionRefusedError', 'ConnectionAbortedError',
  'BrokenPipeError', 'IncompleteRead', 'RemoteDisconnected', 'BadStatusLine',
  'JSONDecodeError', 'UnicodeError', 'OperationalError', 'DatabaseError', 'Error',
  'OSError', 'RuntimeError', 'ContractError',
]);
const TASKS = Object.freeze([
  { id: 'kis-ai-market-open-supervisor-v1', kind: 'dry_run', schedule: 'weekdays 09:00 KST', minutes: [540] },
  { id: 'kis-ai-intraday-shadow-validation-v1', kind: 'dry_run', schedule: 'weekdays 09:10-14:40 KST every 10m', minutes: Array.from({ length: 34 }, (_, i) => 550 + (i * 10)) },
  { id: 'kis-ai-post-close-learning-v1', kind: 'dry_run', schedule: 'weekdays 16:20 KST', minutes: [980] },
  { id: 'kis-ai-daily-learning-report-v1', kind: 'dry_run', schedule: 'weekdays 16:30 KST', minutes: [990] },
  {
    id: 'kis-vps-model-v3-autonomous-pilot-v1',
    kind: 'order',
    schedule: 'weekdays 09:10-14:40 KST every 10m; deterministic risk-off 14:41-14:42 KST; shadow refresh 16:20 KST',
    minutes: [...Array.from({ length: 34 }, (_, i) => 550 + (i * 10)), 881, 882, 980],
  },
]);
const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));
const TASK_FAILURE_PHASES = new Map([
  [TASKS[0].id, new Set(['supervisor_run'])],
  [TASKS[1].id, new Set(['intraday_shortlist_resolve', 'intraday_run'])],
  [TASKS[2].id, new Set(['post_close_learning'])],
  [TASKS[3].id, new Set(['daily_report'])],
]);
const TASK_ALERT_LABELS = new Map([
  ['kis-ai-market-open-supervisor-v1', '장 시작 감독'],
  ['kis-ai-intraday-shadow-validation-v1', '장중 AI 검증'],
  ['kis-ai-post-close-learning-v1', '장 마감 후 학습'],
  ['kis-ai-daily-learning-report-v1', '일일 결과 보고'],
  ['kis-vps-model-v3-autonomous-pilot-v1', 'AI 자동매매'],
]);
const DRY_RUN_TASKS = Object.freeze(TASKS.filter((task) => task.kind === 'dry_run'));
const ORDER_TASK = TASKS.find((task) => task.kind === 'order');
const REFRESH_ONLY_ORDER_TASK = Object.freeze({ ...ORDER_TASK, minutes: [980] });
const POST_CLOSE_TASK = TASKS.find((task) => task.id === 'kis-ai-post-close-learning-v1');
const ACTIVE_STATUSES = new Set(['success', 'no_op', 'waiting', 'report_ready']);
const ALL_STATUSES = new Set([...ACTIVE_STATUSES, 'blocked']);
const OUTPUT_KEYS = new Set([
  'task_id', 'status', 'action_type', 'official_trade_date', 'official_session_state',
  'official_calendar_verified', 'official_calendar_source_hash',
  'api_calls', 'quote_api_calls',
  'decisions', 'simulated_orders', 'simulated_positions', 'experience_rows', 'incidents',
  'outbox_rows', 'challenger_trained', 'champion_changed', 'order_api_calls',
  'vps_live_orders', 'prod_orders', 'raw_response_persisted', 'secret_exposure', 'retry',
  'catch_up', 'backfill', 'fail_closed', 'error_class', 'report_message',
  'failure_phase', 'failure_symbol', 'failure_exception_type', 'failure_errno',
  'failure_attempt_number', 'transport_degraded',
]);
const INTRADAY_OUTPUT_KEYS = new Set([
  ...OUTPUT_KEYS,
  'intraday_decisions', 'intraday_mode', 'intraday_model_version',
  'intraday_feature_version', 'intraday_policy_version',
  'intraday_feature_hash', 'intraday_policy_hash',
]);
const POST_CLOSE_OUTPUT_KEYS = new Set([
  ...OUTPUT_KEYS,
  'intraday_outcomes_inserted', 'intraday_labeled_rows', 'intraday_official_dates',
]);
const POST_CLOSE_COUNT_KEYS = [
  'intraday_outcomes_inserted', 'intraday_labeled_rows', 'intraday_official_dates',
];
const COUNT_KEYS = new Set([
  'api_calls', 'quote_api_calls', 'decisions', 'simulated_orders', 'simulated_positions',
  'experience_rows', 'incidents', 'outbox_rows', 'order_api_calls', 'vps_live_orders', 'prod_orders',
]);
const BOOLEAN_KEYS = new Set([
  'challenger_trained', 'champion_changed', 'raw_response_persisted', 'secret_exposure',
  'retry', 'catch_up', 'backfill', 'fail_closed', 'official_calendar_verified',
  'transport_degraded',
]);
const SECRET_LIKE_RE = /(Bearer\s+[A-Za-z0-9._-]+|app[_-]?secret|app[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client_secret)/i;
const OFFICIAL_SOURCE_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const VPS_SYMBOL_LABEL = '(?:삼성전자\\(005930\\)|SK하이닉스\\(000660\\)|현대차\\(005380\\)|\\d{6})';
const VPS_FILL_ITEM_RE = new RegExp(`^(?:매수|매도) ${VPS_SYMBOL_LABEL} [1-9]\\d*주$`);
const VPS_HOLDING_ITEM_RE = new RegExp(`^${VPS_SYMBOL_LABEL} [1-9]\\d*주$`);
const VPS_REALIZED_PNL_RE = /^(?:0원 \(매도 체결 없음\)|계산 불가 \(체결 근거 부족\)|(?:추정 )?[+-]\d{1,3}(?:,\d{3})*원 \((?:현금 증감 기준|체결가 기준, 비용 제외)\))$/;
const ORDER_OUTPUT_KEYS = new Set([
  'task_id', 'status', 'action_type', 'official_trade_date', 'order_api_calls',
  'vps_live_orders', 'prod_orders', 'reconciliations', 'open_positions', 'daily_entry_count',
  'artifact_reused', 'artifact_promoted', 'previous_artifact_hash', 'artifact_hash',
  'shadow_predictions_inserted', 'shadow_duplicates_skipped',
  'model_v2_changed', 'scheduler_changed', 'retry', 'catch_up', 'backfill', 'fail_closed',
  'error_class', 'raw_response_persisted', 'secret_exposure',
  'intraday_mode', 'intraday_model_version',
  'decision_provider', 'intraday_feature_version', 'intraday_policy_version',
  'intraday_feature_hash', 'intraday_policy_hash',
  'order_symbol', 'order_side', 'requested_quantity', 'filled_quantity',
  'unfilled_quantity', 'lifecycle_status', 'decision_reason_codes',
  'notification_idempotency_key',
]);
const ORDER_EXECUTION_ACTIONS = new Set([
  'entry_reconciled', 'exit_reconciled', 'ai_exit_reconciled', 'intraday_ai_exit_reconciled',
  'risk_stop_exit_reconciled', 'take_profit_exit_reconciled', 'horizon_exit_reconciled',
]);
const ORDER_ACTIONS = new Set([
  'activation_check', 'position_held', 'ai_position_held',
  'no_candidate_no_op', 'entry_window_closed_no_op', 'market_closed_no_op',
  'waiting_regular_session', 'waiting_post_close', 'shadow_refreshed', 'idempotent_no_op', 'paused',
  'llm_entry_not_authorized_no_op', 'reconciliation_recovered',
  ...ORDER_EXECUTION_ACTIONS,
]);

function hasIntradayProviderAttestation(value, expected = INTRADAY_PROVIDER_ATTESTATION) {
  return Boolean(value)
    && value.decision_provider === expected.decision_provider
    && value.intraday_feature_version === expected.intraday_feature_version
    && value.intraday_policy_version === expected.intraday_policy_version
    && value.intraday_feature_hash === expected.intraday_feature_hash
    && value.intraday_policy_hash === expected.intraday_policy_hash;
}

function seoulParts(date) {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(values.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
}

function isDue(task, date) {
  const parts = seoulParts(date);
  return !['Sat', 'Sun'].includes(parts.weekday)
    && task.minutes.includes((Number(parts.hour) * 60) + Number(parts.minute));
}

function dueKey(task, date) {
  const parts = seoulParts(date);
  return `${task.id}:${parts.year}-${parts.month}-${parts.day}:${parts.hour}:${parts.minute}`;
}

function sameMinute(left, right) {
  return typeof left === 'string' && left.slice(0, 16) === right.toISOString().slice(0, 16);
}

function nextRunAt(task, from = new Date()) {
  const probe = new Date(from.getTime());
  probe.setUTCSeconds(0, 0);
  probe.setUTCMinutes(probe.getUTCMinutes() + 1);
  for (let index = 0; index < (9 * 24 * 60); index += 1) {
    if (isDue(task, probe)) return probe.toISOString();
    probe.setUTCMinutes(probe.getUTCMinutes() + 1);
  }
  throw new Error('next_schedule_not_found');
}

function postCloseRefreshAtToday(from = new Date()) {
  const start = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (Number.isNaN(start.getTime())) throw new Error('post_close_arm_time_invalid');
  const today = seoulParts(start);
  const probe = new Date(start.getTime());
  probe.setUTCSeconds(0, 0);
  probe.setUTCMinutes(probe.getUTCMinutes() + 1);
  for (let index = 0; index < (24 * 60); index += 1) {
    const parts = seoulParts(probe);
    if (parts.year !== today.year || parts.month !== today.month || parts.day !== today.day) break;
    if (Number(parts.hour) === 16 && Number(parts.minute) === 20) return probe.toISOString();
    probe.setUTCMinutes(probe.getUTCMinutes() + 1);
  }
  throw new Error('post_close_arm_window_unavailable');
}

function safeText(value, max = 160) {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7e]/g, '').slice(0, max);
}

function sanitizeErrorClass(value) {
  const text = safeText(value, 80);
  if (SECRET_LIKE_RE.test(text) || /(?:sk-[A-Za-z0-9_-]{12,}|(?:openai|kis)[_-]?(?:api_?)?key)/i.test(text)
    || !/^[a-z][a-z0-9_]{0,79}$/.test(text)) return 'sanitized_runtime_error';
  return text;
}

function normalizeRuntimeContract(value) {
  const keys = Object.keys(REQUIRED_RUNTIME_CONTRACT);
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || value.contract_version !== REQUIRED_RUNTIME_CONTRACT.contract_version
    || keys.filter((key) => key !== 'contract_version').some((key) => value[key] !== REQUIRED_RUNTIME_CONTRACT[key])) {
    throw new Error('runtime_contract_invalid');
  }
  return Object.freeze({ ...value });
}

const PYTHON_FLOAT_FIELDS = new Set([
  'stop_loss_pct', 'take_profit_r_multiple', 'take_profit_pct',
  'max_symbol_equity_pct', 'planned_position_loss_pct', 'max_aggregate_open_risk_pct',
]);

function canonicalJson(value, field = '') {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], key)}`).join(',')}}`;
  }
  if (typeof value === 'number' && Number.isInteger(value) && PYTHON_FLOAT_FIELDS.has(field)) return `${value}.0`;
  return JSON.stringify(value);
}

function loadRuntimeContract(
  strategyManifestPath = process.env.KIS_RUNTIME_CONTRACT_MANIFEST_PATH
    || path.join(KIS_REPO, STRATEGY_MANIFEST),
) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(strategyManifestPath, 'utf8')); }
  catch { throw new Error('runtime_contract_unavailable'); }
  const suppliedHash = manifest.manifest_hash;
  const canonicalManifest = { ...manifest };
  delete canonicalManifest.manifest_hash;
  const computedHash = crypto.createHash('sha256').update(canonicalJson(canonicalManifest)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(suppliedHash || '') || suppliedHash !== computedHash) {
    throw new Error('runtime_contract_manifest_hash_mismatch');
  }
  return normalizeRuntimeContract(manifest.runtime_contract);
}

function processFailureEvidence(error, stderr) {
  const raw = String(stderr || '');
  const matches = [...raw.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception))(?=:|\s|$)/gm)];
  const candidate = safeText(matches.at(-1)?.[1] || error?.name || 'Error', 64);
  const exceptionType = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(candidate) ? candidate : 'Error';
  const signal = String(error?.signal || '');
  return Object.freeze({
    failure_phase: 'child_process',
    failure_exception_type: exceptionType,
    failure_exit_code: Number.isSafeInteger(error?.code) ? error.code : null,
    failure_signal: /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : null,
    failure_fingerprint: crypto.createHash('sha256').update(
      raw || [error?.name, error?.code, error?.signal].join(':'),
    ).digest('hex'),
  });
}

function validateReportList(value, emptyValues, itemPattern, maxItems) {
  if (emptyValues.has(value)) return;
  const items = value.split('; ');
  if (items.length === 0 || items.length > maxItems || items.some((item) => !itemPattern.test(item))) {
    throw new Error('invalid_report_message');
  }
}

function validateReportMessage(value, officialTradeDate, decisions, runtimeContract = REQUIRED_RUNTIME_CONTRACT) {
  const reportMessage = String(value || '');
  const lines = reportMessage.split('\n');
  const decisionMatch = /^AI 검증: 판단 (\d+)건 \/ 모델 변경 0회$/.exec(lines[5] || '');
  if (reportMessage.length > 600 || lines.length !== 8
    || lines[0] !== '[KIS VPS 모의투자 일일 결과]'
    || lines[1] !== `기준일: ${officialTradeDate}`
    || !lines[2].startsWith('오늘 체결: ')
    || !lines[3].startsWith('현재 보유: ')
    || !lines[4].startsWith('오늘 실현손익: ')
    || decisionMatch === null
    || Number(decisionMatch[1]) !== decisions
    || !/^운영 상태: (?:정상|확인 필요 [1-9]\d*건)$/.test(lines[6])
    || lines[7] !== '실전계좌: 주문 없음') throw new Error('invalid_report_message');
  validateReportList(lines[2].slice('오늘 체결: '.length), new Set(['없음', '확인 불가 (주문 원장 없음)']), VPS_FILL_ITEM_RE, 10);
  validateReportList(lines[3].slice('현재 보유: '.length), new Set(['없음', '확인 불가']), VPS_HOLDING_ITEM_RE, runtimeContract.max_open_positions);
  if (!VPS_REALIZED_PNL_RE.test(lines[4].slice('오늘 실현손익: '.length))) throw new Error('invalid_report_message');
  return reportMessage;
}

function validateTaskMeaning(value) {
  if (value.status === 'blocked') return;
  if (value.action_type === 'market_closed_no_op') {
    if (value.status !== 'no_op') throw new Error('invalid_task_result_contract');
    return;
  }
  if (value.action_type === 'waiting_window') {
    if (value.status !== 'waiting') throw new Error('invalid_task_result_contract');
    return;
  }
  if (value.action_type === 'idempotent_no_op') {
    if (value.status !== 'no_op') throw new Error('invalid_task_result_contract');
    return;
  }
  if (value.action_type === 'transport_degraded_no_op') {
    if (![TASKS[0].id, TASKS[1].id].includes(value.task_id) || value.status !== 'no_op'
      || value.transport_degraded !== true || value.fail_closed !== false
      || !TRANSIENT_TRANSPORT_ERRORS.has(value.error_class)) throw new Error('invalid_task_result_contract');
    return;
  }
  if (value.action_type === 'no_candidates_no_op') {
    if (value.task_id !== TASKS[1].id || value.status !== 'no_op'
      || value.api_calls !== 0 || value.order_api_calls !== 0
      || value.fail_closed !== false || value.error_class !== 'none') {
      throw new Error('invalid_task_result_contract');
    }
    return;
  }
  const expected = {
    'kis-ai-market-open-supervisor-v1': { statuses: new Set(['success']), actions: new Set(['activation_preflight', 'market_open_supervisor']) },
    'kis-ai-intraday-shadow-validation-v1': { statuses: new Set(['success']), actions: new Set(['intraday_shadow']) },
    'kis-ai-post-close-learning-v1': { statuses: new Set(['success']), actions: new Set(['post_close_learning']) },
    'kis-ai-daily-learning-report-v1': { statuses: new Set(['report_ready']), actions: new Set(['daily_learning_report']) },
  }[value.task_id];
  if (!expected.statuses.has(value.status) || !expected.actions.has(value.action_type)) {
    throw new Error('invalid_task_result_contract');
  }
}

function loadOfficialCalendarProof(tradeDate, calendarSnapshotPath = DEFAULT_CALENDAR_SNAPSHOT_PATH) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(calendarSnapshotPath, 'utf8')); }
  catch { throw new Error('official_calendar_proof_unavailable'); }
  const metadata = payload?.metadata;
  if (!metadata || metadata.source_type !== 'official' || metadata.environment !== 'live_candidate'
    || metadata.is_official !== true || metadata.valid_for_live_manual_run !== true
    || metadata.timezone !== TIMEZONE || !OFFICIAL_SOURCE_HASH_RE.test(String(metadata.source_hash || ''))
    || !Array.isArray(payload.sessions)) throw new Error('official_calendar_proof_invalid');
  const matches = payload.sessions.filter((item) => item?.trade_date === tradeDate);
  if (matches.length !== 1 || typeof matches[0].is_trading_day !== 'boolean'
    || matches[0].source_hash !== metadata.source_hash) throw new Error('official_calendar_proof_invalid');
  return Object.freeze({ isTradingDay: matches[0].is_trading_day, sourceHash: metadata.source_hash });
}

function parseKisAiMarketOpenOutput(stdout, expectedTaskId, calendarProofResolver = loadOfficialCalendarProof, runtimeContract = REQUIRED_RUNTIME_CONTRACT) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) throw new Error('unsafe_or_oversized_output');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_sanitized_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid_sanitized_json');
  const hasIntradayResult = value.task_id === TASKS[1].id
    && value.status === 'success' && value.action_type === 'intraday_shadow';
  const hasPostCloseResult = value.task_id === POST_CLOSE_TASK.id
    && value.status === 'success' && value.action_type === 'post_close_learning';
  const expectedOutputKeys = hasIntradayResult
    ? INTRADAY_OUTPUT_KEYS
    : hasPostCloseResult
    ? POST_CLOSE_OUTPUT_KEYS
    : OUTPUT_KEYS;
  if (Object.keys(value).length !== expectedOutputKeys.size
    || [...expectedOutputKeys].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('invalid_output_fields');
  }
  if (value.task_id !== expectedTaskId || !TASK_BY_ID.has(value.task_id)) throw new Error('invalid_output_task_id');
  if (!ALL_STATUSES.has(value.status) || typeof value.action_type !== 'string' || typeof value.error_class !== 'string') throw new Error('invalid_output_status');
  if (!(value.official_trade_date === null || /^\d{4}-\d{2}-\d{2}$/.test(value.official_trade_date))) throw new Error('invalid_output_trade_date');
  if (!['regular_session', 'closed', 'unknown'].includes(value.official_session_state)) throw new Error('invalid_official_session_state');
  if ([...COUNT_KEYS].some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw new Error('invalid_output_count');
  if (hasPostCloseResult
    && POST_CLOSE_COUNT_KEYS.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
    throw new Error('invalid_output_count');
  }
  if ([...BOOLEAN_KEYS].some((key) => typeof value[key] !== 'boolean')) throw new Error('invalid_output_boolean');
  const taskFailurePhases = TASK_FAILURE_PHASES.get(expectedTaskId);
  const quoteApiCallLimit = runtimeContract.quote_api_calls_per_slot;
  if (!(FAILURE_PHASES.has(value.failure_phase) || taskFailurePhases?.has(value.failure_phase))
    || !(value.failure_symbol === null || KRX_SYMBOL_RE.test(String(value.failure_symbol)))
    || !FAILURE_EXCEPTION_TYPES.has(value.failure_exception_type)
    || !(value.failure_errno === null || Number.isSafeInteger(value.failure_errno))
    || !Number.isSafeInteger(value.failure_attempt_number) || value.failure_attempt_number < 0
    || value.failure_attempt_number > quoteApiCallLimit) throw new Error('invalid_failure_evidence');
  if (value.order_api_calls !== 0 || value.vps_live_orders !== 0 || value.prod_orders !== 0
    || value.champion_changed !== false || value.raw_response_persisted !== false
    || value.secret_exposure !== false || value.retry !== false || value.catch_up !== false
    || value.backfill !== false || value.quote_api_calls > quoteApiCallLimit) throw new Error('unsafe_output');
  const blocked = value.status === 'blocked';
  const degraded = value.action_type === 'transport_degraded_no_op';
  const degradedFailureEvidenceValid = !degraded || (
    value.failure_phase !== 'none'
    && value.failure_exception_type !== 'none'
    && value.failure_attempt_number >= 1
    && (
      (value.task_id === TASKS[0].id
        && value.failure_symbol === null
        && ['auth_token_request', 'account_balance_request', 'open_orders_read_request'].includes(value.failure_phase))
      || (value.task_id === TASKS[1].id && value.failure_symbol !== null)
      || (value.error_class === 'database_busy'
        && value.failure_phase === 'database_begin'
        && value.failure_symbol === null)
    )
  );
  if (value.fail_closed !== blocked
    || (blocked ? value.error_class === 'none' : (!degraded && value.error_class !== 'none'))
    || !degradedFailureEvidenceValid
    || (!degraded && value.transport_degraded !== false)) throw new Error('invalid_fail_closed_contract');
  const marketClosed = value.action_type === 'market_closed_no_op';
  if (marketClosed !== (value.official_session_state === 'closed')
    || (!blocked && !marketClosed && value.official_session_state !== 'regular_session')
    || (value.official_session_state !== 'unknown' && value.official_trade_date === null)
    || (!blocked && (value.official_calendar_verified !== true
      || !OFFICIAL_SOURCE_HASH_RE.test(String(value.official_calendar_source_hash || ''))))
    || (blocked && (value.official_calendar_verified !== false || value.official_calendar_source_hash !== null))) {
    throw new Error('official_calendar_contract_invalid');
  }
  if (!blocked) {
    let proof;
    try { proof = calendarProofResolver(value.official_trade_date); }
    catch { throw new Error('official_calendar_proof_invalid'); }
    if (!proof || proof.sourceHash !== value.official_calendar_source_hash
      || proof.isTradingDay !== !marketClosed) throw new Error('official_calendar_proof_invalid');
  }
  validateTaskMeaning(value);
  if (hasIntradayResult) {
    const expectedFeatureHash = INTRADAY_PROVIDER_ATTESTATION.intraday_feature_hash;
    const expectedPolicyHash = INTRADAY_PROVIDER_ATTESTATION.intraday_policy_hash;
    const hybridMode = value.intraday_mode === 'hybrid_bootstrap'
      && value.intraday_model_version === 'intraday_hybrid_v2';
    const championMode = value.intraday_mode === 'ml_champion'
      && /^intraday_ml_(?:logistic|hist_gradient)_[a-f0-9]{12}$/.test(String(value.intraday_model_version || ''));
    if (!Number.isSafeInteger(value.intraday_decisions)
      || value.intraday_decisions < 1
      || value.intraday_decisions > runtimeContract.slot_review_limit
      || value.intraday_decisions !== value.decisions
      || (!hybridMode && !championMode)
      || value.intraday_feature_version !== INTRADAY_PROVIDER_ATTESTATION.intraday_feature_version
      || value.intraday_policy_version !== INTRADAY_PROVIDER_ATTESTATION.intraday_policy_version
      || value.intraday_feature_hash !== expectedFeatureHash
      || value.intraday_policy_hash !== expectedPolicyHash) {
      throw new Error('invalid_intraday_output_contract');
    }
  }
  let reportMessage = null;
  if (value.status === 'report_ready') {
    reportMessage = validateReportMessage(value.report_message, value.official_trade_date, value.decisions, runtimeContract);
  }
  else if (value.report_message !== null) throw new Error('unexpected_report_message');
  return Object.freeze({
    status: value.status, failClosed: value.fail_closed, reportMessage,
    officialTradeDate: value.official_trade_date, actionType: safeText(value.action_type, 60),
    errorClass: safeText(value.error_class, 80), transportDegraded: value.transport_degraded,
    failurePhase: safeText(value.failure_phase, 40), failureSymbol: value.failure_symbol,
    failureExceptionType: safeText(value.failure_exception_type, 40),
    failureErrno: value.failure_errno, failureAttemptNumber: value.failure_attempt_number,
  });
}

function parseKisVpsAutonomousOutput(
  stdout,
  expectedTaskId = ORDER_TASK.id,
  runtimeContract = REQUIRED_RUNTIME_CONTRACT,
) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) throw new Error('unsafe_order_output');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_order_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== ORDER_OUTPUT_KEYS.size
    || [...ORDER_OUTPUT_KEYS].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('invalid_order_output_fields');
  }
  if (value.task_id !== expectedTaskId || expectedTaskId !== ORDER_TASK.id
    || !['success', 'no_op', 'blocked'].includes(value.status)
    || !ORDER_ACTIONS.has(value.action_type)
    || typeof value.error_class !== 'string'
    || !(value.official_trade_date === null || /^\d{4}-\d{2}-\d{2}$/.test(value.official_trade_date))) {
    throw new Error('invalid_order_output_contract');
  }
  const counts = [
    'order_api_calls', 'vps_live_orders', 'prod_orders', 'reconciliations', 'open_positions',
    'daily_entry_count', 'shadow_predictions_inserted', 'shadow_duplicates_skipped',
    'requested_quantity', 'filled_quantity', 'unfilled_quantity',
  ];
  if (counts.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.order_api_calls > runtimeContract.max_order_posts_per_invocation || value.vps_live_orders > runtimeContract.max_order_posts_per_invocation || value.prod_orders !== 0
    || value.reconciliations > 1 || value.open_positions > runtimeContract.max_open_positions) {
    throw new Error('unsafe_order_count');
  }
  const booleans = [
    'artifact_reused', 'artifact_promoted', 'model_v2_changed', 'scheduler_changed', 'retry', 'catch_up', 'backfill',
    'fail_closed', 'raw_response_persisted', 'secret_exposure',
  ];
  if (booleans.some((key) => typeof value[key] !== 'boolean')
    || value.model_v2_changed !== false
    || value.scheduler_changed !== false || value.retry !== false || value.catch_up !== false
    || value.backfill !== false || value.raw_response_persisted !== false || value.secret_exposure !== false) {
    throw new Error('unsafe_order_output');
  }
  if (!hasIntradayProviderAttestation(value)) throw new Error('intraday_provider_attestation_mismatch');
  if (!(value.intraday_mode === null || ['hybrid_bootstrap', 'ml_champion'].includes(value.intraday_mode))
    || !(value.intraday_model_version === null
      || /^intraday_(?:hybrid_v2|ml_[a-z0-9_]+)$/.test(value.intraday_model_version))) {
    throw new Error('intraday_model_contract_invalid');
  }
  const artifactHash = value.artifact_hash;
  const previousArtifactHash = value.previous_artifact_hash;
  if (!(artifactHash === null || /^[a-f0-9]{64}$/.test(artifactHash))
    || (value.status !== 'blocked' && artifactHash === null)) throw new Error('invalid_order_artifact_hash');
  if (!(previousArtifactHash === null || /^[a-f0-9]{64}$/.test(previousArtifactHash))) {
    throw new Error('invalid_order_previous_artifact_hash');
  }
  if (value.artifact_promoted) {
    if (value.status !== 'success' || value.artifact_reused !== false || value.action_type !== 'shadow_refreshed'
      || previousArtifactHash === null || previousArtifactHash === artifactHash) {
      throw new Error('invalid_order_artifact_promotion');
    }
  } else if (value.artifact_reused !== true
    || !(previousArtifactHash === null || previousArtifactHash === artifactHash)) {
    throw new Error('invalid_order_artifact_reuse');
  }
  if (!(value.order_symbol === null || KRX_SYMBOL_RE.test(String(value.order_symbol)))
    || !(value.order_side === null || ['buy', 'sell'].includes(value.order_side))
    || !(value.lifecycle_status === null
      || ['submitted', 'accepted', 'partial_fill', 'filled', 'cancelled', 'liquidated', 'unknown'].includes(value.lifecycle_status))
    || !Array.isArray(value.decision_reason_codes) || value.decision_reason_codes.length > 5
    || value.decision_reason_codes.some((code) => !AI_REASON_CODES.has(code))
    || !(value.notification_idempotency_key === null
      || /^[a-f0-9]{64}$/.test(value.notification_idempotency_key))) {
    throw new Error('invalid_order_lifecycle_contract');
  }
  const hasOrderLifecycle = value.order_symbol !== null;
  if (hasOrderLifecycle !== (value.order_side !== null)
    || hasOrderLifecycle !== (value.lifecycle_status !== null)
    || hasOrderLifecycle !== (value.notification_idempotency_key !== null)
    || (!hasOrderLifecycle && (value.requested_quantity !== 0 || value.filled_quantity !== 0
      || value.unfilled_quantity !== 0 || value.decision_reason_codes.length !== 0))
    || (hasOrderLifecycle && (value.requested_quantity <= 0
      || value.filled_quantity + value.unfilled_quantity > value.requested_quantity))) {
    throw new Error('invalid_order_lifecycle_contract');
  }
  const blocked = value.status === 'blocked';
  const normalizedErrorClass = sanitizeErrorClass(value.error_class);
  if (value.fail_closed !== blocked
    || (blocked && (value.action_type !== 'paused' || value.error_class === 'none'))
    || (!blocked && value.error_class !== 'none')) throw new Error('invalid_order_fail_closed_contract');
  if (ORDER_EXECUTION_ACTIONS.has(value.action_type)) {
    if (value.status !== 'success' || value.order_api_calls !== 1
      || value.vps_live_orders !== 1 || value.reconciliations !== 1) throw new Error('invalid_order_execution_contract');
  } else if (value.action_type === 'reconciliation_recovered') {
    if (value.status !== 'success' || value.order_api_calls !== 0
      || value.vps_live_orders !== 0 || value.reconciliations !== 1) {
      throw new Error('invalid_reconciliation_recovery_contract');
    }
  } else if (!blocked && (value.order_api_calls !== 0 || value.vps_live_orders !== 0 || value.reconciliations !== 0)) {
    throw new Error('unexpected_order_execution');
  }
  return Object.freeze({
    status: value.status,
    failClosed: value.fail_closed,
    officialTradeDate: value.official_trade_date,
    actionType: safeText(value.action_type, 60),
    errorClass: normalizedErrorClass,
    orderApiCalls: value.order_api_calls,
    vpsLiveOrders: value.vps_live_orders,
    reconciliations: value.reconciliations,
    openPositions: value.open_positions,
    dailyEntryCount: value.daily_entry_count,
    artifactPromoted: value.artifact_promoted,
    previousArtifactHash,
    artifactHash,
    intradayMode: value.intraday_mode,
    intradayModelVersion: value.intraday_model_version,
    shadowPredictionsInserted: value.shadow_predictions_inserted,
    shadowDuplicatesSkipped: value.shadow_duplicates_skipped,
    orderSymbol: value.order_symbol,
    orderSide: value.order_side,
    requestedQuantity: value.requested_quantity,
    filledQuantity: value.filled_quantity,
    unfilledQuantity: value.unfilled_quantity,
    lifecycleStatus: value.lifecycle_status,
    decisionReasonCodes: value.decision_reason_codes,
    notificationIdempotencyKey: value.notification_idempotency_key,
  });
}

function isWeeklyUniverseRefreshDue(task, date) {
  const parts = seoulParts(date);
  return task.id === TASKS[0].id && !['Sat', 'Sun'].includes(parts.weekday);
}

function isDeterministicRiskOffSlot(task, date) {
  if (task.kind !== 'order') return false;
  const parts = seoulParts(date);
  return Number(parts.hour) === 14 && [41, 42].includes(Number(parts.minute));
}

function buildOrderLifecycleMessage(parsed) {
  if (!parsed?.notificationIdempotencyKey) return null;
  const side = parsed.orderSide === 'buy' ? '매수' : '매도';
  const status = {
    submitted: '제출', accepted: '접수', partial_fill: '부분체결', filled: '완전체결',
    cancelled: '취소', liquidated: '청산', unknown: '제출상태 확인 중',
  }[parsed.lifecycleStatus];
  const quantity = parsed.lifecycleStatus === 'partial_fill'
    ? `${parsed.filledQuantity}/${parsed.requestedQuantity}주`
    : `${parsed.filledQuantity || parsed.requestedQuantity}주`;
  return [
    '[KIS AI 모의투자]',
    `주문: ${side} ${parsed.orderSymbol} ${quantity}`,
    `상태: ${status}`,
    `AI 판단: ${parsed.decisionReasonCodes.join(', ') || '규칙 기반 보호 청산'}`,
  ].join('\n');
}

function normalizedAiCandidates(value = [], runtimeContract = REQUIRED_RUNTIME_CONTRACT) {
  if (!Array.isArray(value) || value.length > runtimeContract.slot_review_limit) throw new Error('invalid_ai_candidates');
  const expectedKeys = new Set([
    'symbol', 'role', 'review_tier', 'ml_action', 'confidence_bucket', 'prob_up', 'prob_flat', 'prob_down',
    'expected_net_return', 'risk_overlay', 'data_quality',
  ]);
  const symbols = value.map((item) => item?.symbol);
  if (symbols.some((symbol) => !KRX_SYMBOL_RE.test(String(symbol || ''))) || new Set(symbols).size !== symbols.length) {
    throw new Error('invalid_ai_candidates');
  }
  return value.map((item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object'
      || Object.keys(item).length !== expectedKeys.size
      || [...expectedKeys].some((key) => !Object.prototype.hasOwnProperty.call(item, key))
      || !['held_position', 'eligible_entry'].includes(item.role)
      || !['position', 'primary', 'watch'].includes(item.review_tier)
      || (item.role === 'held_position' && item.review_tier !== 'position')
      || (item.role === 'eligible_entry' && item.review_tier === 'position')
      || !AI_DECISION_ACTIONS.has(item.ml_action)
      || !AI_CONFIDENCE_BUCKETS.has(item.confidence_bucket)
      || !['ALLOW', 'BLOCK_ENTRY', 'FORCE_EXIT', 'SYSTEM_PAUSE'].includes(item.risk_overlay)
      || !['PASS', 'BLOCKED'].includes(item.data_quality)
      || ['prob_up', 'prob_flat', 'prob_down', 'expected_net_return']
        .some((key) => !Number.isFinite(item[key]))
      || ['prob_up', 'prob_flat', 'prob_down'].some((key) => item[key] < 0 || item[key] > 1)
      || Math.abs((item.prob_up + item.prob_flat + item.prob_down) - 1) > 0.000001) {
      throw new Error('invalid_ai_candidates');
    }
    return Object.freeze({ ...item });
  });
}

function buildSanitizedAiPacket({ slotId, context, runtimeContract = REQUIRED_RUNTIME_CONTRACT } = {}) {
  if (typeof slotId !== 'string' || !/^(?:kis-ai-intraday-shadow-validation-v1|kis-vps-model-v3-autonomous-pilot-v1):\d{4}-\d{2}-\d{2}:\d{2}:\d{2}$/.test(slotId)) {
    throw new Error('invalid_ai_slot_id');
  }
  if (!context || Array.isArray(context) || typeof context !== 'object') throw new Error('invalid_decision_context');
  const candidates = normalizedAiCandidates(context.candidates, runtimeContract);
  const packet = {
    schema_version: 'kis_llm_decision_v1',
    slot_id: slotId,
    model_id: LLM_MODEL_ID,
    candidates,
    holdings: context.holdings,
    account_aggregate: context.account_aggregate,
    risk_aggregate: context.risk_aggregate,
    event_metadata: context.event_metadata,
    decision_contract: {
      actions: [...AI_DECISION_ACTIONS].sort(),
      confidence_buckets: [...AI_CONFIDENCE_BUCKETS].sort(),
      reason_codes: [...AI_REASON_CODES].sort(),
      max_candidates: runtimeContract.slot_review_limit,
      target_weight_pct: { minimum: 0, maximum: 50, non_enter: 0 },
      minimum_vps_entry_decisions: context.risk_aggregate.minimum_vps_entry_decisions,
    },
  };
  const promptHash = crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex');
  return Object.freeze({ ...packet, prompt_hash: promptHash });
}

function parseAiVerdict(value, packet, runtimeContract = REQUIRED_RUNTIME_CONTRACT) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== 4
    || ['slot_id', 'model_id', 'prompt_hash', 'decisions'].some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || value.slot_id !== packet.slot_id || value.model_id !== LLM_MODEL_ID || value.prompt_hash !== packet.prompt_hash
    || !Array.isArray(value.decisions) || value.decisions.length > runtimeContract.slot_review_limit) {
    throw new Error('invalid_ai_verdict');
  }
  const candidates = new Set(packet.candidates.map((item) => item.symbol));
  const symbols = new Set();
  for (const decision of value.decisions) {
    if (!decision || Array.isArray(decision) || typeof decision !== 'object'
      || Object.keys(decision).length !== 5
      || ['symbol', 'action', 'target_weight_pct', 'confidence_bucket', 'reason_codes']
        .some((key) => !Object.prototype.hasOwnProperty.call(decision, key))
      || !candidates.has(decision.symbol) || symbols.has(decision.symbol)
      || !AI_DECISION_ACTIONS.has(decision.action)
      || !Number.isFinite(decision.target_weight_pct) || decision.target_weight_pct < 0 || decision.target_weight_pct > 50
      || (decision.action !== 'ENTER' && decision.target_weight_pct !== 0)
      || !AI_CONFIDENCE_BUCKETS.has(decision.confidence_bucket)
      || !Array.isArray(decision.reason_codes) || decision.reason_codes.length < 1 || decision.reason_codes.length > 5
      || new Set(decision.reason_codes).size !== decision.reason_codes.length
      || decision.reason_codes.some((code) => !AI_REASON_CODES.has(code))) {
      throw new Error('invalid_ai_verdict');
    }
    symbols.add(decision.symbol);
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(serialized)) {
    throw new Error('unsafe_ai_verdict');
  }
  return serialized;
}

function buildDecisionContextCommand(schedulerToken, invocationDueKey) {
  if (!/^[a-f0-9]{32}$/.test(schedulerToken)
    || !invocationDueKey.startsWith(`${ORDER_TASK.id}:`)) throw new Error('scheduler_attestation_required');
  return {
    command: KIS_VENV_PYTHON,
    args: ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'decision-context'],
    cwd: KIS_REPO,
    env: {
      KIS_HERMES_SCHEDULER_TOKEN: schedulerToken,
      KIS_HERMES_DUE_KEY: invocationDueKey,
    },
  };
}

function parseDecisionContextOutput(stdout, expectedSlotId, runtimeContract = REQUIRED_RUNTIME_CONTRACT) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) throw new Error('invalid_decision_context');
  let value;
  const expectedTradeDate = typeof expectedSlotId === 'string' ? expectedSlotId.split(':')[1] : '';
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_decision_context'); }
  const keys = [
    'task_id', 'status', 'slot_id', 'model_id', 'official_trade_date', 'candidates',
    'holdings', 'account_aggregate', 'risk_aggregate', 'event_metadata', 'fail_closed',
    'error_class', 'raw_response_persisted', 'secret_exposure',
  ];
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || value.task_id !== 'kis-llm-decision-context-v1'
    || !['success', 'blocked'].includes(value.status)
    || value.slot_id !== expectedSlotId || value.model_id !== LLM_MODEL_ID
    || value.official_trade_date !== expectedTradeDate
    || value.raw_response_persisted !== false || value.secret_exposure !== false) {
    throw new Error('invalid_decision_context');
  }
  if (value.status === 'blocked') {
    if (value.fail_closed !== true || typeof value.error_class !== 'string' || value.error_class === 'none'
      || value.candidates.length !== 0 || value.holdings.length !== 0
      || Object.keys(value.account_aggregate).length !== 0 || Object.keys(value.risk_aggregate).length !== 0
      || value.event_metadata.length !== 0) throw new Error('invalid_decision_context');
    return Object.freeze({ blocked: true, errorClass: safeText(value.error_class, 80) });
  }
  if (value.fail_closed !== false || value.error_class !== 'none') throw new Error('invalid_decision_context');
  const candidates = normalizedAiCandidates(value.candidates, runtimeContract);
  if (!Array.isArray(value.holdings) || value.holdings.length > runtimeContract.max_open_positions
    || value.holdings.some((item) => !item || Array.isArray(item) || typeof item !== 'object'
      || Object.keys(item).length !== 2 || !KRX_SYMBOL_RE.test(String(item.symbol || ''))
      || !Number.isSafeInteger(item.quantity) || item.quantity <= 0)
    || !value.account_aggregate || Object.keys(value.account_aggregate).length !== 2
    || !Number.isFinite(value.account_aggregate.available_cash) || value.account_aggregate.available_cash < 0
    || !Number.isFinite(value.account_aggregate.account_equity) || value.account_aggregate.account_equity <= 0
    || !value.risk_aggregate || Object.keys(value.risk_aggregate).length !== 9
    || value.risk_aggregate.active_daily_entry_cap !== null
    || ['open_positions', 'open_orders', 'daily_entry_submit_count', 'max_positions',
      'minimum_vps_entry_decisions']
      .some((key) => !Number.isSafeInteger(value.risk_aggregate[key]) || value.risk_aggregate[key] < 0)
    || value.risk_aggregate.minimum_vps_entry_decisions !== 0
    || value.risk_aggregate.max_positions !== runtimeContract.max_open_positions
    || value.risk_aggregate.max_symbol_equity_pct !== runtimeContract.max_symbol_equity_pct
    || value.risk_aggregate.planned_position_loss_pct !== runtimeContract.planned_position_loss_pct
    || value.risk_aggregate.daily_loss_limit_pct !== runtimeContract.max_aggregate_open_risk_pct
    || ['max_symbol_equity_pct', 'planned_position_loss_pct', 'daily_loss_limit_pct']
      .some((key) => !Number.isFinite(value.risk_aggregate[key]) || value.risk_aggregate[key] <= 0)
    || !Array.isArray(value.event_metadata) || value.event_metadata.length > 20
    || value.event_metadata.some((item) => !item || Array.isArray(item) || typeof item !== 'object'
      || Object.keys(item).length !== 5
      || ['source', 'event_type', 'published_at', 'available_at', 'relevance']
        .some((key) => !Object.prototype.hasOwnProperty.call(item, key)))) {
    throw new Error('invalid_decision_context');
  }
  return Object.freeze({
    candidates,
    holdings: value.holdings.map((item) => Object.freeze({ ...item })),
    account_aggregate: Object.freeze({ ...value.account_aggregate }),
    risk_aggregate: Object.freeze({ ...value.risk_aggregate }),
    event_metadata: value.event_metadata.map((item) => Object.freeze({ ...item })),
  });
}

function buildSafetyMonitorCommand() {
  return { command: KIS_VENV_PYTHON, args: ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'safety-monitor'], cwd: KIS_REPO };
}

function buildReconciliationRecoveryCommand() {
  return {
    command: KIS_VENV_PYTHON,
    args: [
      '-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'reconcile-paused',
      '--confirm', '--approval', 'APPROVE_KIS_HERMES_VPS_RECONCILIATION_RECOVERY_V1',
    ],
    cwd: KIS_REPO,
  };
}

function isPostCloseRefreshSlot(task, value) {
  if (task.id !== ORDER_TASK.id) return false;
  const parts = seoulParts(value);
  return Number(parts.hour) === 16 && Number(parts.minute) === 20;
}

function parseCutoverOutput(stdout) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) throw new Error('unsafe_cutover_output');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_cutover_output'); }
  const keys = [
    'task_id', 'status', 'action_type', 'activation_performed', 'execution_owner_before',
    'execution_owner_after', 'distinct_vps_days', 'reconciled_round_trips',
    'unresolved_major_incidents', 'vps_flat', 'open_orders', 'db_integrity_ok',
    'active_scheduler_count', 'blocked_issue_count', 'prod_db_touched', 'prod_orders',
    'vps_live_orders', 'order_api_calls', 'retry', 'fail_closed', 'error_class',
  ];
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || value.task_id !== 'kis-vps-to-prod-cutover-v1'
    || !['blocked', 'INELIGIBLE', 'CUTOVER_PENDING', 'success'].includes(value.status)
    || !['cutover_check', 'cutover_ineligible', 'cutover_pending', 'cutover_activated', 'cutover_idempotent_no_op'].includes(value.action_type)
    || !['vps', 'prod', 'disabled', 'unknown'].includes(value.execution_owner_before)
    || !['vps', 'prod', 'disabled', 'unknown'].includes(value.execution_owner_after)
    || ['distinct_vps_days', 'reconciled_round_trips', 'unresolved_major_incidents', 'open_orders', 'active_scheduler_count', 'blocked_issue_count']
      .some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.active_scheduler_count !== 1
    || ['activation_performed', 'vps_flat', 'db_integrity_ok', 'prod_db_touched', 'retry', 'fail_closed']
      .some((key) => typeof value[key] !== 'boolean')
    || value.prod_orders !== 0 || value.vps_live_orders !== 0 || value.order_api_calls !== 0
    || value.retry !== false || typeof value.error_class !== 'string'
    || value.fail_closed !== (value.status === 'blocked')
    || (value.activation_performed && (
      value.status !== 'success' || value.action_type !== 'cutover_activated'
      || value.execution_owner_before !== 'vps' || value.execution_owner_after !== 'prod'
      || value.prod_db_touched !== true || value.error_class !== 'none'
      || value.distinct_vps_days < MIN_VPS_CUTOVER_DAYS
      || value.reconciled_round_trips < MIN_RECONCILED_ROUND_TRIPS
      || value.unresolved_major_incidents !== 0 || value.blocked_issue_count !== 0
      || value.vps_flat !== true || value.open_orders !== 0 || value.db_integrity_ok !== true
    ))
    || (!value.activation_performed && (
      value.prod_db_touched !== false
      || value.action_type === 'cutover_activated'
      || (
        value.action_type === 'cutover_idempotent_no_op'
          ? value.status !== 'success' || value.execution_owner_before !== 'prod'
            || value.execution_owner_after !== 'prod' || value.error_class !== 'none'
          : value.execution_owner_before !== value.execution_owner_after || value.status === 'success'
      )
    ))) {
    throw new Error('invalid_cutover_output');
  }
  return Object.freeze({
    status: value.status,
    actionType: value.action_type,
    activationPerformed: value.activation_performed,
    executionOwnerBefore: value.execution_owner_before,
    executionOwnerAfter: value.execution_owner_after,
    distinctVpsDays: value.distinct_vps_days,
    reconciledRoundTrips: value.reconciled_round_trips,
    unresolvedMajorIncidents: value.unresolved_major_incidents,
    vpsFlat: value.vps_flat,
    openOrders: value.open_orders,
    dbIntegrityOk: value.db_integrity_ok,
    blockedIssueCount: value.blocked_issue_count,
    prodDbTouched: value.prod_db_touched,
    failClosed: value.fail_closed,
    errorClass: safeText(value.error_class, 80),
  });
}

function buildWeeklyUniverseCommand() {
  return {
    command: KIS_VENV_PYTHON,
    args: [
      '-m', 'kis_trading_lab', 'model-v3-run',
      '--approval', MODEL_V3_RESEARCH_APPROVAL,
      '--action', 'weekly-universe',
      '--db', VPS_DB_PATH,
    ],
    cwd: KIS_REPO,
  };
}

function buildIndependentShadowRefreshCommand() {
  return {
    command: KIS_VENV_PYTHON,
    args: [
      '-m', 'kis_trading_lab', 'vps-autonomous-order',
      '--action', 'refresh-shadow',
      '--confirm',
      '--approval', MODEL_V3_RESEARCH_APPROVAL,
    ],
    cwd: KIS_REPO,
  };
}

function parseWeeklyUniverseOutput(stdout) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) {
    throw new Error('unsafe_weekly_universe_output');
  }
  const entries = raw.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    if (index <= 0) throw new Error('invalid_weekly_universe_output');
    return [line.slice(0, index), line.slice(index + 1)];
  });
  const value = Object.fromEntries(entries);
  const keys = [
    'status', 'action_type', 'iso_week', 'selected_count', 'exit_only_count', 'api_calls',
    'official_downloads', 'db_written', 'artifact_changed', 'live_candidates_changed',
    'raw_response_persisted', 'prod_db_touched', 'order_attempted', 'fail_closed', 'error_class',
  ];
  if (entries.length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('invalid_weekly_universe_output');
  }
  const numeric = Object.fromEntries(
    ['selected_count', 'exit_only_count', 'api_calls', 'official_downloads']
      .map((key) => [key, Number(value[key])]),
  );
  const boolean = Object.fromEntries(
    ['db_written', 'artifact_changed', 'live_candidates_changed', 'raw_response_persisted', 'prod_db_touched', 'order_attempted', 'fail_closed']
      .map((key) => [key, value[key] === 'true']),
  );
  if (!['success', 'blocked'].includes(value.status)
    || !['weekly_universe_refresh', 'weekly_universe_idempotent_no_op'].includes(value.action_type)
    || !/^\d{4}-W\d{2}$/.test(value.iso_week)
    || Object.values(numeric).some((item) => !Number.isSafeInteger(item) || item < 0)
    || numeric.selected_count > 50 || numeric.api_calls > 3 || numeric.official_downloads > 2
    || boolean.artifact_changed || boolean.live_candidates_changed
    || boolean.raw_response_persisted || boolean.prod_db_touched || boolean.order_attempted
    || boolean.fail_closed !== (value.status === 'blocked')
    || (value.status === 'success' && value.error_class !== 'none')) {
    throw new Error('invalid_weekly_universe_output');
  }
  return Object.freeze({
    status: value.status,
    actionType: value.action_type,
    isoWeek: value.iso_week,
    selectedCount: numeric.selected_count,
    exitOnlyCount: numeric.exit_only_count,
    apiCalls: numeric.api_calls,
    officialDownloads: numeric.official_downloads,
    dbWritten: boolean.db_written,
    failClosed: boolean.fail_closed,
    errorClass: safeText(value.error_class, 80),
  });
}

function parseSafetyMonitorOutput(stdout) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) throw new Error('unsafe_safety_output');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_safety_output'); }
  const keys = ['task_id', 'status', 'action_type', 'execution_owner', 'process_lock', 'kill_state', 'open_order_status', 'reconciliation_status', 'account_risk_status', 'order_api_calls', 'vps_live_orders', 'prod_orders', 'retry', 'catch_up', 'fail_closed', 'error_class'];
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || value.task_id !== 'kis-vps-safety-monitor-v1' || !['success', 'blocked'].includes(value.status)
    || value.action_type !== 'safety_monitor' || !['clear', 'active', 'unknown'].includes(value.process_lock)
    || !['vps', 'prod', 'unknown'].includes(value.execution_owner)
    || !['clear', 'active', 'unknown'].includes(value.kill_state)
    || !['clear', 'active', 'unknown'].includes(value.open_order_status)
    || !['clear', 'active', 'unknown'].includes(value.reconciliation_status)
    || !['clear', 'active', 'unknown'].includes(value.account_risk_status)
    || value.order_api_calls !== 0 || value.vps_live_orders !== 0 || value.prod_orders !== 0
    || value.retry !== false || value.catch_up !== false || typeof value.fail_closed !== 'boolean'
    || typeof value.error_class !== 'string' || value.fail_closed !== (value.status === 'blocked')
    || (value.status === 'success' && [value.process_lock, value.kill_state, value.open_order_status, value.reconciliation_status, value.account_risk_status].some((status) => status !== 'clear'))) throw new Error('invalid_safety_output');
  return Object.freeze(value);
}

function buildCommand(taskId, { activationPreflight = false, schedulerToken = '', dueKey: invocationDueKey = '', verdictPath = '', promptHash = '' } = {}) {
  if (!TASK_BY_ID.has(taskId)) throw new Error('unknown_task_id');
  if (verdictPath && !/^[a-f0-9]{64}$/.test(promptHash)) throw new Error('invalid_ai_verdict');
  if (taskId === ORDER_TASK.id) {
    const postCloseRefresh = !activationPreflight && invocationDueKey.endsWith(':16:20');
    const action = activationPreflight ? 'activation-check' : postCloseRefresh ? 'scheduled-refresh-shadow' : 'run-once';
    const args = ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', action];
    if (!activationPreflight) {
      if (!/^[a-f0-9]{32}$/.test(schedulerToken) || !invocationDueKey.startsWith(`${ORDER_TASK.id}:`)) {
        throw new Error('scheduler_attestation_required');
      }
    }
    return {
      command: KIS_VENV_PYTHON,
      args,
      cwd: KIS_REPO,
      env: activationPreflight ? {} : {
        KIS_HERMES_SCHEDULER_TOKEN: schedulerToken,
        KIS_HERMES_DUE_KEY: invocationDueKey,
        KIS_INTRADAY_PROVIDER_ID: INTRADAY_PROVIDER_ATTESTATION.decision_provider,
        KIS_INTRADAY_FEATURE_VERSION: INTRADAY_PROVIDER_ATTESTATION.intraday_feature_version,
        KIS_INTRADAY_FEATURE_HASH: INTRADAY_PROVIDER_ATTESTATION.intraday_feature_hash,
        KIS_INTRADAY_POLICY_VERSION: INTRADAY_PROVIDER_ATTESTATION.intraday_policy_version,
        KIS_INTRADAY_POLICY_HASH: INTRADAY_PROVIDER_ATTESTATION.intraday_policy_hash,
        KIS_INTRADAY_DAILY_ENTRY_CAP: String(INTRADAY_PROVIDER_ATTESTATION.daily_entry_cap),
        ...(verdictPath ? { KIS_LLM_VERDICT_PATH: verdictPath, KIS_LLM_PROMPT_HASH: promptHash } : {}),
      },
    };
  }
  const args = ['-m', 'kis_trading_lab', 'ai-market-open-dry-run-once', '--approval', ACTIVATION_APPROVAL, '--task-id', taskId, '--strategy-manifest', STRATEGY_MANIFEST, '--db', VPS_DB_PATH];
  if (activationPreflight) args.push('--activation-preflight');
  return { command: KIS_VENV_PYTHON, args, cwd: KIS_REPO, env: verdictPath ? { KIS_LLM_VERDICT_PATH: verdictPath } : {} };
}

function buildDiagnosticCommand() {
  return { command: 'python3', args: ['-m', 'kis_trading_lab', 'ai-quote-transport-diagnose-once'], cwd: KIS_REPO };
}

function parseQuoteTransportDiagnosticOutput(stdout) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) throw new Error('unsafe_diagnostic_output');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_diagnostic_json'); }
  const keys = new Set([
    'status', 'task_id', 'official_trade_date', 'occurred_at', 'symbols_attempted',
    'symbols_succeeded', 'failed_symbol_count', 'transport_error_class', 'results',
    'api_retries', 'order_api_calls', 'vps_live_orders', 'prod_orders',
    'raw_response_persisted', 'secret_exposure', 'retry',
  ]);
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== keys.size
    || [...keys].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('invalid_diagnostic_fields');
  if (value.task_id !== 'kis-ai-quote-transport-diagnose-v1'
    || !['pass', 'blocked'].includes(value.status)
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.official_trade_date)
    || Number.isNaN(Date.parse(value.occurred_at))
    || !Number.isSafeInteger(value.symbols_attempted) || value.symbols_attempted < 0 || value.symbols_attempted > 3
    || !Number.isSafeInteger(value.symbols_succeeded) || value.symbols_succeeded < 0 || value.symbols_succeeded > 3
    || !Number.isSafeInteger(value.failed_symbol_count) || value.failed_symbol_count < 0 || value.failed_symbol_count > 3
    || value.symbols_succeeded + value.failed_symbol_count !== value.symbols_attempted
    || !Array.isArray(value.results) || value.results.length !== value.symbols_attempted
    || value.api_retries !== 0 || value.order_api_calls !== 0 || value.vps_live_orders !== 0
    || value.prod_orders !== 0 || value.raw_response_persisted !== false
    || value.secret_exposure !== false || value.retry !== false) throw new Error('invalid_diagnostic_contract');
  const resultKeys = new Set([
    'symbol', 'status', 'phase', 'error_class', 'exception_type', 'sanitized_errno',
    'attempt_number', 'occurred_at', 'retry', 'order_api_calls',
  ]);
  const seen = new Set();
  for (const item of value.results) {
    if (!item || Array.isArray(item) || typeof item !== 'object'
      || Object.keys(item).length !== resultKeys.size
      || [...resultKeys].some((key) => !Object.prototype.hasOwnProperty.call(item, key))
      || !LEGACY_WATCHLIST_SYMBOLS.includes(item.symbol) || seen.has(item.symbol)
      || !['pass', 'blocked'].includes(item.status) || !FAILURE_PHASES.has(item.phase)
      || !FAILURE_EXCEPTION_TYPES.has(item.exception_type)
      || !(item.sanitized_errno === null || Number.isSafeInteger(item.sanitized_errno))
      || !Number.isSafeInteger(item.attempt_number) || item.attempt_number < 1 || item.attempt_number > 3
      || item.retry !== false || item.order_api_calls !== 0 || Number.isNaN(Date.parse(item.occurred_at))) {
      throw new Error('invalid_diagnostic_result');
    }
    seen.add(item.symbol);
  }
  const passed = value.status === 'pass';
  if (passed !== (value.symbols_attempted === 3 && value.symbols_succeeded === 3
    && value.failed_symbol_count === 0 && value.transport_error_class === 'none'
    && seen.size === 3 && value.results.every((item) => item.status === 'pass'
      && item.error_class === 'none' && item.exception_type === 'none'))) throw new Error('diagnostic_pass_contract_invalid');
  return Object.freeze({ passed, symbolsAttempted: value.symbols_attempted, symbolsSucceeded: value.symbols_succeeded, errorClass: safeText(value.transport_error_class, 80) });
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function defaultSourceParityCheck() {
  let sourceRealPath;
  let runtimeRealPath;
  try {
    sourceRealPath = fs.realpathSync(APPROVED_SOURCE_TASK_PATH);
    runtimeRealPath = fs.realpathSync(__filename);
  } catch { return false; }
  if (sourceRealPath === runtimeRealPath
    || !fs.statSync(sourceRealPath).isFile()) return false;
  return fileSha256(sourceRealPath) === fileSha256(runtimeRealPath);
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function acquireExclusiveLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code !== 'EEXIST') throw new Error('scheduler_lock_failed');
    let existing;
    try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { throw new Error('scheduler_lock_stale'); }
    const createdAt = new Date(existing.created_at);
    const ageMs = Date.now() - createdAt.getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= EXEC_TIMEOUT_MS + 60_000
      && processIsAlive(Number(existing.pid))) throw new Error('scheduler_lock_active');
    throw new Error('scheduler_lock_stale');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true; fs.closeSync(fd); fs.unlinkSync(lockPath);
  };
}

function acquireSchedulerOwnershipLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString('hex');
  const payload = { pid: process.pid, token, created_at: new Date().toISOString() };
  let fd;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      fs.fsyncSync(fd);
      break;
    } catch (error) {
      if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
      if (error.code !== 'EEXIST') throw new Error('scheduler_owner_lock_failed');
      let existing;
      try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
      catch { throw new Error('scheduler_owner_lock_invalid'); }
      if (processIsAlive(Number(existing.pid))) throw new Error('scheduler_owner_lock_active');
      if (attempt > 0) throw new Error('scheduler_owner_lock_stale');
      try { fs.unlinkSync(lockPath); }
      catch { throw new Error('scheduler_owner_lock_stale'); }
    }
  }
  if (fd === undefined) throw new Error('scheduler_owner_lock_failed');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(fd);
    let current;
    try { current = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
    catch { throw new Error('scheduler_owner_lock_release_failed'); }
    if (current.token !== token || Number(current.pid) !== process.pid) {
      throw new Error('scheduler_owner_lock_release_failed');
    }
    fs.unlinkSync(lockPath);
  };
}

function readPausedLegacyState(statePath, label) {
  let value;
  try { value = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { throw new Error(`${label}_state_unavailable`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || String(value.state || '').toUpperCase() !== 'PAUSED' || value.next_run_at !== null) throw new Error(`${label}_must_be_paused`);
}

function defaultRuntimeHealthCheck() {
  return new Promise((resolve) => {
    const request = http.get('http://127.0.0.1:17640/api/health', { timeout: 5000 }, (response) => {
      response.resume(); resolve(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

function createKisAiMarketOpenDryRunTask(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const errorNotificationStatePath = options.errorNotificationStatePath || `${statePath}.error-notification.json`;
  const legacyV1StatePath = options.legacyV1StatePath || LEGACY_V1_STATE_PATH;
  const legacyV2StatePath = options.legacyV2StatePath || LEGACY_V2_STATE_PATH;
  const legacyV1RunLockPath = options.legacyV1RunLockPath || LEGACY_V1_RUN_LOCK_PATH;
  const legacyV2RunLockPath = options.legacyV2RunLockPath || LEGACY_V2_RUN_LOCK_PATH;
  const runLockPath = options.runLockPath || DEFAULT_RUN_LOCK_PATH;
  const schedulerOwnerLockPath = options.schedulerOwnerLockPath || DEFAULT_SCHEDULER_OWNER_LOCK_PATH;
  const orderAttestationDir = options.orderAttestationDir || ORDER_ATTESTATION_DIR;
  const execFile = options.execFile || defaultExecFile;
  const now = options.now || (() => new Date());
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const runtimeHealthCheck = options.runtimeHealthCheck || defaultRuntimeHealthCheck;
  const reportSender = options.reportSender || null;
  const repairTaskSender = options.repairTaskSender || null;
  const sourceParityCheck = options.sourceParityCheck || defaultSourceParityCheck;
  const resumeBlockingLockPaths = options.resumeBlockingLockPaths || RESUME_BLOCKING_LOCK_PATHS;
  const calendarProofResolver = options.calendarProofResolver || loadOfficialCalendarProof;
  const runtimeContract = options.runtimeContract || loadRuntimeContract(options.strategyManifestPath);
  const llmExecutor = options.llmExecutor || null;
  const emergencyStopExecutor = options.emergencyStopExecutor || null;
  const verdictDir = options.verdictDir || null;
  const schedulerRegistered = options.schedulerRegistered === true;
  const serverRegistered = options.serverRegistered === true;
  const safetyMonitorEnabled = options.safetyMonitorEnabled === true || schedulerRegistered;
  const enforceSchedulerOwnership = options.enforceSchedulerOwnership !== false;
  const execTimeoutMs = Math.min(Number(options.execTimeoutMs || EXEC_TIMEOUT_MS), EXEC_TIMEOUT_MS);
  const maxBuffer = Math.min(Number(options.maxBuffer || MAX_BUFFER_BYTES), MAX_BUFFER_BYTES);
  let timer = null;
  let ticking = false;
  let schedulerFaulted = false;
  let releaseSchedulerOwnership = null;
  let stateFaultNotificationPromise = null;

  async function queueSelfHeal(key, taskId, errorClass, lastRun = {}) {
    if (!AUTO_REPAIRABLE_ERROR_CLASSES.has(errorClass) || typeof repairTaskSender !== 'function') {
      return { key, attempted: false, queued: false, status: 'manual_review_required' };
    }
    try {
      const result = await repairTaskSender({
        notificationKey: key,
        taskId,
        errorClass,
        repairOwner: errorClass === 'scheduler_state_fault' ? 'hermes' : 'kis',
        failurePhase: safeText(lastRun.failure_phase || 'none', 40),
        failureExceptionType: safeText(lastRun.failure_exception_type || 'none', 64),
        failureExitCode: Number.isSafeInteger(lastRun.failure_exit_code) ? lastRun.failure_exit_code : null,
        failureSignal: safeText(lastRun.failure_signal || 'none', 24),
        failureFingerprint: safeText(lastRun.failure_fingerprint || '', 64),
      });
      return {
        key,
        attempted: true,
        queued: result?.queued === true,
        task_id: typeof result?.task_id === 'string' ? result.task_id : null,
        status: result?.queued === true ? 'queued' : 'queue_failed',
      };
    } catch {
      return { key, attempted: true, queued: false, task_id: null, status: 'queue_failed' };
    }
  }

  async function createAiVerdictFile(taskId, slotId, dueTime, schedulerToken) {
    if (typeof llmExecutor !== 'function' || typeof verdictDir !== 'string' || verdictDir.length === 0) {
      throw new Error('llm_verdict_contract_unavailable');
    }
    const contextRun = await execute(buildDecisionContextCommand(schedulerToken, slotId));
    if (contextRun.error && Number(contextRun.error.code) !== 2) throw new Error('decision_context_process_error');
    const context = parseDecisionContextOutput(contextRun.stdout, slotId, runtimeContract);
    if (context.blocked) throw new Error(context.errorClass);
    if (context.candidates.length === 0) {
      return Object.freeze({
        path: null,
        promptHash: '',
        candidateCount: 0,
        llmInvoked: false,
        verdictStatus: 'skipped_no_candidates',
      });
    }
    const packet = buildSanitizedAiPacket({ slotId, context, runtimeContract });
    let timeout;
    const timed = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('llm_response_timeout')), LLM_RESPONSE_TIMEOUT_MS); });
    let response;
    try {
      response = await Promise.race([Promise.resolve(llmExecutor({ model: LLM_MODEL_ID, timeoutMs: LLM_RESPONSE_TIMEOUT_MS, packet })), timed]);
    } finally { clearTimeout(timeout); }
    const responseValue = typeof response === 'string' ? (() => { try { return JSON.parse(response); } catch { throw new Error('invalid_ai_verdict'); } })() : response;
    if (now().getTime() >= dueTime.getTime() + (10 * 60_000)) throw new Error('late_ai_verdict');
    const serialized = parseAiVerdict(responseValue, packet, runtimeContract);
    fs.mkdirSync(verdictDir, { recursive: true, mode: 0o700 });
    const file = path.join(verdictDir, `${crypto.randomBytes(16).toString('hex')}.json`);
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chmodSync(file, 0o600);
    return Object.freeze({
      path: file,
      promptHash: packet.prompt_hash,
      candidateCount: context.candidates.length,
      llmInvoked: true,
      verdictStatus: 'validated',
    });
  }

  function disabledState() {
    return { canonical_task_id: CANONICAL_TASK_ID, task_owner: TASK_OWNER, state: 'DISABLED', activation_approval: ACTIVATION_APPROVAL, timezone: TIMEZONE, state_path: statePath, max_concurrent_runs: 1, retry: false, catch_up: false, backfill: false, os_cron_used: false, scheduler_registered: false, server_registered: false, tasks: Object.fromEntries(TASKS.map((task) => [task.id, { state: 'DISABLED', schedule: task.schedule, next_run_at: null, last_due_at: null, last_run: null, consecutive_transport_failures: 0, pending_invocation: null, ...(task.kind === 'order' ? { activation_artifact_hash: null, refresh_only_pending: false, daily_entry_cap: INTRADAY_PROVIDER_ATTESTATION.daily_entry_cap, daily_entry_cap_approval_hash: null, ...INTRADAY_PROVIDER_ATTESTATION } : {}) }])) };
  }
  function loadStrict() {
    try {
      const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || !value.tasks
        || DRY_RUN_TASKS.some((task) => !value.tasks[task.id])) throw new Error('state_contract_invalid');
      if ((value.canonical_task_id !== undefined && value.canonical_task_id !== CANONICAL_TASK_ID)
        || (value.task_owner !== undefined && value.task_owner !== TASK_OWNER)) {
        throw new Error('state_contract_invalid');
      }
      value.canonical_task_id = CANONICAL_TASK_ID;
      value.task_owner = TASK_OWNER;
      if (!value.tasks[ORDER_TASK.id]) {
        value.tasks[ORDER_TASK.id] = {
          state: 'DISABLED', schedule: ORDER_TASK.schedule, next_run_at: null,
          last_due_at: null, last_run: null, consecutive_transport_failures: 0,
          pending_invocation: null, activation_artifact_hash: null, refresh_only_pending: false,
          daily_entry_cap: INTRADAY_PROVIDER_ATTESTATION.daily_entry_cap,
          daily_entry_cap_approval_hash: null,
          ...INTRADAY_PROVIDER_ATTESTATION,
        };
      }
      const orderTask = value.tasks[ORDER_TASK.id];
      if (orderTask.refresh_only_pending === undefined) orderTask.refresh_only_pending = false;
      if (typeof orderTask.refresh_only_pending !== 'boolean') throw new Error('state_contract_invalid');
      const providerFieldsPresent = Object.keys(INTRADAY_PROVIDER_ATTESTATION)
        .filter((key) => key !== 'daily_entry_cap')
        .some((key) => orderTask[key] !== undefined);
      const validCap = (
        orderTask.daily_entry_cap === runtimeContract.daily_entry_cap
          && orderTask.daily_entry_cap_approval_hash == null
      ) || (
        orderTask.daily_entry_cap === 3
          && orderTask.daily_entry_cap_approval_hash == null
      ) || (
        orderTask.daily_entry_cap === 5
          && orderTask.daily_entry_cap_approval_hash === DAILY_ENTRY_CAP_5_APPROVAL_HASH
      );
      const validIntraday = validCap
        && hasIntradayProviderAttestation(orderTask);
      const validPreviousIntraday = validCap
        && hasIntradayProviderAttestation(orderTask, LEGACY_INTRADAY_PROVIDER_ATTESTATION);
      const validLegacy = !providerFieldsPresent && (
        (orderTask.daily_entry_cap === 3 && orderTask.daily_entry_cap_approval_hash == null)
        || (orderTask.daily_entry_cap === 5
          && orderTask.daily_entry_cap_approval_hash === DAILY_ENTRY_CAP_5_APPROVAL_HASH)
      );
      if (!validIntraday && !validPreviousIntraday && !validLegacy) {
        throw new Error('state_contract_invalid');
      }
      orderTask.daily_entry_cap = runtimeContract.daily_entry_cap;
      orderTask.daily_entry_cap_approval_hash = null;
      Object.assign(orderTask, INTRADAY_PROVIDER_ATTESTATION);
      if (orderTask.state === 'ACTIVE') delete value.order_pause_reason;
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return disabledState();
      throw new Error('state_unavailable');
    }
  }
  function save(value) {
    if (value.tasks?.[ORDER_TASK.id]?.state === 'ACTIVE') delete value.order_pause_reason;
    atomicWrite(statePath, value);
    return value;
  }
  function stateUnavailableStatus() {
    return { ...disabledState(), state: 'PAUSED', pause_reason: 'state_unavailable', scheduler_faulted: true };
  }
  function stateFaultNotificationKey() {
    try {
      const stat = fs.statSync(statePath);
      return crypto.createHash('sha256').update(`scheduler_state_fault:${stat.size}:${stat.mtimeMs}`).digest('hex');
    } catch {
      return crypto.createHash('sha256').update('scheduler_state_fault:missing').digest('hex');
    }
  }
  async function notifyStateFaultOnce() {
    const key = stateFaultNotificationKey();
    const claimPath = `${errorNotificationStatePath}.${key}.claim`;
    let claimFd;
    try {
      fs.mkdirSync(path.dirname(claimPath), { recursive: true, mode: 0o700 });
      claimFd = fs.openSync(claimPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return { key, duplicate_suppressed: true };
      return { key, claim_failed: true };
    }
    const attempted = typeof reportSender === 'function';
    const claim = { key, error_class: 'scheduler_state_fault', attempted, succeeded: false, retry: false, claimed_at: now().toISOString() };
    try {
      fs.writeFileSync(claimFd, `${JSON.stringify(claim)}\n`, 'utf8');
      fs.fsyncSync(claimFd);
      fs.closeSync(claimFd);
      claimFd = undefined;
    } catch {
      if (claimFd !== undefined) {
        try { fs.closeSync(claimFd); } catch {}
      }
      try { fs.unlinkSync(claimPath); } catch {}
      return { key, claim_failed: true };
    }
    const selfHeal = await queueSelfHeal(key, TASKS[0].id, 'scheduler_state_fault');
    let succeeded = false;
    if (attempted) {
      try {
        const delivery = await reportSender({
          targetChannelId: REPORT_TARGET_CHANNEL_ID,
          content: `[KIS 자동운영 보호 중단]\n작업: 장 시작 감독\n상태: 보호 중단\n원인: scheduler_state_fault\n자동 재시도: 없음\n신규 주문: 중단\n자동 복구: ${selfHeal.queued ? `격리 작업 생성 (${selfHeal.task_id || 'queued'})` : '운영자 확인 필요'}`,
          deliveryLayer: 'hermes_ai_market_open_error',
        });
        succeeded = delivery?.discord_sent === true;
      } catch {
        succeeded = false;
      }
    }
    const completed = { ...claim, self_heal: selfHeal, succeeded, completed_at: now().toISOString() };
    try { fs.writeFileSync(claimPath, `${JSON.stringify(completed)}\n`, { encoding: 'utf8', mode: 0o600 }); } catch {}
    return completed;
  }
  function queueStateFaultNotification() {
    if (!stateFaultNotificationPromise) {
      stateFaultNotificationPromise = notifyStateFaultOnce().finally(() => { stateFaultNotificationPromise = null; });
    }
    return stateFaultNotificationPromise;
  }
  function status() {
    try { return { ...loadStrict(), scheduler_faulted: schedulerFaulted }; }
    catch {
      schedulerFaulted = true;
      void queueStateFaultNotification();
      return stateUnavailableStatus();
    }
  }
  function prepareDisabled() { return save(disabledState()); }
  function assertLegacyPaused() {
    readPausedLegacyState(legacyV1StatePath, 'model_v1');
    readPausedLegacyState(legacyV2StatePath, 'model_v2');
    if (fs.existsSync(legacyV1RunLockPath) || fs.existsSync(legacyV2RunLockPath)) throw new Error('legacy_run_lock_active');
  }
  function assertNoResumeBlockingLocks() {
    if (resumeBlockingLockPaths.some((lockPath) => fs.existsSync(lockPath))) throw new Error('writer_lock_active');
  }
  function pauseAll(current, taskId, reason, lastRun) {
    const tasks = Object.fromEntries(TASKS.map((task) => {
      const item = current.tasks[task.id];
      return [task.id, { ...item, state: 'PAUSED', pause_reason: task.id === taskId ? reason : 'peer_task_fail_closed', next_run_at: null, last_run: task.id === taskId ? lastRun : item.last_run }];
    }));
    return { ...current, state: 'PAUSED', pause_reason: reason, scheduler_registered: false, server_registered: false, tasks };
  }
  function pauseOrder(current, reason, lastRun) {
    const prior = current.tasks[ORDER_TASK.id];
    return {
      ...current,
      order_pause_reason: reason,
      tasks: {
        ...current.tasks,
        [ORDER_TASK.id]: {
          ...prior,
          state: 'PAUSED',
          pause_reason: reason,
          next_run_at: null,
          last_run: lastRun,
          pending_invocation: null,
        },
      },
    };
  }
  async function notifyPause(pausedState, taskId, reason, lastRun, { sendAllowed = true } = {}) {
    const errorClass = sanitizeErrorClass(reason);
    const taskState = pausedState.tasks?.[taskId];
    const notificationKey = crypto.createHash('sha256').update([
      taskId,
      String(taskState?.last_due_at || ''),
      String(lastRun?.completed_at || ''),
      errorClass,
    ].join(':')).digest('hex');
    if (pausedState.last_error_notification?.key === notificationKey) return pausedState;

    const attempted = sendAllowed && typeof reportSender === 'function';
    const claim = save({
      ...pausedState,
      last_error_notification: {
        key: notificationKey,
        task_id: taskId,
        error_class: errorClass,
        attempted,
        succeeded: false,
        retry: false,
        claimed_at: now().toISOString(),
      },
    });
    const selfHeal = await queueSelfHeal(notificationKey, taskId, errorClass, lastRun);

    const content = [
      '[KIS 자동운영 보호 중단]',
      `작업: ${TASK_ALERT_LABELS.get(taskId) || 'KIS 자동운영'}`,
      '상태: 보호 중단',
      `원인: ${errorClass || 'unknown_error'}`,
      '자동 재시도: 없음',
      '신규 주문: 중단',
      `자동 복구: ${taskId === TASKS[0].id && AUTO_RESUME_AFTER_CLEAR_SAFETY.has(errorClass)
        ? '안전 확인 자동 진행 중'
        : (selfHeal.queued ? `격리 작업 생성 (${selfHeal.task_id || 'queued'})` : '운영자 확인 필요')}`,
    ].join('\n');
    let succeeded = false;
    const queuedClaim = save({ ...claim, last_self_heal: selfHeal });
    if (attempted) {
      try {
        const delivery = await reportSender({
          targetChannelId: REPORT_TARGET_CHANNEL_ID,
          content,
          deliveryLayer: 'hermes_ai_market_open_error',
        });
        succeeded = delivery?.discord_sent === true;
      } catch {
        succeeded = false;
      }
    }
    try {
      const latest = loadStrict();
      const latestTask = latest.tasks?.[taskId];
      if (latestTask?.state !== 'PAUSED' || latestTask.pause_reason !== reason
        || latest.last_error_notification?.key !== notificationKey) return latest;
      return save({
        ...latest,
        last_error_notification: {
          ...latest.last_error_notification,
          succeeded,
          completed_at: now().toISOString(),
        },
      });
    } catch {
      return queuedClaim;
    }
  }
  async function notifyOrderLifecycle(current, parsed, lastRun) {
    const key = parsed.notificationIdempotencyKey;
    const content = buildOrderLifecycleMessage(parsed);
    if (!key || !content) return { state: current, lastRun };
    if (current.order_notification_ledger?.[key]) {
      return { state: current, lastRun: { ...lastRun, order_notification_duplicate_suppressed: true } };
    }
    const attempted = typeof reportSender === 'function';
    const ledger = { ...(current.order_notification_ledger || {}) };
    ledger[key] = { key, attempted, succeeded: false, retry: false, claimed_at: now().toISOString() };
    const orderedKeys = Object.keys(ledger).sort((left, right) => (
      String(ledger[left].claimed_at).localeCompare(String(ledger[right].claimed_at))
    ));
    for (const staleKey of orderedKeys.slice(0, Math.max(0, orderedKeys.length - 200))) delete ledger[staleKey];
    let state = save({ ...current, order_notification_ledger: ledger });
    let succeeded = false;
    if (attempted) {
      try {
        const delivery = await reportSender({
          targetChannelId: REPORT_TARGET_CHANNEL_ID,
          content,
          deliveryLayer: 'hermes_kis_order_lifecycle',
          idempotencyKey: key,
        });
        succeeded = delivery?.discord_sent === true;
      } catch {
        succeeded = false;
      }
    }
    try {
      const latest = loadStrict();
      if (latest.order_notification_ledger?.[key]) {
        state = save({
          ...latest,
          order_notification_ledger: {
            ...latest.order_notification_ledger,
            [key]: { ...latest.order_notification_ledger[key], succeeded, completed_at: now().toISOString() },
          },
        });
      }
    } catch {
      // Notification bookkeeping never changes or retries an already completed order cycle.
    }
    return {
      state,
      lastRun: {
        ...lastRun,
        order_notification_attempted: attempted,
        order_notification_succeeded: succeeded,
        order_notification_retry: false,
      },
    };
  }
  function execute(command) {
    return new Promise((resolve) => {
      execFile(command.command, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...(command.env || {}) },
        timeout: execTimeoutMs,
        maxBuffer,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
  }
  async function activate({ approval, invokedBy = 'hermes_cli' } = {}) {
    if (approval !== ACTIVATION_APPROVAL) throw new Error('exact_activation_approval_required');
    const current = loadStrict();
    if (current.state !== 'DISABLED') throw new Error('task_must_be_disabled');
    let release;
    try {
      release = acquireExclusiveLock(runLockPath);
      assertLegacyPaused();
      if (await runtimeHealthCheck() !== true) throw new Error('runtime_health_unavailable');
      const command = buildCommand(TASKS[0].id, { activationPreflight: true });
      const { error, stdout } = await execute(command);
      if (error) throw new Error('activation_preflight_process_error');
      const parsed = parseKisAiMarketOpenOutput(stdout, TASKS[0].id, calendarProofResolver, runtimeContract);
      if (parsed.status !== 'success' || parsed.failClosed || parsed.actionType !== 'activation_preflight') throw new Error('activation_preflight_failed');
      const activatedAt = now();
      const tasks = Object.fromEntries(TASKS.map((task) => [task.id, {
        ...(current.tasks[task.id] || {}),
        state: task.kind === 'order' ? 'DISABLED' : 'ACTIVE',
        schedule: task.schedule,
        next_run_at: task.kind === 'order' ? null : nextRunAt(task, activatedAt),
        ...(task.kind === 'order' ? { refresh_only_pending: false } : {}),
        last_due_at: current.tasks[task.id]?.last_due_at || null,
        last_run: task.id === TASKS[0].id ? { status: 'success', action_type: 'activation_preflight', fail_closed: false, invoked_by: safeText(invokedBy), completed_at: activatedAt.toISOString() } : current.tasks[task.id]?.last_run || null,
      }]));
      return save({ ...current, state: 'ACTIVE', activated_at: activatedAt.toISOString(), activated_by: safeText(invokedBy), scheduler_registered: false, server_registered: false, tasks });
    } finally { if (release) release(); }
  }
  async function resumeAfterIoFix({ approval, invokedBy = 'hermes_cli' } = {}) {
    if (approval !== RESUME_AFTER_IO_FIX_APPROVAL) throw new Error('exact_resume_approval_required');
    const current = loadStrict();
    const sanitizedReconciliationPause = current.pause_reason === 'sanitized_runtime_error'
      && current.last_safety_monitor?.execution_owner === 'vps'
      && current.last_safety_monitor?.reconciliation_status === 'active'
      && current.order_pause_reason === 'order_submission_unknown';
    if (current.state !== 'PAUSED'
      || (!RESUMABLE_PAUSE_REASONS.has(current.pause_reason) && !sanitizedReconciliationPause)) {
      throw new Error('task_not_resumable');
    }
    let release;
    try {
      release = acquireExclusiveLock(runLockPath);
      assertLegacyPaused();
      assertNoResumeBlockingLocks();
      if (await runtimeHealthCheck() !== true) throw new Error('runtime_health_unavailable');
      if (sourceParityCheck() !== true) throw new Error('runtime_source_parity_failed');
      if (PREFLIGHT_RESUMABLE_PAUSE_REASONS.has(current.pause_reason)) {
        const preflightRun = await execute(buildCommand(TASKS[0].id, { activationPreflight: true }));
        if (preflightRun.error?.killed) throw new Error('timeout');
        if (preflightRun.error && Number(preflightRun.error.code) !== 2) {
          throw new Error('database_recovery_preflight_process_error');
        }
        const preflight = parseKisAiMarketOpenOutput(
          preflightRun.stdout,
          TASKS[0].id,
          calendarProofResolver,
          runtimeContract,
        );
        const freshPreflight = preflight.status === 'success'
          && preflight.failClosed === false
          && preflight.actionType === 'activation_preflight';
        const sameDayPreflightAlreadyCompleted = current.pause_reason === 'account_risk_evidence_missing'
          && preflight.status === 'no_op'
          && preflight.failClosed === false
          && preflight.actionType === 'idempotent_no_op';
        if (!freshPreflight && !sameDayPreflightAlreadyCompleted) {
          const fallback = current.pause_reason === 'account_risk_evidence_missing'
            ? 'account_risk_recovery_preflight_failed'
            : 'database_recovery_preflight_failed';
          throw new Error(preflight.errorClass && preflight.errorClass !== 'none'
            ? preflight.errorClass
            : fallback);
        }
      }
      const { error, stdout } = await execute(buildDiagnosticCommand());
      if (error) throw new Error('quote_transport_diagnosis_process_error');
      const diagnostic = parseQuoteTransportDiagnosticOutput(stdout);
      if (!diagnostic.passed || diagnostic.symbolsSucceeded !== 3) throw new Error('quote_transport_diagnosis_failed');
      const safetyRun = await execute(buildSafetyMonitorCommand());
      if (safetyRun.error?.killed) throw new Error('timeout');
      if (safetyRun.error && Number(safetyRun.error.code) !== 2) throw new Error('safety_monitor_process_error');
      const safety = parseSafetyMonitorOutput(safetyRun.stdout);
      const vpsDailyLossEntryBlock = safety.status === 'blocked'
        && safety.execution_owner === 'vps'
        && safety.error_class === 'account_risk_status_active'
        && safety.process_lock === 'clear'
        && safety.kill_state === 'clear'
        && safety.open_order_status === 'clear'
        && safety.reconciliation_status === 'clear'
        && safety.account_risk_status === 'active';
      if (safety.status !== 'success' && !vpsDailyLossEntryBlock) throw new Error(safety.error_class || 'safe_block');
      const resumedAt = now();
      const postCloseRefreshPending = current.last_error_notification?.task_id === POST_CLOSE_TASK.id
        && current.last_error_notification?.error_class === sanitizeErrorClass(current.pause_reason)
        && current.tasks[POST_CLOSE_TASK.id]?.last_run?.error_class === current.pause_reason
        && current.tasks[ORDER_TASK.id]?.activation_artifact_hash != null;
      const tasks = Object.fromEntries(TASKS.map((task) => {
        const prior = current.tasks[task.id] || {};
        return [task.id, {
          ...prior,
          state: task.kind === 'order' ? 'DISABLED' : 'ACTIVE',
          pause_reason: undefined,
          next_run_at: task.kind === 'order' ? null : nextRunAt(task, resumedAt),
          ...(task.kind === 'order' && postCloseRefreshPending ? { refresh_only_pending: true } : {}),
          consecutive_transport_failures: 0,
        }];
      }));
      return save({
        ...current,
        state: 'ACTIVE',
        pause_reason: undefined,
        resumed_at: resumedAt.toISOString(),
        resumed_by: safeText(invokedBy),
        resume_reason: 'io_fix_verified',
        retry: false,
        catch_up: false,
        backfill: false,
        scheduler_registered: false,
        server_registered: false,
        tasks,
      });
    } finally { if (release) release(); }
  }
  async function enableOrderTask({
    confirm = false, approval = '', invokedBy = 'hermes_cli', adoptRefresh = false,
  } = {}) {
    if (confirm !== true) throw new Error('order_task_confirmation_required');
    if (approval !== ORDER_ACTIVATION_APPROVAL) throw new Error('exact_order_activation_approval_required');
    let release;
    try {
      release = acquireExclusiveLock(runLockPath);
      const current = loadStrict();
      const prior = current.tasks[ORDER_TASK.id];
      const recoveredPostCloseFailure = current.last_error_notification?.task_id === POST_CLOSE_TASK.id
        && current.last_error_notification?.error_class
          === sanitizeErrorClass(current.tasks[POST_CLOSE_TASK.id]?.last_run?.error_class)
        && current.tasks[POST_CLOSE_TASK.id]?.last_run?.fail_closed === true;
      const refreshAdoption = adoptRefresh === true
        && prior.state === 'ACTIVE'
        && prior.refresh_only_pending === true;
      const canEnable = prior.state === 'DISABLED'
        || (prior.state === 'PAUSED' && ORDER_TASK_RECOVERY_PAUSE_REASONS.has(prior.pause_reason))
        || refreshAdoption;
      if (current.state !== 'ACTIVE' || !canEnable) throw new Error('order_task_must_be_disabled');
      assertLegacyPaused();
      assertNoResumeBlockingLocks();
      if (await runtimeHealthCheck() !== true) throw new Error('runtime_health_unavailable');
      const { error, stdout } = await execute(buildCommand(ORDER_TASK.id, { activationPreflight: true }));
      if (error && Number(error.code) !== 2) throw new Error('order_activation_check_process_error');
      const parsed = parseKisVpsAutonomousOutput(stdout, ORDER_TASK.id, runtimeContract);
      const activationReady = parsed.status === 'success'
        && parsed.failClosed === false
        && parsed.actionType === 'activation_check';
      const disabledAfterRefreshFailure = prior.state === 'DISABLED'
        && POST_CLOSE_REFRESH_RECOVERY_PAUSE_REASONS.has(prior.last_run?.error_class);
      const waitingForPostCloseRefresh = (
        (prior.state === 'PAUSED' && POST_CLOSE_REFRESH_RECOVERY_PAUSE_REASONS.has(prior.pause_reason))
        || (prior.state === 'DISABLED' && prior.refresh_only_pending === true)
        || disabledAfterRefreshFailure
        || (prior.state === 'DISABLED' && recoveredPostCloseFailure)
      )
        && parsed.status === 'blocked'
        && parsed.failClosed === true
        && parsed.errorClass === 'model_v3_prediction_batch_incomplete'
        && parsed.orderApiCalls === 0
        && parsed.vpsLiveOrders === 0
        && parsed.reconciliations === 0
        && parsed.openPositions === 0
        && parsed.dailyEntryCount === 0;
      const refreshOnlyPending = refreshAdoption
        ? !activationReady
        : prior.refresh_only_pending === true || waitingForPostCloseRefresh;
      if (refreshOnlyPending
        && (prior.activation_artifact_hash === null
          || parsed.artifactHash !== prior.activation_artifact_hash)) {
        throw new Error('artifact_recovery_hash_changed');
      }
      if (!activationReady && !waitingForPostCloseRefresh) {
        throw new Error(`order_activation_check_failed:${parsed.errorClass}`);
      }
      if (error && !waitingForPostCloseRefresh) {
        throw new Error('order_activation_check_process_error');
      }
      if (prior.pause_reason === 'model_v3_artifact_attestation_mismatch'
        || prior.pause_reason === 'hermes_scheduler_attestation_unavailable') {
        if (sourceParityCheck() !== true) throw new Error('runtime_source_parity_failed');
      }
      if (prior.pause_reason === 'model_v3_artifact_attestation_mismatch') {
        if (prior.activation_artifact_hash === null
          || parsed.artifactHash !== prior.activation_artifact_hash) {
          throw new Error('artifact_recovery_hash_changed');
        }
      }
      const latest = loadStrict();
      const latestPrior = latest.tasks[ORDER_TASK.id];
      if (latest.state !== current.state
        || latestPrior.state !== prior.state
        || latestPrior.pause_reason !== prior.pause_reason
        || latestPrior.next_run_at !== prior.next_run_at) {
        throw new Error('order_activation_state_changed');
      }
      const activatedAt = now();
      const scheduledAt = refreshOnlyPending
        ? nextRunAt(REFRESH_ONLY_ORDER_TASK, activatedAt)
        : nextRunAt(ORDER_TASK, activatedAt);
      const activationLastRun = refreshOnlyPending
        ? {
            status: 'waiting', action_type: 'activation_waiting_post_close', fail_closed: true,
            error_class: 'model_v3_prediction_batch_incomplete', order_api_calls: 0,
            vps_live_orders: 0, open_positions: 0,
            invoked_by: safeText(invokedBy), completed_at: activatedAt.toISOString(),
          }
        : {
            status: 'success', action_type: 'activation_check', fail_closed: false,
            invoked_by: safeText(invokedBy), completed_at: activatedAt.toISOString(),
          };
      return save({
        ...latest,
        order_pause_reason: undefined,
        order_activated_at: activatedAt.toISOString(),
        order_activated_by: safeText(invokedBy),
        tasks: {
          ...latest.tasks,
          [ORDER_TASK.id]: {
            ...latestPrior,
            state: 'ACTIVE',
            pause_reason: undefined,
            schedule: ORDER_TASK.schedule,
            next_run_at: scheduledAt,
            refresh_only_pending: refreshOnlyPending,
            activation_artifact_hash: parsed.artifactHash,
            pending_invocation: null,
            last_run: activationLastRun,
          },
        },
      });
    } finally { if (release) release(); }
  }
  function approveAggressiveDailyEntryCap() {
    throw new Error('daily_entry_cap_managed_by_runtime_contract');
  }
  async function cutoverIntradayProvider({ confirm = false, approval = '', invokedBy = 'hermes_cli' } = {}) {
    if (confirm !== true) throw new Error('provider_cutover_confirmation_required');
    if (approval !== INTRADAY_PROVIDER_CUTOVER_APPROVAL) {
      throw new Error('exact_provider_cutover_approval_required');
    }
    let release;
    try {
      release = acquireExclusiveLock(runLockPath);
      const current = loadStrict();
      const prior = current.tasks[ORDER_TASK.id];
      if (current.state !== 'ACTIVE' || prior.state !== 'ACTIVE') {
        throw new Error('active_order_task_required');
      }
      if (prior.refresh_only_pending === true) throw new Error('post_close_refresh_pending');
      if (prior.pending_invocation !== null) throw new Error('order_invocation_pending');
      assertLegacyPaused();
      assertNoResumeBlockingLocks();
      if (await runtimeHealthCheck() !== true) throw new Error('runtime_health_unavailable');
      if (sourceParityCheck() !== true) throw new Error('runtime_source_parity_failed');
      const { error, stdout } = await execute(buildCommand(ORDER_TASK.id, { activationPreflight: true }));
      if (error) throw new Error('provider_cutover_preflight_process_error');
      const parsed = parseKisVpsAutonomousOutput(stdout, ORDER_TASK.id, runtimeContract);
      if (parsed.status !== 'success' || parsed.failClosed || parsed.actionType !== 'activation_check') {
        throw new Error(`provider_cutover_preflight_failed:${parsed.errorClass}`);
      }
      if (prior.activation_artifact_hash !== null
        && parsed.artifactHash !== prior.activation_artifact_hash) {
        throw new Error('provider_cutover_artifact_mismatch');
      }
      const latest = loadStrict();
      const latestOrder = latest.tasks[ORDER_TASK.id];
      if (latest.state !== current.state
        || latestOrder.state !== prior.state
        || latestOrder.pending_invocation !== null
        || latestOrder.next_run_at !== prior.next_run_at) {
        throw new Error('provider_cutover_state_changed');
      }
      const cutoverAt = now();
      const tasks = Object.fromEntries(TASKS.map((task) => {
        const item = latest.tasks[task.id];
        return [task.id, {
          ...item,
          schedule: task.schedule,
          next_run_at: item.state === 'ACTIVE' ? nextRunAt(task, cutoverAt) : null,
          ...(task.kind === 'order' ? {
            activation_artifact_hash: parsed.artifactHash,
            daily_entry_cap: INTRADAY_PROVIDER_ATTESTATION.daily_entry_cap,
            daily_entry_cap_approval_hash: null,
            ...INTRADAY_PROVIDER_ATTESTATION,
          } : {}),
        }];
      }));
      return save({
        ...latest,
        provider_cutover_at: cutoverAt.toISOString(),
        provider_cutover_by: safeText(invokedBy),
        tasks,
      });
    } finally { if (release) release(); }
  }
  function withRegistration(current) {
    if (current.state !== 'ACTIVE') return current;
    return { ...current, scheduler_registered: Boolean(timer) && schedulerRegistered, server_registered: Boolean(timer) && schedulerRegistered && serverRegistered };
  }
  async function runOnce({ taskId, invokedBy = 'hermes_scheduler', dueAt = now() } = {}) {
    if (!TASK_BY_ID.has(taskId)) throw new Error('unknown_task_id');
    if (enforceSchedulerOwnership && typeof releaseSchedulerOwnership !== 'function') {
      throw new Error('scheduler_owner_required');
    }
    const task = TASK_BY_ID.get(taskId);
    let current;
    try { current = loadStrict(); }
    catch {
      schedulerFaulted = true;
      await queueStateFaultNotification();
      return stateUnavailableStatus();
    }
    let taskState = current.tasks[taskId];
    if (current.state !== 'ACTIVE' || taskState.state !== 'ACTIVE') return current;
    const pauseForTask = async (state, reason, lastRun, options) => {
      try {
        return await notifyPause(
          task.kind === 'order' ? pauseOrder(state, reason, lastRun) : pauseAll(state, taskId, reason, lastRun),
          taskId,
          reason,
          lastRun,
          options,
        );
      } catch {
        schedulerFaulted = true;
        await queueStateFaultNotification();
        return stateUnavailableStatus();
      }
    };
    const handleTransientFailure = async (state, reason, lastRun) => {
      const latestTask = state.tasks[taskId];
      const consecutive = Number(latestTask.consecutive_transport_failures || 0) + 1;
      lastRun.consecutive_transport_failures = consecutive;
      if (consecutive >= 2) return pauseForTask(state, reason, lastRun);
      return save({ ...state, tasks: { ...state.tasks, [taskId]: {
        ...latestTask,
        state: 'ACTIVE',
        pause_reason: undefined,
        consecutive_transport_failures: consecutive,
        last_run: lastRun,
        ...(task.kind === 'order' ? { pending_invocation: null } : {}),
      } } });
    };
    const dueTime = dueAt instanceof Date ? dueAt : new Date(dueAt);
    if (Number.isNaN(dueTime.getTime())) return pauseForTask(current, 'due_time_invalid', { error_class: 'due_time_invalid', fail_closed: true });
    if (!isDue(task, dueTime) || !sameMinute(taskState.next_run_at, dueTime)) {
      const scheduled = new Date(taskState.next_run_at || 0);
      if (scheduled.getTime() < dueTime.getTime()) {
        const scheduleTask = task.kind === 'order' && taskState.refresh_only_pending
          ? REFRESH_ONLY_ORDER_TASK : task;
        return save({ ...current, tasks: { ...current.tasks, [taskId]: { ...taskState, next_run_at: nextRunAt(scheduleTask, dueTime), last_run: { status: taskState.refresh_only_pending ? 'waiting' : 'no_op', action_type: taskState.refresh_only_pending ? 'missed_refresh_window_no_op' : 'missed_window_no_op', error_class: taskState.refresh_only_pending ? 'model_v3_prediction_batch_incomplete' : 'none', fail_closed: taskState.refresh_only_pending === true, catch_up: false, invoked_by: safeText(invokedBy), completed_at: now().toISOString() } } } });
      }
      return current;
    }
    let release;
    const startedAt = now().toISOString();
    try {
      release = acquireExclusiveLock(runLockPath);
      assertLegacyPaused();
    } catch (error) {
      if (release) release();
      const errorClass = sanitizeErrorClass(error.message);
      return pauseForTask(loadStrict(), errorClass, {
        invoked_by: safeText(invokedBy),
        started_at: startedAt,
        completed_at: now().toISOString(),
        error_class: errorClass,
        fail_closed: true,
      });
    }
    current = loadStrict();
    taskState = current.tasks[taskId];
    if (current.state !== 'ACTIVE' || taskState.state !== 'ACTIVE'
      || !sameMinute(taskState.next_run_at, dueTime)) return current;
    const key = dueKey(task, dueTime);
    const postCloseRefresh = isPostCloseRefreshSlot(task, dueTime);
    const requiresAiVerdict = task.kind === 'order' && !isDeterministicRiskOffSlot(task, dueTime) && !postCloseRefresh;
    let schedulerToken = task.kind === 'order' ? crypto.randomBytes(16).toString('hex') : '';
    let pendingInvocation = task.kind === 'order' ? {
      due_key: key,
      token_hash: crypto.createHash('sha256').update(schedulerToken).digest('hex'),
      expires_at: new Date(now().getTime() + (5 * 60_000)).toISOString(),
      ...INTRADAY_PROVIDER_ATTESTATION,
      daily_entry_cap: taskState.daily_entry_cap,
      daily_entry_cap_approval_hash: taskState.daily_entry_cap_approval_hash,
    } : null;
    let attestationPath = null;
    let verdictPath = null;
    let promptHash = '';
    let decisionContextCandidateCount = 0;
    let llmInvoked = false;
    let llmVerdictStatus = requiresAiVerdict ? 'pending' : 'not_required';
    try {
      const scheduleTask = task.kind === 'order' && taskState.refresh_only_pending
        ? REFRESH_ONLY_ORDER_TASK : task;
      save({ ...current, tasks: { ...current.tasks, [taskId]: {
        ...taskState, last_due_at: key, next_run_at: nextRunAt(scheduleTask, dueTime), pending_invocation: pendingInvocation,
      } } });
      if (task.kind === 'order') {
        attestationPath = attestationFileForDueKey(key, orderAttestationDir);
        atomicWrite(attestationPath, pendingInvocation);
      }
      if (requiresAiVerdict) {
        try {
          const verdict = await createAiVerdictFile(taskId, key, dueTime, schedulerToken);
          verdictPath = verdict?.path || null;
          promptHash = verdict?.promptHash || '';
          decisionContextCandidateCount = verdict?.candidateCount || 0;
          llmInvoked = verdict?.llmInvoked === true;
          llmVerdictStatus = verdict?.verdictStatus || 'invalid';

          const contextState = loadStrict();
          const contextTask = contextState.tasks[taskId];
          if (contextState.state !== 'ACTIVE' || contextTask.state !== 'ACTIVE'
            || contextTask.last_due_at !== key
            || JSON.stringify(contextTask.pending_invocation) !== JSON.stringify(pendingInvocation)
            || contextTask.activation_artifact_hash !== taskState.activation_artifact_hash
            || contextTask.daily_entry_cap_approval_hash !== taskState.daily_entry_cap_approval_hash
            || Object.keys(INTRADAY_PROVIDER_ATTESTATION)
              .some((keyName) => contextTask[keyName] !== taskState[keyName])) {
            throw new Error('scheduler_attestation_state_changed');
          }
          schedulerToken = crypto.randomBytes(16).toString('hex');
          pendingInvocation = {
            ...pendingInvocation,
            token_hash: crypto.createHash('sha256').update(schedulerToken).digest('hex'),
            expires_at: new Date(now().getTime() + (5 * 60_000)).toISOString(),
          };
          save({ ...contextState, tasks: { ...contextState.tasks, [taskId]: {
            ...contextTask, pending_invocation: pendingInvocation,
          } } });
          atomicWrite(attestationPath, pendingInvocation);
        }
        catch (error) {
          const reason = safeText(error.message, 80);
          const lastRun = {
            invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
            status: 'no_op', action_type: 'transport_degraded_no_op',
            error_class: reason, fail_closed: true, retry: false,
          };
          if (ERROR_POLICY[reason]?.slotDegradeOnly === true) {
            const latest = loadStrict();
            const latestTask = latest.tasks[taskId];
            return save({ ...latest, tasks: { ...latest.tasks, [taskId]: {
              ...latestTask,
              state: 'ACTIVE',
              pause_reason: undefined,
              consecutive_transport_failures: 0,
              pending_invocation: null,
              last_run: { ...lastRun, fail_closed: false, no_same_slot_retry: true },
            } } });
          }
          if (TRANSIENT_TRANSPORT_ERRORS.has(reason)) return handleTransientFailure(loadStrict(), reason, lastRun);
          return pauseForTask(loadStrict(), reason, lastRun);
        }
      }
      let weeklyUniverse = null;
      let independentShadowRefresh = null;
      if (isWeeklyUniverseRefreshDue(task, dueTime)) {
        const weekly = await execute(buildWeeklyUniverseCommand());
        if (weekly.error && Number(weekly.error.code) !== 2) {
          weeklyUniverse = {
            status: 'blocked', actionType: 'weekly_universe_refresh', isoWeek: 'unknown',
            selectedCount: 0, exitOnlyCount: 0, apiCalls: 0, officialDownloads: 0,
            dbWritten: false, failClosed: true,
            errorClass: weekly.error.killed ? 'weekly_universe_timeout' : 'weekly_universe_process_error',
          };
        } else {
          try {
            weeklyUniverse = parseWeeklyUniverseOutput(weekly.stdout);
          } catch (weeklyParseError) {
            return pauseForTask(loadStrict(), safeText(weeklyParseError.message, 80), {
              invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
              error_class: safeText(weeklyParseError.message, 80), fail_closed: true,
            });
          }
        }
      }
      const command = buildCommand(taskId, { schedulerToken, dueKey: key, verdictPath, promptHash });
      const { error, stdout, stderr } = await execute(command);
      if (error && Number(error.code) !== 2) {
        const errorClass = error.killed ? 'timeout' : 'process_error';
        return pauseForTask(loadStrict(), errorClass, {
          invoked_by: safeText(invokedBy),
          started_at: startedAt,
          completed_at: now().toISOString(),
          error_class: errorClass,
          fail_closed: true,
          ...processFailureEvidence(error, stderr),
        });
      }
      let parsed;
      try {
        parsed = task.kind === 'order'
          ? parseKisVpsAutonomousOutput(stdout, taskId, runtimeContract)
          : parseKisAiMarketOpenOutput(stdout, taskId, calendarProofResolver, runtimeContract);
      } catch (parseError) {
        const errorClass = safeText(parseError.message, 80);
        return pauseForTask(loadStrict(), errorClass, { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), error_class: errorClass, fail_closed: true });
      }
      if (task.id === POST_CLOSE_TASK.id && current.tasks[ORDER_TASK.id]?.state !== 'ACTIVE') {
        const refresh = await execute(buildIndependentShadowRefreshCommand());
        if (refresh.error && Number(refresh.error.code) !== 2) {
          independentShadowRefresh = {
            status: 'blocked', actionType: 'paused', predictionsInserted: 0,
            duplicatesSkipped: 0, failClosed: true,
            errorClass: refresh.error.killed ? 'post_close_shadow_timeout' : 'post_close_shadow_process_error',
          };
        } else {
          try {
            const refreshResult = parseKisVpsAutonomousOutput(refresh.stdout, ORDER_TASK.id, runtimeContract);
            if (refreshResult.status !== 'blocked'
              && (!['shadow_refreshed', 'market_closed_no_op'].includes(refreshResult.actionType)
              || refreshResult.artifactPromoted
              || refreshResult.orderApiCalls !== 0
              || refreshResult.vpsLiveOrders !== 0
              || refreshResult.reconciliations !== 0)) {
              throw new Error('invalid_independent_shadow_refresh');
            }
            independentShadowRefresh = {
              status: refreshResult.status,
              actionType: refreshResult.actionType,
              predictionsInserted: refreshResult.shadowPredictionsInserted,
              duplicatesSkipped: refreshResult.shadowDuplicatesSkipped,
              failClosed: refreshResult.failClosed,
              errorClass: refreshResult.errorClass,
              artifactHash: refreshResult.artifactHash,
            };
          } catch (refreshParseError) {
            independentShadowRefresh = {
              status: 'blocked', actionType: 'paused', predictionsInserted: 0,
              duplicatesSkipped: 0, failClosed: true,
              errorClass: safeText(refreshParseError.message, 80),
            };
          }
        }
      }
      const slot = seoulParts(dueTime);
      const horizonExitOrderSlot = task.kind === 'order'
        && Number(slot.hour) === 14
        && Number(slot.minute) >= 40
        && Number(slot.minute) <= 42;
      const entryCutoffReached = task.kind === 'order'
        && (Number(slot.hour) > 14 || (Number(slot.hour) === 14 && Number(slot.minute) >= 30));
      if (entryCutoffReached && parsed.actionType === 'entry_reconciled') {
        return pauseForTask(loadStrict(), 'entry_after_cutoff_blocked', {
          invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
          error_class: 'entry_after_cutoff_blocked', fail_closed: true,
        });
      }
      if (task.kind === 'order' && parsed.artifactPromoted) {
        const reason = postCloseRefresh
          ? 'model_v3_post_close_promotion_forbidden'
          : 'model_v3_promotion_outside_post_close_slot';
        return pauseForTask(loadStrict(), reason, {
          invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
          error_class: reason, fail_closed: true,
        });
      }
      const postCloseMarketClosedNoOp = postCloseRefresh
        && parsed.actionType === 'market_closed_no_op';
      if (task.kind === 'order' && !parsed.failClosed) {
        const safeNoPositionHorizonNoOp = ['no_candidate_no_op', 'entry_window_closed_no_op']
          .includes(parsed.actionType)
          && parsed.openPositions === 0
          && parsed.orderApiCalls === 0
          && parsed.vpsLiveOrders === 0
          && parsed.reconciliations === 0;
        const actionAllowed = postCloseRefresh
          ? ['shadow_refreshed', 'market_closed_no_op'].includes(parsed.actionType)
          : horizonExitOrderSlot
          ? ['horizon_exit_reconciled', 'market_closed_no_op', 'position_held'].includes(parsed.actionType)
            || safeNoPositionHorizonNoOp
          : !['shadow_refreshed', 'horizon_exit_reconciled'].includes(parsed.actionType);
        if (!actionAllowed) {
          return pauseForTask(loadStrict(), 'order_action_not_allowed_for_schedule_slot', {
            invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
            error_class: 'order_action_not_allowed_for_schedule_slot', fail_closed: true,
          });
        }
      }
      const latest = loadStrict(); const latestTask = latest.tasks[taskId];
      const blockedBeforeArtifactLoad = task.kind === 'order'
        && parsed.status === 'blocked' && parsed.artifactHash === null
        && parsed.previousArtifactHash === null && parsed.artifactPromoted === false;
      const artifactAttestationValid = task.kind !== 'order' || blockedBeforeArtifactLoad
        || (postCloseRefresh
          ? parsed.artifactPromoted === false
            && parsed.artifactHash === latestTask.activation_artifact_hash
            && (postCloseMarketClosedNoOp
              ? parsed.previousArtifactHash === null && parsed.shadowPredictionsInserted === 0
              : parsed.previousArtifactHash === latestTask.activation_artifact_hash)
          : parsed.artifactHash === latestTask.activation_artifact_hash);
      if (!artifactAttestationValid) {
        return pauseForTask(latest, 'model_v3_artifact_attestation_mismatch', {
          invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
          error_class: 'model_v3_artifact_attestation_mismatch', fail_closed: true,
        });
      }
      let lastRun = { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), status: parsed.status, fail_closed: parsed.failClosed, official_trade_date: parsed.officialTradeDate, action_type: parsed.actionType, error_class: parsed.errorClass };
      if (weeklyUniverse) {
        Object.assign(lastRun, {
          weekly_universe_status: weeklyUniverse.status,
          weekly_universe_action_type: weeklyUniverse.actionType,
          weekly_universe_iso_week: weeklyUniverse.isoWeek,
          weekly_universe_selected_count: weeklyUniverse.selectedCount,
          weekly_universe_exit_only_count: weeklyUniverse.exitOnlyCount,
          weekly_universe_api_calls: weeklyUniverse.apiCalls,
          weekly_universe_official_downloads: weeklyUniverse.officialDownloads,
          weekly_universe_db_written: weeklyUniverse.dbWritten,
          weekly_universe_fail_closed: weeklyUniverse.failClosed,
          weekly_universe_error_class: weeklyUniverse.errorClass,
        });
      }
      if (independentShadowRefresh) {
        Object.assign(lastRun, {
          model_v3_candidate_refresh_status: independentShadowRefresh.status,
          model_v3_candidate_refresh_action_type: independentShadowRefresh.actionType,
          model_v3_candidate_predictions_inserted: independentShadowRefresh.predictionsInserted,
          model_v3_candidate_duplicates_skipped: independentShadowRefresh.duplicatesSkipped,
          model_v3_candidate_refresh_fail_closed: independentShadowRefresh.failClosed,
          model_v3_candidate_refresh_error_class: independentShadowRefresh.errorClass,
          model_v3_candidate_artifact_hash: independentShadowRefresh.artifactHash || null,
        });
        if (independentShadowRefresh.failClosed) {
          return pauseForTask(
            latest,
            independentShadowRefresh.errorClass || 'post_close_shadow_failed',
            lastRun,
          );
        }
      }
      if (task.kind === 'order') {
        Object.assign(lastRun, {
          order_api_calls: parsed.orderApiCalls,
          vps_live_orders: parsed.vpsLiveOrders,
          reconciliations: parsed.reconciliations,
          open_positions: parsed.openPositions,
          daily_entry_count: parsed.dailyEntryCount,
          shadow_predictions_inserted: parsed.shadowPredictionsInserted,
          artifact_promoted: parsed.artifactPromoted,
          previous_artifact_hash: parsed.previousArtifactHash,
          artifact_hash: parsed.artifactHash,
          decision_context_candidate_count: decisionContextCandidateCount,
          llm_invoked: llmInvoked,
          llm_verdict_status: llmVerdictStatus,
        });
        const lifecycleDelivery = await notifyOrderLifecycle(latest, parsed, lastRun);
        lastRun = lifecycleDelivery.lastRun;
      } else {
        Object.assign(lastRun, {
          failure_phase: parsed.failurePhase,
          failure_symbol: parsed.failureSymbol,
          failure_exception_type: parsed.failureExceptionType,
          failure_errno: parsed.failureErrno,
          failure_attempt_number: parsed.failureAttemptNumber,
        });
      }
      const postNotificationState = task.kind === 'order' ? loadStrict() : latest;
      if (parsed.status === 'blocked' || parsed.failClosed || error) return pauseForTask(postNotificationState, parsed.errorClass || 'blocked', lastRun);
      if (task.kind === 'order') {
        const postNotificationTask = postNotificationState.tasks[taskId];
        const refreshCompleted = postCloseRefresh && parsed.actionType === 'shadow_refreshed';
        const refreshOnlyPending = postNotificationTask.refresh_only_pending === true && !refreshCompleted;
        return save({ ...postNotificationState, tasks: { ...postNotificationState.tasks, [taskId]: {
          ...postNotificationTask,
          state: 'ACTIVE',
          pause_reason: undefined,
          consecutive_transport_failures: 0,
          pending_invocation: null,
          refresh_only_pending: refreshOnlyPending,
          next_run_at: postNotificationTask.refresh_only_pending === true
            ? nextRunAt(refreshOnlyPending ? REFRESH_ONLY_ORDER_TASK : task, dueTime)
            : postNotificationTask.next_run_at,
          activation_artifact_hash: postNotificationTask.activation_artifact_hash,
          last_run: lastRun,
        } } });
      }
      if (parsed.transportDegraded) {
        return handleTransientFailure(latest, parsed.errorClass, lastRun);
      }
      if (parsed.status === 'report_ready') {
        if (typeof reportSender !== 'function') return pauseForTask(latest, 'report_sender_missing', { ...lastRun, delivery_attempted: false }, { sendAllowed: false });
        let delivery;
        try { delivery = await reportSender({ targetChannelId: REPORT_TARGET_CHANNEL_ID, content: parsed.reportMessage, deliveryLayer: 'hermes_ai_market_open_dry_run' }); }
        catch { return pauseForTask(loadStrict(), 'report_delivery_failed', { ...lastRun, delivery_attempted: true, delivery_succeeded: false }, { sendAllowed: false }); }
        if (delivery?.discord_sent !== true) return pauseForTask(loadStrict(), sanitizeErrorClass(delivery?.error_class || 'report_delivery_failed'), { ...lastRun, delivery_attempted: true, delivery_succeeded: false }, { sendAllowed: false });
        lastRun.status = 'report_sent'; lastRun.delivery_attempted = true; lastRun.delivery_succeeded = true;
      }
      return save({ ...latest, tasks: { ...latest.tasks, [taskId]: { ...latestTask, state: 'ACTIVE', pause_reason: undefined, consecutive_transport_failures: 0, last_run: lastRun } } });
    } finally {
      if (attestationPath) {
        try { fs.unlinkSync(attestationPath); } catch (error) { if (error.code !== 'ENOENT') schedulerFaulted = true; }
      }
      if (verdictPath) {
        try { fs.unlinkSync(verdictPath); } catch (error) { if (error.code !== 'ENOENT') schedulerFaulted = true; }
      }
      if (release) release();
    }
  }
  async function runSafetyMonitor(current, checkedAt) {
    const last = current.last_safety_monitor;
    if (!safetyMonitorEnabled || sameMinute(last?.checked_at, checkedAt)) return current;
    const monitorRun = { checked_at: checkedAt.toISOString(), action_type: 'safety_monitor', retry: false, catch_up: false };
    let result;
    try {
      const { error, stdout, stderr } = await execute(buildSafetyMonitorCommand());
      if (error && Number(error.code) !== 2) {
        Object.assign(monitorRun, processFailureEvidence(error, stderr));
        throw new Error(error.killed ? 'timeout' : 'process_error');
      }
      result = parseSafetyMonitorOutput(stdout);
      if (error && result.status !== 'blocked') throw new Error('process_error');
      Object.assign(monitorRun, {
        status: result.status,
        execution_owner: result.execution_owner,
        process_lock: result.process_lock,
        kill_state: result.kill_state,
        open_order_status: result.open_order_status,
        reconciliation_status: result.reconciliation_status,
        account_risk_status: result.account_risk_status,
        error_class: safeText(result.error_class, 80),
      });
      if (result.status === 'blocked') {
        const emergencyRequired = new Set(['mdd_liquidation_required', 'kill_switch_liquidation_required']);
        if (emergencyRequired.has(result.error_class)) {
          if (typeof emergencyStopExecutor !== 'function') throw new Error('emergency_stop_executor_missing');
          const emergency = await emergencyStopExecutor({ automaticRiskOff: true });
          Object.assign(monitorRun, {
            emergency_stop_attempted: true,
            emergency_stop_status: safeText(emergency?.status || 'blocked', 32),
            emergency_execution_owner: safeText(emergency?.execution_owner || 'unknown', 16),
            emergency_positions_liquidated: Number(emergency?.positions_liquidated || 0),
            emergency_reconciliation_passed: emergency?.reconciliation_passed === true,
          });
          if (emergency?.status !== 'success' || emergency?.reconciliation_passed !== true) {
            throw new Error(`emergency_${sanitizeErrorClass(emergency?.error_class || 'stop_failed')}`);
          }
        }
        throw new Error(result.error_class || 'safe_block');
      }
    } catch (error) {
      const reason = sanitizeErrorClass(error.message);
      const consecutiveFailures = Number(current.consecutive_safety_monitor_failures || 0) + 1;
      const consecutiveOpenOrderFailures = reason === 'open_order_status_unavailable'
        && (consecutiveFailures === 1
          || current.last_safety_monitor?.error_class === 'open_order_status_unavailable');
      if (TRANSIENT_TRANSPORT_ERRORS.has(reason)) {
        return save({
          ...current,
          consecutive_safety_monitor_failures: consecutiveFailures,
          last_safety_monitor: {
            ...monitorRun,
            status: 'blocked',
            fail_closed: true,
            error_class: reason,
          },
        });
      }
      const failureLimit = consecutiveOpenOrderFailures
        ? OPEN_ORDER_STATUS_FAILURE_LIMIT
        : 2;
      const awaitingConfirmation = TRANSIENT_SAFETY_MONITOR_ERRORS.has(reason)
        && consecutiveFailures < failureLimit;
      if (awaitingConfirmation) {
        return save({
          ...current,
          consecutive_safety_monitor_failures: consecutiveFailures,
          last_safety_monitor: {
            ...monitorRun,
            status: 'blocked',
            fail_closed: true,
            error_class: reason,
          },
        });
      }
      const paused = pauseAll(
        { ...current, consecutive_safety_monitor_failures: consecutiveFailures },
        TASKS[0].id,
        reason,
        { ...monitorRun, status: 'blocked', fail_closed: true, error_class: reason },
      );
      return notifyPause(paused, TASKS[0].id, reason, paused.tasks[TASKS[0].id].last_run);
    }
    return save({ ...current, consecutive_safety_monitor_failures: 0, last_safety_monitor: monitorRun });
  }
  async function tick() {
    if (enforceSchedulerOwnership && typeof releaseSchedulerOwnership !== 'function') {
      throw new Error('scheduler_owner_required');
    }
    if (ticking || schedulerFaulted) return status();
    ticking = true;
    try {
      let current = withRegistration(loadStrict());
      if (JSON.stringify(current) !== JSON.stringify(loadStrict())) current = save(current);
      const time = now();
      if (current.state === 'PAUSED' && AUTO_RESUME_AFTER_CLEAR_SAFETY.has(current.pause_reason)) {
        current = await runSafetyMonitor(current, time);
        if (current.last_safety_monitor?.status !== 'success') return current;
        const orderWasActivated = Boolean(current.order_activated_at);
        const tasks = Object.fromEntries(TASKS.map((task) => [task.id, {
          ...current.tasks[task.id],
          state: task.kind === 'order' && !orderWasActivated ? 'DISABLED' : 'ACTIVE',
          pause_reason: undefined,
          next_run_at: task.kind === 'order' && !orderWasActivated ? null : nextRunAt(task, time),
          consecutive_transport_failures: 0,
        }]));
        current = save({
          ...current,
          state: 'ACTIVE',
          tasks,
          pause_reason: undefined,
          consecutive_safety_monitor_failures: 0,
          resumed_at: time.toISOString(),
          resumed_by: 'hermes_safety_monitor',
          resume_reason: 'safety_monitor_auto_recovered',
          retry: false,
          catch_up: false,
          backfill: false,
        });
      }
      if (current.state === 'ACTIVE') {
        current = await runSafetyMonitor(current, time);
        if (current.state !== 'ACTIVE') return current;
        if (safetyMonitorEnabled && current.last_safety_monitor?.status !== 'success') return current;
        for (const task of TASKS) {
          const item = current.tasks[task.id];
          if (item?.state === 'ACTIVE' && item.next_run_at && new Date(item.next_run_at).getTime() <= time.getTime()) {
            current = await runOnce({ taskId: task.id, dueAt: time });
            if (current.state !== 'ACTIVE') break;
          }
        }
      }
      return current;
    } catch (error) {
      schedulerFaulted = true;
      if (timer) clearTimer(timer); timer = null;
      await queueStateFaultNotification();
      return stateUnavailableStatus();
    } finally { ticking = false; }
  }
  function schedule() {
    if (!timer || schedulerFaulted) return;
    const remainder = now().getTime() % POLL_INTERVAL_MS;
    const delay = remainder === 0 ? POLL_INTERVAL_MS : POLL_INTERVAL_MS - remainder;
    timer = setTimer(() => {
      if (!schedulerFaulted) schedule();
      tick().catch(() => {});
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function start() {
    if (!timer && !schedulerFaulted) {
      releaseSchedulerOwnership = acquireSchedulerOwnershipLock(schedulerOwnerLockPath);
      timer = {};
      save(withRegistration(loadStrict()));
      schedule();
    }
    return status();
  }
  function stop() {
    if (timer) clearTimer(timer); timer = null;
    if (releaseSchedulerOwnership) {
      releaseSchedulerOwnership();
      releaseSchedulerOwnership = null;
    }
    const current = loadStrict(); return save({ ...current, scheduler_registered: false, server_registered: false });
  }
  return {
    statePath, status, prepareDisabled, activate, resumeAfterIoFix, enableOrderTask,
    approveAggressiveDailyEntryCap, cutoverIntradayProvider, runOnce, start, stop, tick, buildCommand,
  };
}

function attestationFileForDueKey(value, directory = ORDER_ATTESTATION_DIR) {
  return path.join(directory, `${crypto.createHash('sha256').update(value).digest('hex')}.json`);
}

async function cli(argv = process.argv.slice(2)) {
  const task = createKisAiMarketOpenDryRunTask(); const action = argv[0] || 'status';
  const approvalIndex = argv.indexOf('--approval');
  const approval = approvalIndex >= 0 ? argv[approvalIndex + 1] : '';
  const result = action === 'prepare-disabled' ? task.prepareDisabled()
    : action === 'activate' ? await task.activate({ approval: argv[2], invokedBy: 'hermes_cli' })
    : action === 'resume-after-io-fix' ? await task.resumeAfterIoFix({ approval: argv[2], invokedBy: 'hermes_cli' })
    : action === 'enable-order' ? await task.enableOrderTask(parseEnableOrderArgs(argv))
    : action === 'cutover-intraday-provider' ? await task.cutoverIntradayProvider({ confirm: argv.includes('--confirm'), approval, invokedBy: 'hermes_cli' })
    : action === 'approve-daily-entry-cap-five' ? task.approveAggressiveDailyEntryCap({ confirm: argv.includes('--confirm'), approval, invokedBy: 'hermes_cli' })
    : action === 'status' ? task.status()
    : action === 'start' ? task.start()
    : action === 'stop' ? task.stop()
    : action === 'tick' || action === 'run-once' ? (() => { throw new Error('scheduler_owner_required'); })()
    : (() => { throw new Error('unknown_action'); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseEnableOrderArgs(argv) {
  const approvalIndex = argv.indexOf('--approval');
  return {
    confirm: argv.includes('--confirm'),
    approval: approvalIndex >= 0 ? argv[approvalIndex + 1] : '',
    invokedBy: 'hermes_cli',
    adoptRefresh: argv.includes('--adopt-refresh'),
  };
}
if (require.main === module) cli().catch((error) => { process.stderr.write(`${safeText(error.message, 100)}\n`); process.exitCode = 1; });

module.exports = {
  CANONICAL_TASK_ID,
  TASK_OWNER,
  ACTIVATION_APPROVAL, RESUME_AFTER_IO_FIX_APPROVAL, ORDER_ACTIVATION_APPROVAL, INTRADAY_PROVIDER_CUTOVER_APPROVAL,
  DAILY_ENTRY_CAP_5_APPROVAL, DAILY_ENTRY_CAP_5_APPROVAL_HASH,
  INTRADAY_PROVIDER_ID, INTRADAY_FEATURE_VERSION, INTRADAY_POLICY_VERSION, INTRADAY_PROVIDER_ATTESTATION,
  KIS_REPO, KIS_VENV_PYTHON, VPS_DB_PATH, STRATEGY_MANIFEST, DEFAULT_STATE_PATH, DEFAULT_CALENDAR_SNAPSHOT_PATH,
  ORDER_ATTESTATION_DIR,
  APPROVED_SOURCE_TASK_PATH,
  LEGACY_V1_STATE_PATH, LEGACY_V2_STATE_PATH, DEFAULT_RUN_LOCK_PATH, DEFAULT_SCHEDULER_OWNER_LOCK_PATH, REPORT_TARGET_CHANNEL_ID,
  TIMEZONE, POLL_INTERVAL_MS, EXEC_TIMEOUT_MS, MAX_BUFFER_BYTES, LLM_RESPONSE_TIMEOUT_MS, LLM_MODEL_ID, MAX_AI_CANDIDATES,
  REQUIRED_RUNTIME_CONTRACT, ERROR_POLICY, loadRuntimeContract, TASKS,
  parseKisAiMarketOpenOutput, parseKisVpsAutonomousOutput, parseQuoteTransportDiagnosticOutput, loadOfficialCalendarProof,
  parseAiVerdict, parseDecisionContextOutput, parseSafetyMonitorOutput, buildSanitizedAiPacket,
  parseCutoverOutput, isPostCloseRefreshSlot,
  buildOrderLifecycleMessage, sanitizeErrorClass,
  nextRunAt, isWeeklyUniverseRefreshDue, buildCommand, buildDecisionContextCommand, buildDiagnosticCommand,
  buildSafetyMonitorCommand, buildReconciliationRecoveryCommand,
  buildWeeklyUniverseCommand, buildIndependentShadowRefreshCommand,
  parseWeeklyUniverseOutput,
  parseEnableOrderArgs,
  defaultSourceParityCheck, acquireExclusiveLock, acquireSchedulerOwnershipLock,
  createKisAiMarketOpenDryRunTask,
};
