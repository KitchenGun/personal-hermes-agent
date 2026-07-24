'use strict';

const { execFile: defaultExecFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ACTIVATION_APPROVAL = 'APPROVE_KIS_HERMES_AI_MARKET_OPEN_DRY_RUN_V1';
const RESUME_AFTER_IO_FIX_APPROVAL = 'APPROVE_KIS_HERMES_AI_DRY_RUN_RESUME_AFTER_IO_FIX_V1';
const ORDER_ACTIVATION_APPROVAL = 'APPROVE_KIS_HERMES_VPS_AUTONOMOUS_PILOT_V1';
const DAILY_ENTRY_CAP_5_APPROVAL = 'APPROVE_KIS_VPS_MOCK_DAILY_ENTRY_CAP_5_V1';
const DAILY_ENTRY_CAP_5_APPROVAL_HASH = crypto.createHash('sha256').update(DAILY_ENTRY_CAP_5_APPROVAL).digest('hex');
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
const TIMEZONE = 'Asia/Seoul';
const CANONICAL_TASK_ID = 'kis-ai-market-open-dry-run-v1';
const TASK_OWNER = 'hermes';
const WATCHLIST_SYMBOLS = Object.freeze(['005930', '000660', '005380']);
const TRANSIENT_TRANSPORT_ERRORS = new Set([
  'dns_failed', 'connection_failed', 'connection_reset', 'timeout',
  'http_transport_failed', 'response_read_failed',
]);
const RESUMABLE_PAUSE_REASONS = new Set(['runtime_io_failed', ...TRANSIENT_TRANSPORT_ERRORS]);
const ORDER_TASK_RECOVERY_PAUSE_REASONS = new Set([
  'balance_mismatch',
  'order_not_fully_filled',
  'order_submission_unknown',
]);
const FAILURE_PHASES = new Set([
  'none', 'strategy_manifest_read', 'calendar_read', 'kill_switch_read', 'lock_acquire',
  'database_open', 'database_commit', 'client_initialize', 'auth_token_request',
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
  { id: 'kis-ai-intraday-shadow-validation-v1', kind: 'dry_run', schedule: 'weekdays 09:10-14:50 KST every 10m', minutes: Array.from({ length: 35 }, (_, i) => 550 + (i * 10)) },
  { id: 'kis-ai-post-close-learning-v1', kind: 'dry_run', schedule: 'weekdays 15:40 KST', minutes: [940] },
  { id: 'kis-ai-daily-learning-report-v1', kind: 'dry_run', schedule: 'weekdays 16:30 KST', minutes: [990] },
  { id: 'kis-vps-model-v3-autonomous-pilot-v1', kind: 'order', schedule: 'weekdays 09:15-14:55 KST every 10m and 16:20 KST', minutes: [...Array.from({ length: 35 }, (_, i) => 555 + (i * 10)), 980] },
]);
const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));
const DRY_RUN_TASKS = Object.freeze(TASKS.filter((task) => task.kind === 'dry_run'));
const ORDER_TASK = TASKS.find((task) => task.kind === 'order');
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
const ORDER_OUTPUT_KEYS = new Set([
  'task_id', 'status', 'action_type', 'official_trade_date', 'order_api_calls',
  'vps_live_orders', 'prod_orders', 'reconciliations', 'open_positions', 'daily_entry_count',
  'artifact_reused', 'artifact_promoted', 'previous_artifact_hash', 'artifact_hash',
  'shadow_predictions_inserted', 'shadow_duplicates_skipped',
  'model_v2_changed', 'scheduler_changed', 'retry', 'catch_up', 'backfill', 'fail_closed',
  'error_class', 'raw_response_persisted', 'secret_exposure',
]);
const ORDER_EXECUTION_ACTIONS = new Set([
  'entry_reconciled', 'exit_reconciled', 'ai_exit_reconciled',
  'risk_stop_exit_reconciled', 'take_profit_exit_reconciled', 'horizon_exit_reconciled',
]);
const ORDER_ACTIONS = new Set([
  'activation_check', 'position_held', 'ai_position_held',
  'no_candidate_no_op', 'entry_window_closed_no_op', 'market_closed_no_op',
  'waiting_regular_session', 'waiting_post_close', 'shadow_refreshed', 'idempotent_no_op', 'paused',
  ...ORDER_EXECUTION_ACTIONS,
]);

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

