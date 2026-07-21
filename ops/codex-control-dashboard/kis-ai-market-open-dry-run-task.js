'use strict';

const { execFile: defaultExecFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ACTIVATION_APPROVAL = 'APPROVE_KIS_HERMES_AI_MARKET_OPEN_DRY_RUN_V1';
const KIS_REPO = '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab';
const VPS_DB_PATH = '/var/lib/kis-trading-lab/kis-vps.sqlite3';
const STRATEGY_MANIFEST = 'config/adaptive_ai_dry_run_strategy_v1.json';
const DEFAULT_STATE_PATH = '/home/ubuntu/.hermes/state/kis-ai-market-open-dry-run-v1.json';
const LEGACY_V1_STATE_PATH = '/home/ubuntu/.hermes/state/kis-prediction-validation-cycle.json';
const LEGACY_V2_STATE_PATH = '/home/ubuntu/.hermes/state/kis-prediction-validation-cycle-v2.json';
const LEGACY_V1_RUN_LOCK_PATH = '/tmp/kis-trading-lab-prediction-validation-auto.lock';
const LEGACY_V2_RUN_LOCK_PATH = '/tmp/kis-prediction-validation-cycle-v2-hermes.lock';
const DEFAULT_RUN_LOCK_PATH = '/tmp/kis-ai-market-open-dry-run-hermes.lock';
const REPORT_TARGET_CHANNEL_ID = '1512691418605420634';
const POLL_INTERVAL_MS = 60_000;
const EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER_BYTES = 64 * 1024;
const TIMEZONE = 'Asia/Seoul';
const TASKS = Object.freeze([
  { id: 'kis-ai-market-open-supervisor-v1', schedule: 'weekdays 09:00 KST', minutes: [540] },
  { id: 'kis-ai-intraday-shadow-validation-v1', schedule: 'weekdays 09:10-14:50 KST every 10m', minutes: Array.from({ length: 35 }, (_, i) => 550 + (i * 10)) },
  { id: 'kis-ai-post-close-learning-v1', schedule: 'weekdays 15:40 KST', minutes: [940] },
  { id: 'kis-ai-daily-learning-report-v1', schedule: 'weekdays 16:30 KST', minutes: [990] },
]);
const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));
const ACTIVE_STATUSES = new Set(['success', 'no_op', 'waiting', 'report_ready']);
const ALL_STATUSES = new Set([...ACTIVE_STATUSES, 'blocked']);
const OUTPUT_KEYS = new Set([
  'task_id', 'status', 'action_type', 'official_trade_date', 'official_session_state',
  'api_calls', 'quote_api_calls',
  'decisions', 'simulated_orders', 'simulated_positions', 'experience_rows', 'incidents',
  'outbox_rows', 'challenger_trained', 'champion_changed', 'order_api_calls',
  'vps_live_orders', 'prod_orders', 'raw_response_persisted', 'secret_exposure', 'retry',
  'catch_up', 'backfill', 'fail_closed', 'error_class', 'report_message',
]);
const COUNT_KEYS = new Set([
  'api_calls', 'quote_api_calls', 'decisions', 'simulated_orders', 'simulated_positions',
  'experience_rows', 'incidents', 'outbox_rows', 'order_api_calls', 'vps_live_orders', 'prod_orders',
]);
const BOOLEAN_KEYS = new Set([
  'challenger_trained', 'champion_changed', 'raw_response_persisted', 'secret_exposure',
  'retry', 'catch_up', 'backfill', 'fail_closed',
]);
const SECRET_LIKE_RE = /(Bearer\s+[A-Za-z0-9._-]+|app[_-]?secret|app[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client_secret)/i;

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

function parseKisAiMarketOpenOutput(stdout, expectedTaskId) {
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
  if (value.order_api_calls !== 0 || value.vps_live_orders !== 0 || value.prod_orders !== 0
    || value.champion_changed !== false || value.raw_response_persisted !== false
    || value.secret_exposure !== false || value.retry !== false || value.catch_up !== false
    || value.backfill !== false || value.quote_api_calls > 3) throw new Error('unsafe_output');
  const blocked = value.status === 'blocked';
  if (value.fail_closed !== blocked || (blocked ? value.error_class === 'none' : value.error_class !== 'none')) throw new Error('invalid_fail_closed_contract');
  const marketClosed = value.action_type === 'market_closed_no_op';
  if (marketClosed !== (value.official_session_state === 'closed')
    || (!blocked && !marketClosed && value.official_session_state !== 'regular_session')
    || (value.official_session_state !== 'unknown' && value.official_trade_date === null)) {
    throw new Error('official_calendar_contract_invalid');
  }
  let reportMessage = null;
  if (value.status === 'report_ready') reportMessage = validateReportMessage(value.report_message);
  else if (value.report_message !== null) throw new Error('unexpected_report_message');
  return Object.freeze({
    status: value.status, failClosed: value.fail_closed, reportMessage,
    officialTradeDate: value.official_trade_date, actionType: safeText(value.action_type, 60),
    errorClass: safeText(value.error_class, 80),
  });
}

function buildCommand(taskId, { activationPreflight = false } = {}) {
  if (!TASK_BY_ID.has(taskId)) throw new Error('unknown_task_id');
  const args = ['-m', 'kis_trading_lab', 'ai-market-open-dry-run-once', '--approval', ACTIVATION_APPROVAL, '--task-id', taskId, '--strategy-manifest', STRATEGY_MANIFEST, '--db', VPS_DB_PATH];
  if (activationPreflight) args.push('--activation-preflight');
  return { command: 'python3', args, cwd: KIS_REPO };
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
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
}

function acquireExclusiveLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, 'kis_ai_market_open_dry_run_lock\n', 'utf8'); fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw new Error(error.code === 'EEXIST' ? 'scheduler_lock_active' : 'scheduler_lock_failed');
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
  const execFile = options.execFile || defaultExecFile;
  const now = options.now || (() => new Date());
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const runtimeHealthCheck = options.runtimeHealthCheck || defaultRuntimeHealthCheck;
  const reportSender = options.reportSender || null;
  const schedulerRegistered = options.schedulerRegistered === true;
  const serverRegistered = options.serverRegistered === true;
  const execTimeoutMs = Math.min(Number(options.execTimeoutMs || EXEC_TIMEOUT_MS), EXEC_TIMEOUT_MS);
  const maxBuffer = Math.min(Number(options.maxBuffer || MAX_BUFFER_BYTES), MAX_BUFFER_BYTES);
  let timer = null;
  let ticking = false;
  let schedulerFaulted = false;

  function disabledState() {
    return { state: 'DISABLED', activation_approval: ACTIVATION_APPROVAL, timezone: TIMEZONE, state_path: statePath, max_concurrent_runs: 1, retry: false, catch_up: false, backfill: false, os_cron_used: false, scheduler_registered: false, server_registered: false, tasks: Object.fromEntries(TASKS.map((task) => [task.id, { state: 'DISABLED', schedule: task.schedule, next_run_at: null, last_due_at: null, last_run: null }])) };
  }
  function loadStrict() {
    try {
      const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || !value.tasks
        || TASKS.some((task) => !value.tasks[task.id])) throw new Error('state_contract_invalid');
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
  function pauseAll(current, taskId, reason, lastRun) {
    if (timer) clearTimer(timer); timer = null;
    const tasks = Object.fromEntries(TASKS.map((task) => {
      const item = current.tasks[task.id];
      return [task.id, { ...item, state: 'PAUSED', pause_reason: task.id === taskId ? reason : 'peer_task_fail_closed', next_run_at: null, last_run: task.id === taskId ? lastRun : item.last_run }];
    }));
    return save({ ...current, state: 'PAUSED', pause_reason: reason, scheduler_registered: false, server_registered: false, tasks });
  }
  function execute(command) {
    return new Promise((resolve) => {
      execFile(command.command, command.args, { cwd: command.cwd, env: process.env, timeout: execTimeoutMs, maxBuffer }, (error, stdout) => resolve({ error, stdout }));
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
      const parsed = parseKisAiMarketOpenOutput(stdout, TASKS[0].id);
      if (parsed.status !== 'success' || parsed.failClosed || parsed.actionType !== 'activation_preflight') throw new Error('activation_preflight_failed');
      const activatedAt = now();
      const tasks = Object.fromEntries(TASKS.map((task) => [task.id, { ...(current.tasks[task.id] || {}), state: 'ACTIVE', schedule: task.schedule, next_run_at: nextRunAt(task, activatedAt), last_due_at: current.tasks[task.id]?.last_due_at || null, last_run: task.id === TASKS[0].id ? { status: 'success', action_type: 'activation_preflight', fail_closed: false, invoked_by: safeText(invokedBy), completed_at: activatedAt.toISOString() } : current.tasks[task.id]?.last_run || null }]));
      return save({ ...current, state: 'ACTIVE', activated_at: activatedAt.toISOString(), activated_by: safeText(invokedBy), scheduler_registered: false, server_registered: false, tasks });
    } finally { if (release) release(); }
  }
  function withRegistration(current) {
    if (current.state !== 'ACTIVE') return current;
    return { ...current, scheduler_registered: Boolean(timer) && schedulerRegistered, server_registered: Boolean(timer) && schedulerRegistered && serverRegistered };
  }
  async function runOnce({ taskId, invokedBy = 'hermes_scheduler', dueAt = now() } = {}) {
    if (!TASK_BY_ID.has(taskId)) throw new Error('unknown_task_id');
    const current = loadStrict(); const taskState = current.tasks[taskId]; const task = TASK_BY_ID.get(taskId);
    if (current.state !== 'ACTIVE' || taskState.state !== 'ACTIVE') return current;
    const dueTime = dueAt instanceof Date ? dueAt : new Date(dueAt);
    if (Number.isNaN(dueTime.getTime())) return pauseAll(current, taskId, 'due_time_invalid', { error_class: 'due_time_invalid', fail_closed: true });
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
      return pauseAll(current, taskId, safeText(error.message, 80), { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), error_class: safeText(error.message, 80), fail_closed: true });
    }
    const key = dueKey(task, dueTime);
    const reserved = save({ ...current, tasks: { ...current.tasks, [taskId]: { ...taskState, last_due_at: key, next_run_at: nextRunAt(task, dueTime) } } });
    const command = buildCommand(taskId);
    try {
      const { error, stdout } = await execute(command);
      if (error && Number(error.code) !== 2) return pauseAll(loadStrict(), taskId, error.killed ? 'timeout' : 'process_error', { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), error_class: error.killed ? 'timeout' : 'process_error', fail_closed: true });
      let parsed;
      try { parsed = parseKisAiMarketOpenOutput(stdout, taskId); }
      catch (parseError) { return pauseAll(loadStrict(), taskId, safeText(parseError.message, 80), { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), error_class: 'invalid_safety_output', fail_closed: true }); }
      const latest = loadStrict(); const latestTask = latest.tasks[taskId];
      const lastRun = { invoked_by: safeText(invokedBy), started_at: startedAt, completed_at: now().toISOString(), status: parsed.status, fail_closed: parsed.failClosed, official_trade_date: parsed.officialTradeDate, action_type: parsed.actionType, error_class: parsed.errorClass };
      if (parsed.status === 'blocked' || parsed.failClosed || error) return pauseAll(latest, taskId, parsed.errorClass || 'blocked', lastRun);
      if (parsed.status === 'report_ready') {
        if (typeof reportSender !== 'function') return pauseAll(latest, taskId, 'report_sender_missing', { ...lastRun, delivery_attempted: false });
        let delivery;
        try { delivery = await reportSender({ targetChannelId: REPORT_TARGET_CHANNEL_ID, content: parsed.reportMessage, deliveryLayer: 'hermes_ai_market_open_dry_run' }); }
        catch { return pauseAll(loadStrict(), taskId, 'report_delivery_failed', { ...lastRun, delivery_attempted: true, delivery_succeeded: false }); }
        if (delivery?.discord_sent !== true) return pauseAll(loadStrict(), taskId, safeText(delivery?.error_class || 'report_delivery_failed'), { ...lastRun, delivery_attempted: true, delivery_succeeded: false });
        lastRun.status = 'report_sent'; lastRun.delivery_attempted = true; lastRun.delivery_succeeded = true;
      }
      return save({ ...latest, tasks: { ...latest.tasks, [taskId]: { ...latestTask, state: 'ACTIVE', pause_reason: undefined, last_run: lastRun } } });
    } finally { if (release) release(); }
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
    timer = setTimer(() => { tick().finally(() => { if (!schedulerFaulted && status().state === 'ACTIVE') schedule(); }); }, POLL_INTERVAL_MS);
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
  return { statePath, status, prepareDisabled, activate, runOnce, start, stop, tick, buildCommand };
}

