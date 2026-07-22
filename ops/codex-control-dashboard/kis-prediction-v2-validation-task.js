'use strict';

const { execFile: defaultExecFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TASK_ID = 'kis-prediction-validation-cycle-v2';
const TASK_NAME = 'KIS Prediction V2 Validation';
const TASK_OWNER = 'hermes';
const TASK_STATE = 'DISABLED';
const KIS_REPO = '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab';
const KIS_APPROVAL = 'APPROVE_KIS_MODEL_V2_BOUNDED_VALIDATION_START_V1';
const VPS_MOCK_DB_PATH = '/var/lib/kis-trading-lab/kis-vps.sqlite3';
const PROD_DB_PATH = '/var/lib/kis-trading-lab/kis-prod.sqlite3';
const MAX_DISTINCT_TRADING_DAYS = 20;
const MAX_CONCURRENT_RUNS = 1;
const RETRY_ON_FAILURE = false;
const TIMEZONE = 'Asia/Seoul';
const SCHEDULE_RRULE = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=16;BYMINUTE=10;BYSECOND=0';
const DEFAULT_STATE_PATH = '/home/ubuntu/.hermes/state/kis-prediction-validation-cycle-v2.json';
const LEGACY_TASK_STATE_PATH = '/home/ubuntu/.hermes/state/kis-prediction-validation-cycle.json';
const ADAPTIVE_TASK_STATE_PATH = '/home/ubuntu/.hermes/state/kis-ai-market-open-dry-run-v1.json';
const SCHEDULER_CUTOVER_LOCK_PATH = '/tmp/kis-prediction-scheduler-cutover.lock';
const LEGACY_KIS_RUN_LOCK_PATH = '/tmp/kis-trading-lab-prediction-validation-auto.lock';
const HERMES_RUN_LOCK_PATH = '/tmp/kis-prediction-validation-cycle-v2-hermes.lock';
const POLL_INTERVAL_MS = 60_000;
const EXEC_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;

const ALLOWED_ACTIONS = new Set([
  'reconcile_only',
  'predict_only',
  'reconcile_then_predict',
  'idempotent_no_op',
  'market_closed_no_op',
  'waiting_for_horizon',
  'paused',
  'completed',
]);
const SAFE_OUTPUT_KEYS = new Set([
  'status',
  'action',
  'blocked',
  'automation_paused',
  'completed',
  'db_opened',
  'db_written',
  'schema_evidence_checked',
  'integrity_checked',
  'prediction_inserted_count',
  'outcome_inserted_count',
  'pending_matured_count',
  'distinct_decision_day_count',
  'api_called',
  'order_attempted',
  'scheduler_changed',
  'cron_changed',
  'raw_values_printed',
  'executed',
  'action_type',
  'prediction_horizon',
  'target_definition',
  'timezone',
  'prediction_window',
  'reconciliation_window',
  'max_distinct_trading_days',
  'market_data_api_calls',
  'predictions_inserted',
  'outcomes_resolved',
  'distinct_trading_days',
  'total_predictions',
  'resolved_predictions',
  'correct_predictions',
  'incorrect_predictions',
  'neutral_predictions',
  'pending_predictions',
  'paper_trade_count',
  'live_trade_count',
  'sample_status',
  'fail_closed',
  'error_class',
  'prod_db_touched',
  'secret_exposed',
  'raw_response_persisted',
  'new_nonessential_features',
]);
const BOOLEAN_KEYS = new Set([
  'blocked',
  'automation_paused',
  'completed',
  'db_opened',
  'db_written',
  'schema_evidence_checked',
  'integrity_checked',
  'api_called',
  'order_attempted',
  'scheduler_changed',
  'cron_changed',
  'raw_values_printed',
  'executed',
  'fail_closed',
  'prod_db_touched',
  'secret_exposed',
  'raw_response_persisted',
  'new_nonessential_features',
]);
const NUMBER_KEYS = new Set([
  'prediction_inserted_count',
  'outcome_inserted_count',
  'pending_matured_count',
  'distinct_decision_day_count',
  'max_distinct_trading_days',
  'market_data_api_calls',
  'predictions_inserted',
  'outcomes_resolved',
  'distinct_trading_days',
  'total_predictions',
  'resolved_predictions',
  'correct_predictions',
  'incorrect_predictions',
  'neutral_predictions',
  'pending_predictions',
  'paper_trade_count',
  'live_trade_count',
]);
const FIXED_TEXT_FIELDS = Object.freeze({
  prediction_horizon: 'next_session',
  target_definition: 'direction_label_next_official_krx_session_from_preregistered_chart_features',
  timezone: 'Asia/Seoul',
  prediction_window: '15:30-17:50 Asia/Seoul',
  reconciliation_window: 'after_next_official_session_quote_available',
});
const STATUS_ACTIONS = new Map([
  ['ready', new Set(['predict_only', 'reconcile_only', 'reconcile_then_predict', 'idempotent_no_op'])],
  ['waiting', new Set(['waiting_for_horizon'])],
  ['market_closed_no_op', new Set(['market_closed_no_op'])],
  ['completed', new Set(['completed'])],
  ['blocked', new Set(['paused'])],
]);
const POSITIVE_STATUSES = new Set(['ready', 'waiting', 'market_closed_no_op', 'completed']);
const AGGREGATE_COUNT_KEYS = [...NUMBER_KEYS].filter((key) => key !== 'max_distinct_trading_days');
const SECRET_LIKE_RE = /(Bearer\s+[A-Za-z0-9._-]+|app[_-]?secret|app[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client_secret|[A-Za-z0-9+/]{64,}={0,2})/ig;

function sanitizeText(value, maxLength = 160) {
  return String(value ?? '')
    .replace(SECRET_LIKE_RE, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function boolValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function numberValue(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseKisV2CliOutput(stdout) {
  const result = {};
  const invalidActionKeys = new Set();
  const seenKeys = new Set();
  const duplicateKeys = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!SAFE_OUTPUT_KEYS.has(key)) continue;
    if (seenKeys.has(key)) {
      duplicateKeys.add(key);
      continue;
    }
    seenKeys.add(key);
    const raw = line.slice(index + 1).trim();
    if (key === 'action' || key === 'action_type') {
      if (ALLOWED_ACTIONS.has(raw)) result[key] = raw;
      else invalidActionKeys.add(key);
    } else if (BOOLEAN_KEYS.has(key)) {
      const parsed = boolValue(raw);
      if (parsed !== undefined) result[key] = parsed;
    } else if (NUMBER_KEYS.has(key)) {
      const parsed = numberValue(raw);
      if (parsed !== undefined) result[key] = parsed;
    } else result[key] = sanitizeText(raw);
  }
  for (const key of invalidActionKeys) delete result[key];
  for (const key of duplicateKeys) delete result[key];
  return result;
}

function buildCommand(config = {}) {
  const targetDbPath = config.targetDbPath === undefined ? VPS_MOCK_DB_PATH : config.targetDbPath;
  if (targetDbPath !== VPS_MOCK_DB_PATH || targetDbPath === PROD_DB_PATH) {
    throw new Error('noncanonical_or_prod_db_path_blocked');
  }
  if (config.kisRepo !== undefined && config.kisRepo !== KIS_REPO) {
    throw new Error('fixed_kis_repo_required');
  }
  if (config.python !== undefined && config.python !== 'python3') {
    throw new Error('fixed_python_command_required');
  }
  return {
    command: 'python3',
    args: ['-m', 'kis_trading_lab', 'prediction-v2-validation-auto-once', '--approval', KIS_APPROVAL, '--db', targetDbPath],
    cwd: KIS_REPO,
    targetDbPath,
  };
}

function hasExactOutputKeys(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  const keys = Object.keys(summary);
  return keys.length === SAFE_OUTPUT_KEYS.size
    && [...SAFE_OUTPUT_KEYS].every((key) => Object.prototype.hasOwnProperty.call(summary, key));
}

function hasValidTypedOutput(summary) {
  return [...BOOLEAN_KEYS].every((key) => typeof summary[key] === 'boolean')
    && [...NUMBER_KEYS].every((key) => Number.isSafeInteger(summary[key]) && summary[key] >= 0);
}

function hasValidFixedContract(summary) {
  return Object.entries(FIXED_TEXT_FIELDS).every(([key, value]) => summary[key] === value)
    && summary.max_distinct_trading_days === MAX_DISTINCT_TRADING_DAYS;
}

function hasValidStatusContract(summary) {
  const expectedActions = STATUS_ACTIONS.get(summary.status);
  if (!expectedActions || !expectedActions.has(summary.action) || summary.action !== summary.action_type) return false;

  const isBlocked = summary.status === 'blocked';
  const isCompleted = summary.status === 'completed';
  const expectedErrorClass = isBlocked ? 'blocked' : 'none';
  if (summary.blocked !== isBlocked
    || summary.fail_closed !== isBlocked
    || summary.automation_paused !== (isBlocked || isCompleted)
    || summary.completed !== isCompleted
    || summary.sample_status !== summary.status
    || summary.error_class !== expectedErrorClass) return false;

  if (isCompleted) return summary.distinct_trading_days === MAX_DISTINCT_TRADING_DAYS;
  if (POSITIVE_STATUSES.has(summary.status)) return summary.distinct_trading_days < MAX_DISTINCT_TRADING_DAYS;
  return isBlocked;
}

function hasValidCountContract(summary) {
  return summary.prediction_inserted_count === summary.predictions_inserted
    && summary.outcome_inserted_count === summary.outcomes_resolved
    && summary.distinct_decision_day_count === summary.distinct_trading_days
    && summary.pending_predictions === summary.total_predictions - summary.resolved_predictions
    && summary.resolved_predictions === summary.correct_predictions
      + summary.incorrect_predictions + summary.neutral_predictions;
}

function hasValidActionSemantics(summary) {
  const predictionsInserted = summary.predictions_inserted;
  const outcomesResolved = summary.outcomes_resolved;
  switch (summary.action) {
    case 'idempotent_no_op':
      return predictionsInserted === 0 && outcomesResolved === 0 && summary.db_written === false;
    case 'predict_only':
      return predictionsInserted === 3 && outcomesResolved === 0 && summary.db_written === true;
    case 'reconcile_then_predict':
      return predictionsInserted === 3 && outcomesResolved > 0 && summary.db_written === true;
    case 'reconcile_only':
      return predictionsInserted === 0 && outcomesResolved > 0 && summary.db_written === true;
    default:
      return false;
  }
}

function hasValidPositiveSemantics(summary) {
  if (!POSITIVE_STATUSES.has(summary.status)) return true;
  if (summary.total_predictions !== summary.distinct_trading_days * 3) return false;
  if (summary.db_written !== (summary.predictions_inserted + summary.outcomes_resolved > 0)) return false;
  if (summary.schema_evidence_checked && (!summary.db_opened || !summary.integrity_checked)) return false;

  if (summary.status === 'ready') {
    return summary.executed === true
      && summary.db_opened === true
      && summary.integrity_checked === true
      && hasValidActionSemantics(summary);
  }
  if (summary.status === 'waiting') {
    const preWindow = summary.executed === false && summary.db_opened === false && summary.integrity_checked === false;
    const postDb = summary.executed === true && summary.db_opened === true && summary.integrity_checked === true;
    return summary.predictions_inserted === 0
      && summary.outcomes_resolved === 0
      && summary.db_written === false
      && (preWindow || postDb);
  }
  if (summary.status === 'market_closed_no_op') {
    return summary.executed === false
      && summary.db_opened === false
      && summary.db_written === false
      && summary.integrity_checked === false
      && AGGREGATE_COUNT_KEYS.every((key) => summary[key] === 0);
  }
  if (summary.status === 'completed') {
    const validInsertPattern = summary.predictions_inserted === 0 || summary.predictions_inserted === 3;
    return summary.executed === true
      && summary.db_opened === true
      && summary.integrity_checked === true
      && summary.distinct_trading_days === MAX_DISTINCT_TRADING_DAYS
      && validInsertPattern;
  }
  return false;
}

function hasSafeExternalEffects(summary) {
  return summary.market_data_api_calls >= 0
    && summary.market_data_api_calls <= 3
    && summary.api_called === (summary.market_data_api_calls > 0)
    && summary.paper_trade_count === 0
    && summary.live_trade_count === 0
    && summary.order_attempted === false
    && summary.scheduler_changed === false
    && summary.cron_changed === false
    && summary.raw_values_printed === false
    && summary.prod_db_touched === false
    && summary.secret_exposed === false
    && summary.raw_response_persisted === false
    && summary.new_nonessential_features === false;
}

function hasSafeFailClosedSemantics(summary) {
  return summary.status === 'blocked'
    && summary.action === 'paused'
    && summary.action_type === 'paused'
    && summary.fail_closed === true
    && summary.db_written === false
    && summary.prediction_inserted_count === 0
    && summary.outcome_inserted_count === 0
    && summary.predictions_inserted === 0
    && summary.outcomes_resolved === 0
    && summary.api_called === false
    && summary.market_data_api_calls === 0;
}

function mapSummaryToTaskState(summary = {}) {
  const validContract = hasExactOutputKeys(summary)
    && hasValidTypedOutput(summary)
    && hasValidFixedContract(summary)
    && hasValidStatusContract(summary)
    && hasValidCountContract(summary)
    && hasValidPositiveSemantics(summary)
    && hasSafeExternalEffects(summary);

  if (!validContract) return { state: 'PAUSED', reason: 'invalid_stage_p_contract' };
  if (summary.status === 'blocked') return { state: 'PAUSED', reason: 'blocked' };
  if (summary.status === 'completed') {
    return { state: 'COMPLETED', reason: 'minimum_distinct_trading_days_reached' };
  }
  return { state: 'ACTIVE', reason: 'last_run_success' };
}

function nowIso(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function classifyError(error) {
  const text = String(error && (error.code || error.message || error) || '').toLowerCase();
  if (/timeout|timedout/.test(text)) return 'timeout';
  if (/enoent|not found|missing/.test(text)) return 'missing_dependency';
  if (/permission|denied|forbidden|unauthorized/.test(text)) return 'permission';
  return 'process_error';
}

function isExpectedFailClosedExit(error) {
  return Boolean(error)
    && Number(error.code) === 2
    && error.killed !== true
    && !error.signal;
}

function parseKstParts(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function nextRunAt(from = new Date()) {
  for (let offset = 0; offset < 10; offset += 1) {
    const base = new Date(from.getTime() + offset * 24 * 60 * 60 * 1000);
    const parts = parseKstParts(base);
    if (parts.weekday === 0 || parts.weekday === 6) continue;
    const candidateUtc = new Date(Date.UTC(parts.year, parts.month, parts.day, 7, 10, 0));
    if (candidateUtc.getTime() > from.getTime()) return candidateUtc.toISOString();
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function defaultState(overrides = {}) {
  const createdAt = nowIso();
  const state = {
    canonical_task_id: TASK_ID,
    task_name: TASK_NAME,
    task_owner: TASK_OWNER,
    state: TASK_STATE,
    timezone: TIMEZONE,
    schedule: SCHEDULE_RRULE,
    next_run_at: null,
    last_run: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
  return {
    ...state,
    canonical_task_id: TASK_ID,
    task_name: TASK_NAME,
    task_owner: TASK_OWNER,
    timezone: TIMEZONE,
    schedule: SCHEDULE_RRULE,
    max_distinct_trading_days: MAX_DISTINCT_TRADING_DAYS,
    max_concurrent_runs: MAX_CONCURRENT_RUNS,
    retry: false,
    retry_on_failure: RETRY_ON_FAILURE,
    orders_enabled: false,
    os_cron_used: false,
    live_execution_enabled: state.state === 'ACTIVE',
    scheduler_registered: Boolean(state.scheduler_registered && state.state === 'ACTIVE'),
    server_registered: Boolean(state.server_registered && state.state === 'ACTIVE'),
  };
}

function readState(statePath) {
  try {
    return defaultState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultState();
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ ...state, updated_at: nowIso() }, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, statePath);
    if (process.platform !== 'win32') fs.chmodSync(statePath, 0o600);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporaryPath); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

function acquireExclusiveLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, 'kis_prediction_scheduler_lock\n', 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw new Error(error.code === 'EEXIST' ? 'scheduler_lock_active' : 'scheduler_lock_failed');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  };
}

function readPausedLegacyTaskState(legacyStatePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8'));
  } catch {
    throw new Error('legacy_v1_state_unavailable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || String(parsed.state || '').toUpperCase() !== 'PAUSED'
    || parsed.next_run_at !== null) {
    throw new Error('legacy_v1_state_must_be_paused');
  }
  return parsed;
}

function readDormantAdaptiveTaskState(adaptiveStatePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(adaptiveStatePath, 'utf8'));
  } catch {
    throw new Error('adaptive_state_unavailable');
  }
  const state = String(parsed && parsed.state || '').toUpperCase();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.canonical_task_id !== 'kis-ai-market-open-dry-run-v1'
    || parsed.task_owner !== 'hermes'
    || !new Set(['PAUSED', 'DISABLED']).has(state)
    || parsed.scheduler_registered !== false
    || parsed.server_registered !== false) {
    throw new Error('adaptive_scheduler_must_be_dormant');
  }
  return parsed;
}

function safeLastRun(summary, overrides = {}) {
  const safe = {};
  for (const key of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(summary, key)) safe[key] = summary[key];
  }
  return { ...safe, ...overrides };
}

function boundedPositive(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), maximum) : fallback;
}