function validateReportMessage(value) {
  const reportMessage = String(value || '');
  const lines = reportMessage.split('\n');
  if (reportMessage.length > 600 || lines.length !== 8
    || lines[0] !== '[KIS Adaptive AI Dry-Run]'
    || !/^data: sessions \d+ \/ decisions \d+$/.test(lines[1])
    || !/^models: fixed_rule_v1 baseline \/ candidates \d+$/.test(lines[2])
    || !/^simulation: orders \d+ \/ fills and positions \d+$/.test(lines[3])
    || !/^learning: runs \d+ \/ champion changes 0$/.test(lines[4])
    || !/^quality: incidents \d+ \/ drift reviews \d+$/.test(lines[5])
    || lines[6] !== 'outcomes: no filled samples; cost and MFE/MAE not applicable'
    || lines[7] !== 'actual orders: none') throw new Error('invalid_report_message');
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

function parseKisAiMarketOpenOutput(stdout, expectedTaskId, calendarProofResolver = loadOfficialCalendarProof) {
  const raw = String(stdout || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUFFER_BYTES || SECRET_LIKE_RE.test(raw)) throw new Error('unsafe_or_oversized_output');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid_sanitized_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid_sanitized_json');
  if (Object.keys(value).length !== OUTPUT_KEYS.size || [...OUTPUT_KEYS].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('invalid_output_fields');
  if (value.task_id !== expectedTaskId || !TASK_BY_ID.has(value.task_id)) throw new Error('invalid_output_task_id');
  if (!ALL_STATUSES.has(value.status) || typeof value.action_type !== 'string' || typeof value.error_class !== 'string') throw new Error('invalid_output_status');
  if (!(value.official_trade_date === null || /^\d{4}-\d{2}-\d{2}$/.test(value.official_trade_date))) throw new Error('invalid_output_trade_date');
  if (!['regular_session', 'closed', 'unknown'].includes(value.official_session_state)) throw new Error('invalid_official_session_state');
  if ([...COUNT_KEYS].some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw new Error('invalid_output_count');
  if ([...BOOLEAN_KEYS].some((key) => typeof value[key] !== 'boolean')) throw new Error('invalid_output_boolean');
  if (!FAILURE_PHASES.has(value.failure_phase)
    || !(value.failure_symbol === null || WATCHLIST_SYMBOLS.includes(value.failure_symbol))
    || !FAILURE_EXCEPTION_TYPES.has(value.failure_exception_type)
    || !(value.failure_errno === null || Number.isSafeInteger(value.failure_errno))
    || !Number.isSafeInteger(value.failure_attempt_number) || value.failure_attempt_number < 0
    || value.failure_attempt_number > 3) throw new Error('invalid_failure_evidence');
  if (value.order_api_calls !== 0 || value.vps_live_orders !== 0 || value.prod_orders !== 0
    || value.champion_changed !== false || value.raw_response_persisted !== false
    || value.secret_exposure !== false || value.retry !== false || value.catch_up !== false
    || value.backfill !== false || value.quote_api_calls > 3) throw new Error('unsafe_output');
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
  let reportMessage = null;
  if (value.status === 'report_ready') reportMessage = validateReportMessage(value.report_message);
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

function parseKisVpsAutonomousOutput(stdout, expectedTaskId = ORDER_TASK.id) {
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
  ];
  if (counts.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.order_api_calls > 1 || value.vps_live_orders > 1 || value.prod_orders !== 0
    || value.reconciliations > 1 || value.open_positions > 1 || value.daily_entry_count > 5) {
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
  const blocked = value.status === 'blocked';
  if (value.fail_closed !== blocked
    || (blocked && (value.action_type !== 'paused' || value.error_class === 'none'))
    || (!blocked && value.error_class !== 'none')) throw new Error('invalid_order_fail_closed_contract');
  if (ORDER_EXECUTION_ACTIONS.has(value.action_type)) {
    if (value.status !== 'success' || value.order_api_calls !== 1
      || value.vps_live_orders !== 1 || value.reconciliations !== 1) throw new Error('invalid_order_execution_contract');
  } else if (!blocked && (value.order_api_calls !== 0 || value.vps_live_orders !== 0 || value.reconciliations !== 0)) {
    throw new Error('unexpected_order_execution');
  }
  return Object.freeze({
    status: value.status,
    failClosed: value.fail_closed,
    officialTradeDate: value.official_trade_date,
    actionType: safeText(value.action_type, 60),
    errorClass: safeText(value.error_class, 80),
    orderApiCalls: value.order_api_calls,
    vpsLiveOrders: value.vps_live_orders,
    reconciliations: value.reconciliations,
    openPositions: value.open_positions,
    dailyEntryCount: value.daily_entry_count,
    artifactPromoted: value.artifact_promoted,
    previousArtifactHash,
    artifactHash,
    shadowPredictionsInserted: value.shadow_predictions_inserted,
  });
}

function buildCommand(taskId, { activationPreflight = false, schedulerToken = '', dueKey: invocationDueKey = '' } = {}) {
  if (!TASK_BY_ID.has(taskId)) throw new Error('unknown_task_id');
  if (taskId === ORDER_TASK.id) {
    const scheduledPostCloseRefresh = !activationPreflight && invocationDueKey.endsWith(':16:20');
    const action = activationPreflight
      ? 'activation-check'
      : scheduledPostCloseRefresh ? 'scheduled-refresh-shadow' : 'run-once';
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
      },
    };
  }
  const args = ['-m', 'kis_trading_lab', 'ai-market-open-dry-run-once', '--approval', ACTIVATION_APPROVAL, '--task-id', taskId, '--strategy-manifest', STRATEGY_MANIFEST, '--db', VPS_DB_PATH];
  if (activationPreflight) args.push('--activation-preflight');
  return { command: 'python3', args, cwd: KIS_REPO };
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
      || !WATCHLIST_SYMBOLS.includes(item.symbol) || seen.has(item.symbol)
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
  const legacyV1StatePath = options.legacyV1StatePath || LEGACY_V1_STATE_PATH;
  const legacyV2StatePath = options.legacyV2StatePath || LEGACY_V2_STATE_PATH;
  const legacyV1RunLockPath = options.legacyV1RunLockPath || LEGACY_V1_RUN_LOCK_PATH;
  const legacyV2RunLockPath = options.legacyV2RunLockPath || LEGACY_V2_RUN_LOCK_PATH;
  const runLockPath = options.runLockPath || DEFAULT_RUN_LOCK_PATH;
  const orderAttestationDir = options.orderAttestationDir || ORDER_ATTESTATION_DIR;
  const execFile = options.execFile || defaultExecFile;
  const now = options.now || (() => new Date());
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const runtimeHealthCheck = options.runtimeHealthCheck || defaultRuntimeHealthCheck;
  const reportSender = options.reportSender || null;
  const sourceParityCheck = options.sourceParityCheck || defaultSourceParityCheck;
  const resumeBlockingLockPaths = options.resumeBlockingLockPaths || RESUME_BLOCKING_LOCK_PATHS;
  const calendarProofResolver = options.calendarProofResolver || loadOfficialCalendarProof;
  const schedulerRegistered = options.schedulerRegistered === true;
  const serverRegistered = options.serverRegistered === true;
  const execTimeoutMs = Math.min(Number(options.execTimeoutMs || EXEC_TIMEOUT_MS), EXEC_TIMEOUT_MS);
  const maxBuffer = Math.min(Number(options.maxBuffer || MAX_BUFFER_BYTES), MAX_BUFFER_BYTES);
  let timer = null;
  let ticking = false;
  let schedulerFaulted = false;

  function disabledState() {
    return { canonical_task_id: CANONICAL_TASK_ID, task_owner: TASK_OWNER, state: 'DISABLED', activation_approval: ACTIVATION_APPROVAL, timezone: TIMEZONE, state_path: statePath, max_concurrent_runs: 1, retry: false, catch_up: false, backfill: false, os_cron_used: false, scheduler_registered: false, server_registered: false, tasks: Object.fromEntries(TASKS.map((task) => [task.id, { state: 'DISABLED', schedule: task.schedule, next_run_at: null, last_due_at: null, last_run: null, consecutive_transport_failures: 0, pending_invocation: null, ...(task.kind === 'order' ? { activation_artifact_hash: null, daily_entry_cap: 3, daily_entry_cap_approval_hash: null } : {}) }])) };
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
          pending_invocation: null, activation_artifact_hash: null,
          daily_entry_cap: 3, daily_entry_cap_approval_hash: null,
        };
      }
      const orderTask = value.tasks[ORDER_TASK.id];
      if (orderTask.daily_entry_cap === undefined) orderTask.daily_entry_cap = 3;
      if (orderTask.daily_entry_cap_approval_hash === undefined) orderTask.daily_entry_cap_approval_hash = null;
      if (![3, 5].includes(orderTask.daily_entry_cap)
        || (orderTask.daily_entry_cap === 5 && orderTask.daily_entry_cap_approval_hash !== DAILY_ENTRY_CAP_5_APPROVAL_HASH)
        || (orderTask.daily_entry_cap === 3 && orderTask.daily_entry_cap_approval_hash !== null)) {
        throw new Error('state_contract_invalid');
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return disabledState();
      throw new Error('state_unavailable');
    }
  }
  function save(value) { atomicWrite(statePath, value); return value; }
  function status() {
    try { return { ...loadStrict(), scheduler_faulted: schedulerFaulted }; }
    catch { return { ...disabledState(), state: 'PAUSED', pause_reason: 'state_unavailable', scheduler_faulted: true }; }
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
    if (timer) clearTimer(timer); timer = null;
    const tasks = Object.fromEntries(TASKS.map((task) => {
      const item = current.tasks[task.id];
      return [task.id, { ...item, state: 'PAUSED', pause_reason: task.id === taskId ? reason : 'peer_task_fail_closed', next_run_at: null, last_run: task.id === taskId ? lastRun : item.last_run }];
    }));
    return save({ ...current, state: 'PAUSED', pause_reason: reason, scheduler_registered: false, server_registered: false, tasks });
  }
  function pauseOrder(current, reason, lastRun) {
    const prior = current.tasks[ORDER_TASK.id];
    return save({
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
    });
  }
  function execute(command) {
    return new Promise((resolve) => {
      execFile(command.command, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...(command.env || {}) },
        timeout: execTimeoutMs,
        maxBuffer,
      }, (error, stdout) => resolve({ error, stdout }));
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
      const parsed = parseKisAiMarketOpenOutput(stdout, TASKS[0].id, calendarProofResolver);
      if (parsed.status !== 'success' || parsed.failClosed || parsed.actionType !== 'activation_preflight') throw new Error('activation_preflight_failed');
      const activatedAt = now();
      const tasks = Object.fromEntries(TASKS.map((task) => [task.id, {
        ...(current.tasks[task.id] || {}),
        state: task.kind === 'order' ? 'DISABLED' : 'ACTIVE',
        schedule: task.schedule,
        next_run_at: task.kind === 'order' ? null : nextRunAt(task, activatedAt),
        last_due_at: current.tasks[task.id]?.last_due_at || null,
        last_run: task.id === TASKS[0].id ? { status: 'success', action_type: 'activation_preflight', fail_closed: false, invoked_by: safeText(invokedBy), completed_at: activatedAt.toISOString() } : current.tasks[task.id]?.last_run || null,
      }]));
      return save({ ...current, state: 'ACTIVE', activated_at: activatedAt.toISOString(), activated_by: safeText(invokedBy), scheduler_registered: false, server_registered: false, tasks });
    } finally { if (release) release(); }
  }
  async function resumeAfterIoFix({ approval, invokedBy = 'hermes_cli' } = {}) {
    if (approval !== RESUME_AFTER_IO_FIX_APPROVAL) throw new Error('exact_resume_approval_required');
    const current = loadStrict();
    if (current.state !== 'PAUSED' || !RESUMABLE_PAUSE_REASONS.has(current.pause_reason)) throw new Error('task_not_resumable');
    let release;
    try {
      release = acquireExclusiveLock(runLockPath);
      assertLegacyPaused();
      assertNoResumeBlockingLocks();
      if (await runtimeHealthCheck() !== true) throw new Error('runtime_health_unavailable');
      if (sourceParityCheck() !== true) throw new Error('runtime_source_parity_failed');
      const { error, stdout } = await execute(buildDiagnosticCommand());
      if (error) throw new Error('quote_transport_diagnosis_process_error');
      const diagnostic = parseQuoteTransportDiagnosticOutput(stdout);
      if (!diagnostic.passed || diagnostic.symbolsSucceeded !== 3) throw new Error('quote_transport_diagnosis_failed');
      const resumedAt = now();
      const tasks = Object.fromEntries(TASKS.map((task) => {
        const prior = current.tasks[task.id] || {};
        return [task.id, {
          ...prior,
          state: task.kind === 'order' ? 'DISABLED' : 'ACTIVE',
          pause_reason: undefined,
          next_run_at: task.kind === 'order' ? null : nextRunAt(task, resumedAt),
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
  async function enableOrderTask({ confirm = false, approval = '', invokedBy = 'hermes_cli' } = {}) {
    if (confirm !== true) throw new Error('order_task_confirmation_required');
    if (approval !== ORDER_ACTIVATION_APPROVAL) throw new Error('exact_order_activation_approval_required');
    let release;
    try {
      release = acquireExclusiveLock(runLockPath);
      const current = loadStrict();
      const prior = current.tasks[ORDER_TASK.id];
      const canEnable = prior.state === 'DISABLED'
        || (prior.state === 'PAUSED' && ORDER_TASK_RECOVERY_PAUSE_REASONS.has(prior.pause_reason));
      if (current.state !== 'ACTIVE' || !canEnable) throw new Error('order_task_must_be_disabled');
      assertLegacyPaused();
      assertNoResumeBlockingLocks();
      if (await runtimeHealthCheck() !== true) throw new Error('runtime_health_unavailable');
      const { error, stdout } = await execute(buildCommand(ORDER_TASK.id, { activationPreflight: true }));
      if (error && Number(error.code) !== 2) throw new Error('order_activation_check_process_error');
      const parsed = parseKisVpsAutonomousOutput(stdout, ORDER_TASK.id);
      const activationReady = parsed.status === 'success'
        && parsed.failClosed === false
        && parsed.actionType === 'activation_check';
      const waitingForPostCloseBatch = parsed.status === 'blocked'
        && parsed.failClosed === true
        && parsed.actionType === 'paused'
        && parsed.errorClass === 'model_v3_prediction_batch_incomplete';
      if (!activationReady && !waitingForPostCloseBatch) {
        throw new Error(`order_activation_check_failed:${parsed.errorClass}`);
      }
      if ((activationReady && error)
        || (waitingForPostCloseBatch && (!error || Number(error.code) !== 2))) {
        throw new Error('order_activation_check_process_error');
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
      let scheduledAt = nextRunAt(ORDER_TASK, activatedAt);
      let activationLastRun = {
        status: 'success', action_type: 'activation_check', fail_closed: false,
        invoked_by: safeText(invokedBy), completed_at: activatedAt.toISOString(),
      };
      if (waitingForPostCloseBatch) {
        if (parsed.artifactHash === null
          || (latestPrior.activation_artifact_hash !== null
            && latestPrior.activation_artifact_hash !== parsed.artifactHash)) {
          throw new Error('model_v3_artifact_attestation_mismatch');
        }
        const parts = seoulParts(activatedAt);
        const tradeDate = `${parts.year}-${parts.month}-${parts.day}`;
        let proof;
        try { proof = calendarProofResolver(tradeDate); }
        catch { throw new Error('official_calendar_proof_invalid'); }
        if (!proof || proof.isTradingDay !== true) throw new Error('post_close_arm_requires_trading_day');
        scheduledAt = postCloseRefreshAtToday(activatedAt);
        activationLastRun = {
          status: 'waiting', action_type: 'activation_waiting_post_close', fail_closed: false,
          error_class: 'none', invoked_by: safeText(invokedBy), completed_at: activatedAt.toISOString(),
        };
      }
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
            activation_artifact_hash: parsed.artifactHash,
            pending_invocation: null,
            last_run: activationLastRun,
          },
        },
      });
    } finally { if (release) release(); }
  }
  function approveAggressiveDailyEntryCap({ confirm = false, approval = '', invokedBy = 'hermes_cli' } = {}) {
    if (confirm !== true) throw new Error('daily_entry_cap_confirmation_required');
    if (approval !== DAILY_ENTRY_CAP_5_APPROVAL) throw new Error('exact_daily_entry_cap_approval_required');
    let release;
    try {
      release = acquireExclusiveLock(runLockPath);
      const current = loadStrict();
      const prior = current.tasks[ORDER_TASK.id];
      if (current.state !== 'ACTIVE' || prior.state !== 'ACTIVE') throw new Error('order_task_must_be_active');
      return save({
        ...current,
        tasks: {
          ...current.tasks,
          [ORDER_TASK.id]: {
            ...prior,
            daily_entry_cap: 5,
            daily_entry_cap_approval_hash: DAILY_ENTRY_CAP_5_APPROVAL_HASH,
            daily_entry_cap_approved_at: now().toISOString(),
            daily_entry_cap_approved_by: safeText(invokedBy),
          },
        },
      });
    } finally { if (release) release(); }
  }
  function withRegistration(current) {
    if (current.state !== 'ACTIVE') return current;
    return { ...current, scheduler_registered: Boolean(timer) && schedulerRegistered, server_registered: Boolean(timer) && schedulerRegistered && serverRegistered };
  }
  async function runOnce({ taskId, invokedBy = 'hermes_scheduler', dueAt = now() } = {}) {
    if (!TASK_BY_ID.has(taskId)) throw new Error('unknown_task_id');
    let current = loadStrict(); let taskState = current.tasks[taskId]; const task = TASK_BY_ID.get(taskId);
    if (current.state !== 'ACTIVE' || taskState.state !== 'ACTIVE') return current;
    const pauseForTask = (state, reason, lastRun) => (
      task.kind === 'order' ? pauseOrder(state, reason, lastRun) : pauseAll(state, taskId, reason, lastRun)
    );
    const dueTime = dueAt instanceof Date ? dueAt : new Date(dueAt);
    if (Number.isNaN(dueTime.getTime())) return pauseForTask(current, 'due_time_invalid', { error_class: 'due_time_invalid', fail_closed: true });
    if (!isDue(task, dueTime) || !sameMinute(taskState.next_run_at, dueTime)) {
      const scheduled = new Date(taskState.next_run_at || 0);
      if (scheduled.getTime() < dueTime.getTime()) {
        return save({ ...current, tasks: { ...current.tasks, [taskId]: { ...taskState, next_run_at: nextRunAt(task, dueTime), last_run: { status: 'no_op', action_type: 'missed_window_no_op', error_class: 'none', fail_closed: false, catch_up: false, invoked_by: safeText(invokedBy), completed_at: now().toISOString() } } } });
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
      if (error.message === 'scheduler_lock_active') return loadStrict();
      return pauseForTask(loadStrict(), safeText(error.message, 80), { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), error_class: safeText(error.message, 80), fail_closed: true });
    }
    current = loadStrict();
    taskState = current.tasks[taskId];
    if (current.state !== 'ACTIVE' || taskState.state !== 'ACTIVE'
      || !sameMinute(taskState.next_run_at, dueTime)) return current;
    const key = dueKey(task, dueTime);
    const schedulerToken = task.kind === 'order' ? crypto.randomBytes(16).toString('hex') : '';
    const pendingInvocation = task.kind === 'order' ? {
      due_key: key,
      token_hash: crypto.createHash('sha256').update(schedulerToken).digest('hex'),
      expires_at: new Date(now().getTime() + (5 * 60_000)).toISOString(),
      daily_entry_cap: taskState.daily_entry_cap,
      daily_entry_cap_approval_hash: taskState.daily_entry_cap_approval_hash,
    } : null;
    let attestationPath = null;
    try {
      save({ ...current, tasks: { ...current.tasks, [taskId]: {
        ...taskState, last_due_at: key, next_run_at: nextRunAt(task, dueTime), pending_invocation: pendingInvocation,
      } } });
      if (task.kind === 'order') {
        attestationPath = attestationFileForDueKey(key, orderAttestationDir);
        atomicWrite(attestationPath, pendingInvocation);
      }
      const command = buildCommand(taskId, { schedulerToken, dueKey: key });
      const { error, stdout } = await execute(command);
      if (error && Number(error.code) !== 2) return pauseForTask(loadStrict(), error.killed ? 'timeout' : 'process_error', { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), error_class: error.killed ? 'timeout' : 'process_error', fail_closed: true });
      let parsed;
      try {
        parsed = task.kind === 'order'
          ? parseKisVpsAutonomousOutput(stdout, taskId)
          : parseKisAiMarketOpenOutput(stdout, taskId, calendarProofResolver);
      } catch (parseError) {
        return pauseForTask(loadStrict(), safeText(parseError.message, 80), { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), error_class: 'invalid_safety_output', fail_closed: true });
      }
      const slot = seoulParts(dueTime);
      const postCloseOrderSlot = task.kind === 'order'
        && Number(slot.hour) === 16
        && Number(slot.minute) === 20;
      if (task.kind === 'order' && parsed.artifactPromoted) {
        if (Number(slot.hour) !== 16 || Number(slot.minute) !== 20) {
          return pauseOrder(loadStrict(), 'model_v3_promotion_outside_post_close_slot', {
            invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
            error_class: 'model_v3_promotion_outside_post_close_slot', fail_closed: true,
          });
        }
      }
      if (task.kind === 'order' && !parsed.failClosed) {
        const actionAllowed = postCloseOrderSlot
          ? ['shadow_refreshed', 'market_closed_no_op'].includes(parsed.actionType)
          : parsed.actionType !== 'shadow_refreshed';
        if (!actionAllowed) {
          return pauseOrder(loadStrict(), 'order_action_not_allowed_for_schedule_slot', {
            invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
            error_class: 'order_action_not_allowed_for_schedule_slot', fail_closed: true,
          });
        }
      }
      const latest = loadStrict(); const latestTask = latest.tasks[taskId];
      if (task.kind === 'order' && parsed.dailyEntryCount > latestTask.daily_entry_cap) {
        return pauseOrder(latest, 'daily_entry_cap_attestation_mismatch', {
          invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
          error_class: 'daily_entry_cap_attestation_mismatch', fail_closed: true,
        });
      }
      const artifactAttestationValid = task.kind !== 'order'
        || (parsed.artifactPromoted
          ? parsed.previousArtifactHash === latestTask.activation_artifact_hash
          : parsed.artifactHash === latestTask.activation_artifact_hash);
      if (!artifactAttestationValid) {
        return pauseOrder(latest, 'model_v3_artifact_attestation_mismatch', {
          invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(),
          error_class: 'model_v3_artifact_attestation_mismatch', fail_closed: true,
        });
      }
      const lastRun = { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), status: parsed.status, fail_closed: parsed.failClosed, official_trade_date: parsed.officialTradeDate, action_type: parsed.actionType, error_class: parsed.errorClass };
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
        });
      } else {
        Object.assign(lastRun, {
          failure_phase: parsed.failurePhase,
          failure_symbol: parsed.failureSymbol,
          failure_exception_type: parsed.failureExceptionType,
          failure_errno: parsed.failureErrno,
          failure_attempt_number: parsed.failureAttemptNumber,
        });
      }
      if (parsed.status === 'blocked' || parsed.failClosed || error) return pauseForTask(latest, parsed.errorClass || 'blocked', lastRun);
      if (task.kind === 'order') {
        return save({ ...latest, tasks: { ...latest.tasks, [taskId]: {
          ...latestTask,
          state: 'ACTIVE',
          pause_reason: undefined,
          consecutive_transport_failures: 0,
          pending_invocation: null,
          activation_artifact_hash: parsed.artifactPromoted ? parsed.artifactHash : latestTask.activation_artifact_hash,
          last_run: lastRun,
        } } });
      }
      if (parsed.transportDegraded) {
        const consecutive = Number(latestTask.consecutive_transport_failures || 0) + 1;
        lastRun.consecutive_transport_failures = consecutive;
        if (consecutive >= 2) return pauseAll(latest, taskId, parsed.errorClass, lastRun);
        return save({ ...latest, tasks: { ...latest.tasks, [taskId]: { ...latestTask, state: 'ACTIVE', pause_reason: undefined, consecutive_transport_failures: consecutive, last_run: lastRun } } });
      }
      if (parsed.status === 'report_ready') {
        if (typeof reportSender !== 'function') return pauseAll(latest, taskId, 'report_sender_missing', { ...lastRun, delivery_attempted: false });
        let delivery;
        try { delivery = await reportSender({ targetChannelId: REPORT_TARGET_CHANNEL_ID, content: parsed.reportMessage, deliveryLayer: 'hermes_ai_market_open_dry_run' }); }
        catch { return pauseAll(loadStrict(), taskId, 'report_delivery_failed', { ...lastRun, delivery_attempted: true, delivery_succeeded: false }); }
        if (delivery?.discord_sent !== true) return pauseAll(loadStrict(), taskId, safeText(delivery?.error_class || 'report_delivery_failed'), { ...lastRun, delivery_attempted: true, delivery_succeeded: false });
        lastRun.status = 'report_sent'; lastRun.delivery_attempted = true; lastRun.delivery_succeeded = true;
      }
      return save({ ...latest, tasks: { ...latest.tasks, [taskId]: { ...latestTask, state: 'ACTIVE', pause_reason: undefined, consecutive_transport_failures: 0, last_run: lastRun } } });
    } finally {
      if (attestationPath) {
        try { fs.unlinkSync(attestationPath); } catch (error) { if (error.code !== 'ENOENT') schedulerFaulted = true; }
      }
      if (release) release();
    }
  }
  async function tick() {
    if (ticking || schedulerFaulted) return status();
    ticking = true;
    try {
      let current = withRegistration(loadStrict());
      if (JSON.stringify(current) !== JSON.stringify(loadStrict())) current = save(current);
      if (current.state === 'ACTIVE') {
        const time = now();
        for (const task of TASKS) {
          const item = current.tasks[task.id];
          if (item?.state === 'ACTIVE' && item.next_run_at && new Date(item.next_run_at).getTime() <= time.getTime()) {
            current = await runOnce({ taskId: task.id, dueAt: time });
            if (current.tasks?.[task.id]?.last_run?.action_type !== 'missed_window_no_op') break;
          }
        }
      }
      return current;
    } catch (error) {
      schedulerFaulted = true;
      if (timer) clearTimer(timer); timer = null;
      try { const current = loadStrict(); return pauseAll(current, TASKS[0].id, 'scheduler_state_fault', { status: 'paused', fail_closed: true, error_class: 'scheduler_state_fault', completed_at: now().toISOString() }); }
      catch { return status(); }
    } finally { ticking = false; }
  }
  function schedule() {
    if (!timer || schedulerFaulted) return;
    timer = setTimer(() => { tick().finally(() => { if (!schedulerFaulted) schedule(); }); }, POLL_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function start() {
    if (!timer && !schedulerFaulted) { timer = {}; save(withRegistration(loadStrict())); schedule(); }
    return status();
  }
  function stop() {
    if (timer) clearTimer(timer); timer = null;
    const current = loadStrict(); return save({ ...current, scheduler_registered: false, server_registered: false });
  }
  return { statePath, status, prepareDisabled, activate, resumeAfterIoFix, enableOrderTask, approveAggressiveDailyEntryCap, runOnce, start, stop, tick, buildCommand };
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
    : action === 'enable-order' ? await task.enableOrderTask({ confirm: argv.includes('--confirm'), approval, invokedBy: 'hermes_cli' })
    : action === 'approve-daily-cap-5' ? task.approveAggressiveDailyEntryCap({ confirm: argv.includes('--confirm'), approval, invokedBy: 'hermes_cli' })
    : action === 'status' ? task.status()
    : action === 'start' ? task.start()
    : action === 'stop' ? task.stop()
    : action === 'tick' ? await task.tick()
    : action === 'run-once' ? await task.runOnce({ taskId: argv[1], invokedBy: 'hermes_cli' }) : (() => { throw new Error('unknown_action'); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (require.main === module) cli().catch((error) => { process.stderr.write(`${safeText(error.message, 100)}\n`); process.exitCode = 1; });

module.exports = {
  CANONICAL_TASK_ID,
  TASK_OWNER,
  ACTIVATION_APPROVAL, RESUME_AFTER_IO_FIX_APPROVAL, ORDER_ACTIVATION_APPROVAL,
  DAILY_ENTRY_CAP_5_APPROVAL, DAILY_ENTRY_CAP_5_APPROVAL_HASH,
  KIS_REPO, KIS_VENV_PYTHON, VPS_DB_PATH, STRATEGY_MANIFEST, DEFAULT_STATE_PATH, DEFAULT_CALENDAR_SNAPSHOT_PATH,
  ORDER_ATTESTATION_DIR,
  APPROVED_SOURCE_TASK_PATH,
  LEGACY_V1_STATE_PATH, LEGACY_V2_STATE_PATH, DEFAULT_RUN_LOCK_PATH, REPORT_TARGET_CHANNEL_ID,
  TIMEZONE, POLL_INTERVAL_MS, EXEC_TIMEOUT_MS, MAX_BUFFER_BYTES, TASKS,
  parseKisAiMarketOpenOutput, parseKisVpsAutonomousOutput, parseQuoteTransportDiagnosticOutput, loadOfficialCalendarProof,
  nextRunAt, buildCommand, buildDiagnosticCommand, defaultSourceParityCheck, acquireExclusiveLock,
  createKisAiMarketOpenDryRunTask,
};