async function cli(argv = process.argv.slice(2)) {
  const task = createKisAiMarketOpenDryRunTask(); const action = argv[0] || 'status';
  const result = action === 'prepare-disabled' ? task.prepareDisabled()
    : action === 'activate' ? await task.activate({ approval: argv[2], invokedBy: 'hermes_cli' })
    : action === 'status' ? task.status()
    : action === 'start' ? task.start()
    : action === 'stop' ? task.stop()
    : action === 'tick' ? await task.tick()
    : action === 'run-once' ? await task.runOnce({ taskId: argv[1], invokedBy: 'hermes_cli' }) : (() => { throw new Error('unknown_action'); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (require.main === module) cli().catch((error) => { process.stderr.write(`${safeText(error.message, 100)}\n`); process.exitCode = 1; });

module.exports = {
  ACTIVATION_APPROVAL, KIS_REPO, VPS_DB_PATH, STRATEGY_MANIFEST, DEFAULT_STATE_PATH,
  LEGACY_V1_STATE_PATH, LEGACY_V2_STATE_PATH, DEFAULT_RUN_LOCK_PATH, REPORT_TARGET_CHANNEL_ID,
  TIMEZONE, POLL_INTERVAL_MS, EXEC_TIMEOUT_MS, MAX_BUFFER_BYTES, TASKS,
  parseKisAiMarketOpenOutput, nextRunAt, buildCommand, createKisAiMarketOpenDryRunTask,
};
