'use strict';

const { execFile: defaultExecFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TASK_ID = 'kis-prediction-validation-cycle';
const TASK_NAME = 'KIS Prediction Validation Cycle';
const TASK_OWNER = 'hermes';
const TIMEZONE = 'Asia/Seoul';
const SCHEDULE_RRULE = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=16;BYMINUTE=10;BYSECOND=0';
const KIS_REPO = '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab';
const KIS_APPROVAL = 'APPROVE_KIS_CODEX_PREDICTION_VALIDATION_AUTOMATION_V1';
const VPS_DB_PATH = '/var/lib/kis-trading-lab/kis-vps.sqlite3';
const PROD_DB_PATH = '/var/lib/kis-trading-lab/kis-prod.sqlite3';
const DEFAULT_STATE_PATH = '/home/ubuntu/.hermes/state/kis-prediction-validation-cycle.json';
const POLL_INTERVAL_MS = 60_000;
const PROGRESS_TARGET_CHANNEL_ID = '1512691418605420634';
const PROGRESS_DELIVERY_LAYER = 'discord_relay';
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
  'executed',
  'action_type',
  'prediction_horizon',
  'target_definition',
  'timezone',
  'prediction_window',
  'reconciliation_window',
  'schedule_rrule',
  'max_distinct_trading_days',
  'market_data_api_calls',
  'market_rows_inserted',
  'predictions_inserted',
  'prediction_duplicates_skipped',
  'outcomes_resolved',
  'outcome_rows_inserted',
  'outcome_duplicates_skipped',
  'idempotent_no_op',
  'automation_run_inserted',
  'distinct_trading_days',
  'total_predictions',
  'resolved_predictions',
  'correct_predictions',
  'incorrect_predictions',
  'neutral_predictions',
  'not_evaluable_predictions',
  'pending_predictions',
  'paper_trade_count',
  'live_trade_count',
  'sample_status',
  'automation_paused',
  'prod_db_touched',
  'order_attempted',
  'cron_changed',
  'secret_exposed',
  'raw_response_persisted',
  'new_nonessential_features',
  'kill_switch_status',
  'lock_status',
  'fail_closed',
  'error_class',
  'status',
]);
const BOOLEAN_KEYS = new Set(['executed', 'idempotent_no_op', 'automation_paused', 'prod_db_touched', 'order_attempted', 'cron_changed', 'secret_exposed', 'raw_response_persisted', 'new_nonessential_features', 'fail_closed']);
const NUMBER_KEYS = new Set(['max_distinct_trading_days', 'market_data_api_calls', 'market_rows_inserted', 'predictions_inserted', 'prediction_duplicates_skipped', 'outcomes_resolved', 'outcome_rows_inserted', 'outcome_duplicates_skipped', 'automation_run_inserted', 'distinct_trading_days', 'total_predictions', 'resolved_predictions', 'correct_predictions', 'incorrect_predictions', 'neutral_predictions', 'not_evaluable_predictions', 'pending_predictions', 'paper_trade_count', 'live_trade_count']);
const SECRET_LIKE_RE = /(Bearer\s+[A-Za-z0-9._-]+|app[_-]?secret|app[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client_secret|[A-Za-z0-9+/]{64,}={0,2})/ig;

function nowIso(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sanitizeText(value, maxLength = 160) {
  return String(value ?? '')
    .replace(SECRET_LIKE_RE, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function boolValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function numberValue(value) {
  const parsed = Number(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseKisCliOutput(stdout) {
  const result = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!SAFE_OUTPUT_KEYS.has(key)) continue;
    const raw = line.slice(index + 1).trim();
    if (BOOLEAN_KEYS.has(key)) result[key] = boolValue(raw);
    else if (NUMBER_KEYS.has(key)) result[key] = numberValue(raw);
    else result[key] = sanitizeText(raw);
  }
  return result;
}

function classifyError(error) {
  const text = String(error && (error.code || error.message || error) || '').toLowerCase();
  if (/timeout|timedout/.test(text)) return 'timeout';
  if (/enoent|not found|missing/.test(text)) return 'missing_dependency';
  if (/permission|denied|forbidden|unauthorized/.test(text)) return 'permission';
  return 'client_error';
}

function mapSummaryToTaskState(summary) {
  const distinctDays = Number(summary.distinct_trading_days || 0);
  const status = String(summary.status || '').toLowerCase();
  const errorClass = String(summary.error_class || '').toLowerCase();
  const failClosed = summary.fail_closed === true || String(summary.fail_closed).toLowerCase() === 'true';
  if (distinctDays >= 20 || errorClass === 'minimum_reached') return { state: 'COMPLETED', reason: 'minimum_distinct_trading_days_reached' };
  if (failClosed || ['paused', 'blocked', 'fail', 'failed', 'error'].includes(status)) {
    return { state: 'PAUSED', reason: errorClass || status || 'fail_closed' };
  }
  return { state: 'ACTIVE', reason: 'last_run_success' };
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
    state: 'DISABLED',
    timezone: TIMEZONE,
    schedule: SCHEDULE_RRULE,
    next_run_at: null,
    max_distinct_trading_days: 20,
    max_prediction_batches_per_trade_date: 1,
    pause_on_failure: true,
    retry_on_failure: false,
    max_concurrent_runs: 1,
    orders_enabled: false,
    os_cron_used: false,
    created_at: createdAt,
    updated_at: createdAt,
    last_run: null,
    progress_notifications: normalizeProgressNotifications(overrides.progress_notifications),
    ...overrides,
  };
  state.progress_notifications = normalizeProgressNotifications(state.progress_notifications);
  return state;
}

function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return defaultState(parsed);
  } catch {
    return defaultState();
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify({ ...state, updated_at: nowIso() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function safeLastRun(summary, overrides = {}) {
  const safe = {};
  for (const key of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(summary, key)) safe[key] = summary[key];
  }
  return { ...safe, ...overrides };
}

function buildCommand(config = {}) {
  const targetDbPath = config.targetDbPath || VPS_DB_PATH;
  if (targetDbPath === PROD_DB_PATH) throw new Error('prod_db_path_blocked');
  return {
    command: config.python || 'python3',
    args: ['-m', 'kis_trading_lab', 'prediction-validation-auto-once', '--approval', KIS_APPROVAL],
    cwd: config.kisRepo || KIS_REPO,
  };
}

function activeSchedulerCount({ codexTaskState = 'PAUSED', hermesTaskState = 'DISABLED' } = {}) {
  const codexActive = String(codexTaskState).toUpperCase() === 'ACTIVE' ? 1 : 0;
  const hermesActive = String(hermesTaskState).toUpperCase() === 'ACTIVE' ? 1 : 0;
  return {
    active_scheduler_count: codexActive + hermesActive,
    duplicate_scheduler_detected: codexActive + hermesActive > 1,
  };
}

function normalizeProgressNotifications(value = {}) {
  const normalized = value && typeof value === 'object' ? value : {};
  const sentKeys = normalized.sent_keys && typeof normalized.sent_keys === 'object' ? normalized.sent_keys : {};
  return {
    sent_keys: sentKeys,
    last_distinct_trading_days: Number(normalized.last_distinct_trading_days || 0),
    last_task_state: sanitizeText(normalized.last_task_state || '', 40),
    last_delivery: normalized.last_delivery && typeof normalized.last_delivery === 'object' ? normalized.last_delivery : null,
  };
}

function progressTaskState(state, distinctTradingDays) {
  const taskState = String(state?.state || '').toUpperCase();
  if (distinctTradingDays >= 20 || taskState === 'COMPLETED') return 'COMPLETED';
  if (taskState === 'PAUSED') return 'PAUSED';
  return 'ACTIVE';
}

function progressStatusLabel(taskState) {
  if (taskState === 'COMPLETED') return '\ucd5c\uc18c \uac80\uc99d \uc644\ub8cc';
  if (taskState === 'PAUSED') return '\ubcf4\ud638 \uc911\ub2e8';
  return '\ud45c\ubcf8 \uc218\uc9d1 \uc911';
}

function nonNegativeInteger(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

function progressSummaryCounts(summary = {}) {
  const totalPredictions = nonNegativeInteger(summary.total_predictions);
  const resolvedPredictions = nonNegativeInteger(summary.resolved_predictions);
  const correctPredictions = nonNegativeInteger(summary.correct_predictions);
  const incorrectPredictions = nonNegativeInteger(summary.incorrect_predictions);
  const neutralPredictions = nonNegativeInteger(summary.neutral_predictions);
  const pendingPredictions = totalPredictions >= resolvedPredictions
    ? totalPredictions - resolvedPredictions
    : nonNegativeInteger(summary.pending_predictions);
  return {
    totalPredictions,
    resolvedPredictions,
    correctPredictions,
    incorrectPredictions,
    neutralPredictions,
    pendingPredictions,
    paperTradeCount: nonNegativeInteger(summary.paper_trade_count),
  };
}

function progressTradeLabel(counts) {
  if (counts.paperTradeCount > 0) return `\ubaa8\uc758 ${counts.paperTradeCount}\uac74 \u00b7 \uc2e4\uc804 \uac70\ub798 \uc5c6\uc74c`;
  return '\uac70\ub798 \uc5c6\uc74c';
}

function buildProgressSummaryLine(summary = {}) {
  const counts = progressSummaryCounts(summary);
  return `\uc694\uc57d: \uc608\uce21 ${counts.totalPredictions}\uac74 \u00b7 \ub300\uc870 ${counts.resolvedPredictions}\uac74(\uc815\ub2f5 ${counts.correctPredictions}/\uc624\ub2f5 ${counts.incorrectPredictions}/\uc911\ub9bd ${counts.neutralPredictions}) \u00b7 \ub300\uae30 ${counts.pendingPredictions}\uac74 \u00b7 ${progressTradeLabel(counts)}`;
}

function buildProgressMessage({ distinctTradingDays, taskState, summary = {} }) {
  const day = Math.max(0, Math.min(20, Number(distinctTradingDays || 0)));
  return [
    '[KIS \uc608\uce21 \uac80\uc99d]',
    `\uc9c4\ud589: ${day}/20 \uac70\ub798\uc77c`,
    `\uc0c1\ud0dc: ${progressStatusLabel(taskState)}`,
    buildProgressSummaryLine(summary),
  ].join('\n');
}

function progressIdempotencyKey({ taskId = TASK_ID, distinctTradingDays, taskState }) {
  return `kis_prediction_progress:${taskId}:${Number(distinctTradingDays || 0)}:${String(taskState || 'ACTIVE').toUpperCase()}`;
}

function progressCandidate(previousState = {}, nextState = {}, options = {}) {
  const progress = normalizeProgressNotifications(nextState.progress_notifications);
  const lastRun = nextState.last_run || previousState.last_run || {};
  const distinctTradingDays = Number(lastRun.distinct_trading_days || progress.last_distinct_trading_days || 0);
  if (!Number.isFinite(distinctTradingDays) || distinctTradingDays <= 0) return null;

  const taskState = progressTaskState(nextState, distinctTradingDays);
  const key = progressIdempotencyKey({ distinctTradingDays, taskState });
  if (progress.sent_keys[key]) {
    return { duplicate: true, key, distinctTradingDays, taskState };
  }

  const previousDistinct = Number(previousState.last_run?.distinct_trading_days || progress.last_distinct_trading_days || 0);
  const previousTaskState = progressTaskState(previousState, previousDistinct);
  const dayIncreased = distinctTradingDays > Number(progress.last_distinct_trading_days || 0);
  const stateTransition = previousTaskState !== taskState && ['PAUSED', 'COMPLETED'].includes(taskState);
  if (!options.forceCurrent && !dayIncreased && !stateTransition) return null;

  return {
    key,
    distinctTradingDays,
    taskState,
    content: buildProgressMessage({ distinctTradingDays, taskState, summary: lastRun }),
  };
}

async function applyProgressNotification(previousState, nextState, options = {}) {
  const candidate = progressCandidate(previousState, nextState, options);
  if (!candidate) return nextState;

  const progress = normalizeProgressNotifications(nextState.progress_notifications);
  const delivery = {
    key: candidate.key,
    target_channel_id: PROGRESS_TARGET_CHANNEL_ID,
    distinct_trading_days: candidate.distinctTradingDays,
    task_state: candidate.taskState,
    duplicate_skipped: Boolean(candidate.duplicate),
    send_attempt_count: 0,
    discord_sent: false,
    error_class: candidate.duplicate ? 'duplicate_skipped' : 'not_attempted',
    invoked_by: sanitizeText(options.invokedBy || '', 60),
    attempted_at: nowIso(),
  };

  if (candidate.duplicate) {
    return { ...nextState, progress_notifications: { ...progress, last_delivery: delivery } };
  }

  if (typeof options.progressSender !== 'function') {
    delivery.error_class = 'sender_missing';
    return { ...nextState, progress_notifications: { ...progress, last_delivery: delivery } };
  }

  delivery.send_attempt_count = 1;
  try {
    const result = await options.progressSender({
      targetChannelId: PROGRESS_TARGET_CHANNEL_ID,
      content: candidate.content,
      deliveryLayer: PROGRESS_DELIVERY_LAYER,
      idempotencyKey: candidate.key,
    });
    delivery.discord_sent = Boolean(result && result.discord_sent);
    delivery.error_class = delivery.discord_sent ? 'none' : sanitizeText(result?.error_class || 'discord_send_failed', 80);
  } catch {
    delivery.discord_sent = false;
    delivery.error_class = 'discord_send_failed';
  }

  if (delivery.discord_sent) {
    progress.sent_keys[candidate.key] = delivery.attempted_at;
    progress.last_distinct_trading_days = Math.max(Number(progress.last_distinct_trading_days || 0), candidate.distinctTradingDays);
    progress.last_task_state = candidate.taskState;
  }
  progress.last_delivery = delivery;
  return { ...nextState, progress_notifications: progress };
}

function createKisPredictionValidationTask(options = {}) {
  const statePath = options.statePath || process.env.KIS_PREDICTION_TASK_STATE_PATH || DEFAULT_STATE_PATH;
  const execFile = options.execFile || defaultExecFile;
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const pollIntervalMs = Number(options.pollIntervalMs || POLL_INTERVAL_MS);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let running = false;
  let timer = null;

  function save(next) {
    const normalized = { ...next, progress_notifications: normalizeProgressNotifications(next.progress_notifications) };
    writeState(statePath, normalized);
    return normalized;
  }

  async function saveWithProgressNotification(previousState, nextState, opts = {}) {
    const saved = save(nextState);
    const notified = await applyProgressNotification(previousState, saved, { ...opts, progressSender: options.progressSender });
    return notified === saved ? saved : save(notified);
  }

  function status() {
    return readState(statePath);
  }

  function prepareDisabled() {
    return save(defaultState({ state: 'DISABLED', next_run_at: null, last_run: null }));
  }

  function notifyCurrentProgress({ invokedBy = 'hermes_current_status' } = {}) {
    const current = status();
    return saveWithProgressNotification(current, current, { forceCurrent: true, invokedBy });
  }

  function activate() {
    const current = status();
    return save({ ...current, state: 'ACTIVE', next_run_at: current.next_run_at || nextRunAt() });
  }

  function pause(reason = 'operator_pause') {
    const current = status();
    return save({ ...current, state: 'PAUSED', pause_reason: sanitizeText(reason, 80), next_run_at: null });
  }

  function complete(reason = 'minimum_reached') {
    const current = status();
    return save({ ...current, state: 'COMPLETED', completion_reason: sanitizeText(reason, 80), next_run_at: null });
  }

  function runOnce({ invokedBy = 'hermes', force = true } = {}) {
    const current = status();
    if (!force && current.state !== 'ACTIVE') {
      return Promise.resolve({ ...current, last_run: { status: 'skipped', error_class: 'task_not_active' } });
    }
    if (running) {
      const lastRun = { status: 'skipped', action_type: 'idempotent_no_op', error_class: 'previous_run_active', duplicate_execution_prevented: true, invoked_by: invokedBy, completed_at: nowIso() };
      return Promise.resolve(save({ ...current, last_run: lastRun }));
    }

    let commandSpec;
    try {
      commandSpec = buildCommand(options);
    } catch (error) {
      const lastRun = { status: 'paused', action_type: 'paused', fail_closed: true, error_class: sanitizeText(error.message, 80), invoked_by: invokedBy, completed_at: nowIso() };
      return saveWithProgressNotification(current, { ...current, state: 'PAUSED', pause_reason: lastRun.error_class, last_run: lastRun, next_run_at: null }, { invokedBy });
    }

    running = true;
    const startedAt = nowIso();
    return new Promise((resolve) => {
      execFile(commandSpec.command, commandSpec.args, {
        cwd: commandSpec.cwd,
        env: process.env,
        timeout: Number(options.execTimeoutMs || EXEC_TIMEOUT_MS),
        maxBuffer: Number(options.maxBuffer || MAX_BUFFER_BYTES),
      }, (error, stdout) => {
        running = false;
        const completedAt = nowIso();
        if (error) {
          const errorClass = classifyError(error);
          const lastRun = { status: 'paused', action_type: 'paused', fail_closed: true, error_class: errorClass, invoked_by: invokedBy, started_at: startedAt, completed_at: completedAt };
          saveWithProgressNotification(current, { ...status(), state: 'PAUSED', pause_reason: errorClass, last_run: lastRun, next_run_at: null }, { invokedBy }).then(resolve);
          return;
        }
        const parsed = parseKisCliOutput(stdout);
        const mapped = mapSummaryToTaskState(parsed);
        const lastRun = safeLastRun(parsed, { invoked_by: invokedBy, started_at: startedAt, completed_at: completedAt });
        const next = {
          ...status(),
          state: mapped.state,
          pause_reason: mapped.state === 'PAUSED' ? mapped.reason : undefined,
          completion_reason: mapped.state === 'COMPLETED' ? mapped.reason : undefined,
          next_run_at: mapped.state === 'ACTIVE' ? nextRunAt() : null,
          last_run: lastRun,
        };
        saveWithProgressNotification(current, next, { invokedBy }).then(resolve);
      });
    });
  }

  function tick() {
    const current = status();
    const now = new Date();
    if (current.state === 'ACTIVE' && current.next_run_at && new Date(current.next_run_at).getTime() <= now.getTime()) {
      runOnce({ invokedBy: 'hermes_scheduler', force: false }).catch((error) => {
        logger.error(`kis prediction task failed: ${sanitizeText(error.message || error, 120)}`);
      }).finally(scheduleTick);
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
    scheduleTick();
    return status();
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
    return status();
  }

  return { statePath, status, prepareDisabled, activate, pause, complete, notifyCurrentProgress, runOnce, start, stop, buildCommand: () => buildCommand(options) };
}

let defaultTask = null;
function startDefaultScheduler(options = {}) {
  if (!defaultTask) defaultTask = createKisPredictionValidationTask(options);
  defaultTask.start();
  return defaultTask.status();
}

async function cli(argv = process.argv.slice(2)) {
  const action = argv[0] || 'status';
  const task = createKisPredictionValidationTask();
  let result;
  if (action === 'prepare-disabled') result = task.prepareDisabled();
  else if (action === 'activate') result = task.activate();
  else if (action === 'pause') result = task.pause(argv[1] || 'operator_pause');
  else if (action === 'complete') result = task.complete(argv[1] || 'minimum_reached');
  else if (action === 'notify-current') result = await task.notifyCurrentProgress({ invokedBy: 'hermes_cli' });
  else if (action === 'run-once') result = await task.runOnce({ invokedBy: 'hermes_cli', force: true });
  else if (action === 'command') result = task.buildCommand();
  else result = task.status();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  TIMEZONE,
  SCHEDULE_RRULE,
  KIS_REPO,
  KIS_APPROVAL,
  VPS_DB_PATH,
  PROD_DB_PATH,
  DEFAULT_STATE_PATH,
  parseKisCliOutput,
  mapSummaryToTaskState,
  nextRunAt,
  PROGRESS_TARGET_CHANNEL_ID,
  PROGRESS_DELIVERY_LAYER,
  buildProgressMessage,
  buildProgressSummaryLine,
  progressSummaryCounts,
  progressIdempotencyKey,
  progressCandidate,
  buildCommand,
  activeSchedulerCount,
  createKisPredictionValidationTask,
  startDefaultScheduler,
};