function createKisPredictionV2ValidationTask(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const legacyStatePath = options.legacyStatePath || LEGACY_TASK_STATE_PATH;
  const cutoverLockPath = options.cutoverLockPath || SCHEDULER_CUTOVER_LOCK_PATH;
  const legacyRunLockPath = options.legacyRunLockPath || LEGACY_KIS_RUN_LOCK_PATH;
  const runLockPath = options.runLockPath || HERMES_RUN_LOCK_PATH;
  const execFile = options.execFile || defaultExecFile;
  const logger = options.logger || { error() {} };
  const pollIntervalMs = boundedPositive(options.pollIntervalMs, POLL_INTERVAL_MS, POLL_INTERVAL_MS);
  const execTimeoutMs = boundedPositive(options.execTimeoutMs, EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS);
  const maxBuffer = boundedPositive(options.maxBuffer, MAX_BUFFER_BYTES, MAX_BUFFER_BYTES);
  const stateWriter = options.stateWriter || writeState;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let running = false;
  let schedulerFaulted = false;
  let timer = null;

  function save(next) {
    const normalized = defaultState(next);
    stateWriter(statePath, normalized);
    return status();
  }

  function status() {
    const current = readState(statePath);
    return { ...current, last_run: current.last_run && { ...current.last_run } };
  }

  function prepareDisabled() {
    return save({ ...status(), state: 'DISABLED', next_run_at: null, last_run: null, scheduler_registered: false, server_registered: false });
  }

  function enforceDormantOwnership(reason = 'superseded_by_adaptive_scheduler') {
    const current = status();
    if (current.state !== 'ACTIVE' && current.scheduler_registered !== true && current.server_registered !== true) {
      return current;
    }
    return save({
      ...current,
      state: 'PAUSED',
      pause_reason: sanitizeText(reason, 80),
      next_run_at: null,
      scheduler_registered: false,
      server_registered: false,
    });
  }

  function activate({ invokedBy = 'hermes' } = {}) {
    let releaseCutover;
    let releaseLegacyRun;
    try {
      releaseCutover = acquireExclusiveLock(cutoverLockPath);
      releaseLegacyRun = acquireExclusiveLock(legacyRunLockPath);
      readPausedLegacyTaskState(legacyStatePath);
      const current = status();
      if (current.state !== 'DISABLED') throw new Error('v2_task_must_be_disabled');
      return save({
        ...current,
        state: 'ACTIVE',
        activated_at: nowIso(),
        activated_by: sanitizeText(invokedBy, 80),
        next_run_at: nextRunAt(),
        scheduler_registered: false,
        server_registered: false,
      });
    } finally {
      if (releaseLegacyRun) releaseLegacyRun();
      if (releaseCutover) releaseCutover();
    }
  }

  function pause(reason = 'operator_pause') {
    return save({ ...status(), state: 'PAUSED', pause_reason: sanitizeText(reason, 80), next_run_at: null, scheduler_registered: false, server_registered: false });
  }

  function runOnce({ invokedBy = 'hermes' } = {}) {
    const current = status();
    if (current.state !== 'ACTIVE') {
      return Promise.resolve({ ...current, last_run: { status: 'skipped', action_type: 'idempotent_no_op', error_class: 'task_not_active', invoked_by: sanitizeText(invokedBy, 80) } });
    }
    if (running) {
      return Promise.resolve(save({ ...current, last_run: {
        status: 'skipped',
        action_type: 'idempotent_no_op',
        error_class: 'previous_run_active',
        duplicate_execution_prevented: true,
        invoked_by: sanitizeText(invokedBy, 80),
        completed_at: nowIso(),
      } }));
    }

    let releaseRunLock;
    try {
      releaseRunLock = acquireExclusiveLock(runLockPath);
    } catch (error) {
      return Promise.resolve({
        ...current,
        last_run: {
          status: 'skipped',
          action_type: 'idempotent_no_op',
          error_class: sanitizeText(error.message, 80),
          duplicate_execution_prevented: true,
          invoked_by: sanitizeText(invokedBy, 80),
          completed_at: nowIso(),
        },
      });
    }

    let commandSpec;
    try {
      commandSpec = buildCommand(options);
    } catch (error) {
      releaseRunLock();
      return Promise.resolve(pause(sanitizeText(error.message, 80)));
    }
    running = true;
    const startedAt = nowIso();
    return new Promise((resolve, reject) => {
      const releaseRunLockOnce = () => {
        if (!releaseRunLock) return;
        const release = releaseRunLock;
        releaseRunLock = null;
        release();
      };
      const finishPaused = (errorClass) => {
        if (timer) clearTimer(timer);
        timer = null;
        try {
          const saved = save({
            ...status(), state: 'PAUSED', pause_reason: errorClass, next_run_at: null,
            scheduler_registered: false, server_registered: false,
            last_run: { status: 'paused', action_type: 'paused', fail_closed: true, error_class: errorClass, invoked_by: sanitizeText(invokedBy, 80), started_at: startedAt, completed_at: nowIso() },
          });
          releaseRunLockOnce();
          resolve(saved);
        } catch (stateError) {
          schedulerFaulted = true;
          releaseRunLockOnce();
          reject(stateError);
        }
      };
      try {
        execFile(commandSpec.command, commandSpec.args, {
          cwd: commandSpec.cwd,
          env: process.env,
          timeout: execTimeoutMs,
          maxBuffer,
        }, (error, stdout) => {
          running = false;
          if (error && !isExpectedFailClosedExit(error)) return finishPaused(classifyError(error));
          try {
            const parsed = parseKisV2CliOutput(stdout);
            const mapped = mapSummaryToTaskState(parsed);
            if (error && !(mapped.state === 'PAUSED'
              && mapped.reason === 'blocked'
              && parsed.status === 'blocked'
              && parsed.fail_closed === true
              && hasSafeFailClosedSemantics(parsed))) {
              return finishPaused(classifyError(error));
            }
            if (mapped.state !== 'ACTIVE' && timer) clearTimer(timer);
            if (mapped.state !== 'ACTIVE') timer = null;
            const next = {
              ...status(), state: mapped.state,
              pause_reason: mapped.state === 'PAUSED' ? mapped.reason : undefined,
              completion_reason: mapped.state === 'COMPLETED' ? mapped.reason : undefined,
              next_run_at: mapped.state === 'ACTIVE' ? nextRunAt() : null,
              scheduler_registered: mapped.state === 'ACTIVE' && Boolean(timer) && options.schedulerRegistered === true,
              server_registered: mapped.state === 'ACTIVE' && Boolean(timer) && options.schedulerRegistered === true && options.serverRegistered === true,
              last_run: safeLastRun(parsed, { invoked_by: sanitizeText(invokedBy, 80), started_at: startedAt, completed_at: nowIso() }),
            };
            const saved = save(next);
            releaseRunLockOnce();
            resolve(saved);
          } catch (callbackError) {
            finishPaused(classifyError(callbackError));
          }
        });
      } catch (error) {
        running = false;
        finishPaused(classifyError(error));
      }
    });
  }

  function tick() {
    let current = status();
    if (current.state === 'ACTIVE'
      && (current.scheduler_registered !== (options.schedulerRegistered === true)
        || current.server_registered !== (options.schedulerRegistered === true && options.serverRegistered === true))) {
      current = save({
        ...current,
        scheduler_registered: options.schedulerRegistered === true,
        server_registered: options.schedulerRegistered === true && options.serverRegistered === true,
      });
    }
    if (current.state === 'ACTIVE' && current.next_run_at && new Date(current.next_run_at).getTime() <= Date.now()) {
      runOnce({ invokedBy: 'hermes_scheduler' })
        .catch((error) => logger.error(sanitizeText(error.message || error, 120)))
        .finally(() => {
          if (!schedulerFaulted && status().state === 'ACTIVE') scheduleTick();
          else timer = null;
        });
      return;
    }
    scheduleTick();
  }

  function scheduleTick() {
    if (timer) clearTimer(timer);
    timer = setTimer(tick, pollIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    const current = status();
    if (schedulerFaulted) return current;
    if (current.state === 'ACTIVE') save({
      ...current,
      scheduler_registered: options.schedulerRegistered === true,
      server_registered: options.schedulerRegistered === true && options.serverRegistered === true,
    });
    scheduleTick();
    return status();
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
    const current = status();
    return current.state === 'ACTIVE'
      ? save({ ...current, scheduler_registered: false, server_registered: false })
      : current;
  }

  return { statePath, status, prepareDisabled, enforceDormantOwnership, activate, pause, runOnce, start, stop, tick, buildCommand: () => buildCommand(options) };
}

async function cli(argv = process.argv.slice(2), options = {}) {
  const action = argv[0] || 'status';
  if (new Set(['activate', 'run-once', 'start']).has(action)) {
    readDormantAdaptiveTaskState(options.adaptiveStatePath || ADAPTIVE_TASK_STATE_PATH);
  }
  const task = createKisPredictionV2ValidationTask(options);
  let result;
  if (action === 'prepare-disabled') result = task.prepareDisabled();
  else if (action === 'activate') result = task.activate({ invokedBy: 'hermes_cli' });
  else if (action === 'pause') result = task.pause(argv[1] || 'operator_pause');
  else if (action === 'run-once') result = await task.runOnce({ invokedBy: 'hermes_cli' });
  else if (action === 'start') result = task.start();
  else if (action === 'stop') result = task.stop();
  else if (action === 'command') result = task.buildCommand();
  else result = task.status();
  if (options.writeOutput !== false) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  cli().catch((error) => {
    process.stderr.write(`${sanitizeText(error.message || error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  TASK_ID,
  TASK_NAME,
  TASK_OWNER,
  TASK_STATE,
  KIS_REPO,
  KIS_APPROVAL,
  VPS_MOCK_DB_PATH,
  PROD_DB_PATH,
  MAX_DISTINCT_TRADING_DAYS,
  MAX_CONCURRENT_RUNS,
  RETRY_ON_FAILURE,
  TIMEZONE,
  SCHEDULE_RRULE,
  DEFAULT_STATE_PATH,
  LEGACY_TASK_STATE_PATH,
  ADAPTIVE_TASK_STATE_PATH,
  SCHEDULER_CUTOVER_LOCK_PATH,
  LEGACY_KIS_RUN_LOCK_PATH,
  HERMES_RUN_LOCK_PATH,
  ALLOWED_ACTIONS,
  SAFE_OUTPUT_KEYS,
  parseKisV2CliOutput,
  mapSummaryToTaskState,
  nextRunAt,
  buildCommand,
  readDormantAdaptiveTaskState,
  createKisPredictionV2ValidationTask,
  cli,
};
