'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const taskModule = require('./kis-prediction-v2-validation-task');

const OUTPUT_KEYS = [
  'status', 'action', 'blocked', 'automation_paused', 'completed', 'db_opened', 'db_written', 'schema_evidence_checked', 'integrity_checked', 'prediction_inserted_count', 'outcome_inserted_count', 'pending_matured_count', 'distinct_decision_day_count', 'api_called', 'order_attempted', 'scheduler_changed', 'cron_changed', 'raw_values_printed', 'executed', 'action_type', 'prediction_horizon', 'target_definition', 'timezone', 'prediction_window', 'reconciliation_window', 'max_distinct_trading_days', 'market_data_api_calls', 'predictions_inserted', 'outcomes_resolved', 'distinct_trading_days', 'total_predictions', 'resolved_predictions', 'correct_predictions', 'incorrect_predictions', 'neutral_predictions', 'pending_predictions', 'paper_trade_count', 'live_trade_count', 'sample_status', 'fail_closed', 'error_class', 'prod_db_touched', 'secret_exposed', 'raw_response_persisted', 'new_nonessential_features',
];

function statePath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kis-v2-')), `${name}.json`);
}

function writeLegacyState(file, state = 'PAUSED') {
  fs.writeFileSync(file, `${JSON.stringify({ state, next_run_at: state === 'PAUSED' ? null : '2026-07-17T07:10:00Z' })}\n`, 'utf8');
  return file;
}

function writeAdaptiveState(file, overrides = {}) {
  fs.writeFileSync(file, `${JSON.stringify({
    canonical_task_id: 'kis-ai-market-open-dry-run-v1',
    task_owner: 'hermes',
    state: 'PAUSED',
    scheduler_registered: false,
    server_registered: false,
    ...overrides,
  })}\n`, 'utf8');
  return file;
}

function output(overrides = {}) {
  const base = {
    status: 'ready', action: 'idempotent_no_op', blocked: false, automation_paused: false, completed: false,
    db_opened: true, db_written: false, schema_evidence_checked: true, integrity_checked: true,
    prediction_inserted_count: 0, outcome_inserted_count: 0, pending_matured_count: 0, distinct_decision_day_count: 1,
    api_called: false, order_attempted: false, scheduler_changed: false, cron_changed: false, raw_values_printed: false,
    executed: true, action_type: 'idempotent_no_op', prediction_horizon: 'next_session',
    target_definition: 'direction_label_next_official_krx_session_from_preregistered_chart_features', timezone: 'Asia/Seoul',
    prediction_window: '15:30-17:50 Asia/Seoul', reconciliation_window: 'after_next_official_session_quote_available',
    max_distinct_trading_days: 20, market_data_api_calls: 0, predictions_inserted: 0, outcomes_resolved: 0,
    distinct_trading_days: 1, total_predictions: 3, resolved_predictions: 0, correct_predictions: 0, incorrect_predictions: 0,
    neutral_predictions: 0, pending_predictions: 3, paper_trade_count: 0, live_trade_count: 0, sample_status: 'ready',
    fail_closed: false, error_class: 'none', prod_db_touched: false, secret_exposed: false, raw_response_persisted: false,
    new_nonessential_features: false,
  };
  return Object.entries({ ...base, ...overrides }).map(([key, value]) => `${key}=${value}`).join('\n');
}

function completedOutput() {
  return output({ status: 'completed', action: 'completed', action_type: 'completed', automation_paused: true, completed: true, distinct_decision_day_count: 20, distinct_trading_days: 20, total_predictions: 60, pending_predictions: 60, sample_status: 'completed' });
}

function blockedFormatterOutput() {
  return output({ status: 'blocked', action: 'paused', action_type: 'paused', blocked: true, automation_paused: true, sample_status: 'blocked', fail_closed: true, error_class: 'blocked' });
}

function withoutKey(text, key) {
  return text.split('\n').filter((line) => !line.startsWith(`${key}=`)).join('\n');
}

function activeTask(extra = {}) {
  const legacyStatePath = extra.legacyStatePath || writeLegacyState(statePath('legacy'));
  const task = taskModule.createKisPredictionV2ValidationTask({
    statePath: statePath('state'),
    legacyStatePath,
    cutoverLockPath: extra.cutoverLockPath || statePath('cutover.lock'),
    legacyRunLockPath: extra.legacyRunLockPath || statePath('legacy-run.lock'),
    runLockPath: extra.runLockPath || statePath('run.lock'),
    ...extra,
  });
  task.prepareDisabled();
  task.activate({ invokedBy: 'test' });
  return task;
}

test('strict 45-key contract uses canonical v2 task and target values', () => {
  assert.equal(taskModule.TASK_ID, 'kis-prediction-validation-cycle-v2');
  assert.equal(OUTPUT_KEYS.length, 45);
  assert.equal(taskModule.SAFE_OUTPUT_KEYS.size, 45);
  const parsed = taskModule.parseKisV2CliOutput(output());
  assert.deepEqual(Object.keys(parsed).sort(), [...OUTPUT_KEYS].sort());
  assert.equal(parsed.target_definition, 'direction_label_next_official_krx_session_from_preregistered_chart_features');
  assert.deepEqual(taskModule.mapSummaryToTaskState(parsed), { state: 'ACTIVE', reason: 'last_run_success' });
  assert.deepEqual(taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(blockedFormatterOutput())), { state: 'PAUSED', reason: 'blocked' });
  const duplicate = taskModule.parseKisV2CliOutput(`${output()}\nfail_closed=false`);
  assert.equal(taskModule.mapSummaryToTaskState(duplicate).state, 'PAUSED');
});

test('single strict validator rejects missing, mistyped, unsafe, and inconsistent output', () => {
  for (const key of OUTPUT_KEYS) {
    const parsed = taskModule.parseKisV2CliOutput(withoutKey(output(), key));
    assert.equal(taskModule.mapSummaryToTaskState(parsed).state, 'PAUSED', `missing ${key}`);
  }
  const unsafeOrInconsistent = [
    { prediction_horizon: 'same_session' },
    { target_definition: 'modified_target' },
    { timezone: 'UTC' },
    { prediction_window: '00:00-23:59 Asia/Seoul' },
    { reconciliation_window: 'immediate' },
    { action: 'predict_only', action_type: 'reconcile_only' },
    { total_predictions: 4, pending_predictions: 4 },
    { prediction_inserted_count: 1 },
    { outcome_inserted_count: 1 },
    { distinct_decision_day_count: 2 },
    { pending_predictions: 2 },
    { resolved_predictions: 1 },
    { db_written: true },
    { executed: false },
    { db_opened: false },
    { integrity_checked: false, schema_evidence_checked: false },
    { paper_trade_count: 1 },
    { live_trade_count: 1 },
    { order_attempted: true },
    { scheduler_changed: true },
    { cron_changed: true },
    { raw_values_printed: true },
    { prod_db_touched: true },
    { secret_exposed: true },
    { raw_response_persisted: true },
    { new_nonessential_features: true },
  ];
  for (const fixture of unsafeOrInconsistent) {
    const parsed = taskModule.parseKisV2CliOutput(output(fixture));
    assert.equal(taskModule.mapSummaryToTaskState(parsed).state, 'PAUSED', JSON.stringify(fixture));
  }
  const invalidBoolean = taskModule.parseKisV2CliOutput(output({ fail_closed: 'not-a-boolean' }));
  const invalidNumber = taskModule.parseKisV2CliOutput(output({ distinct_trading_days: 'twenty' }));
  assert.equal(taskModule.mapSummaryToTaskState(invalidBoolean).state, 'PAUSED');
  assert.equal(taskModule.mapSummaryToTaskState(invalidNumber).state, 'PAUSED');
});

test('bounded market-data quotation calls require a matching boolean', () => {
  const accepted = taskModule.parseKisV2CliOutput(output({ api_called: true, market_data_api_calls: 3 }));
  assert.deepEqual(taskModule.mapSummaryToTaskState(accepted), { state: 'ACTIVE', reason: 'last_run_success' });

  for (const fixture of [
    { api_called: true, market_data_api_calls: 0 },
    { api_called: false, market_data_api_calls: 1 },
    { api_called: true, market_data_api_calls: -1 },
    { api_called: true, market_data_api_calls: '1.5' },
    { api_called: true, market_data_api_calls: 4 },
  ]) {
    const parsed = taskModule.parseKisV2CliOutput(output(fixture));
    assert.equal(taskModule.mapSummaryToTaskState(parsed).state, 'PAUSED', JSON.stringify(fixture));
  }
});

test('persistence defaults disabled and writes owner-only state', () => {
  const file = statePath('persist');
  const task = taskModule.createKisPredictionV2ValidationTask({ statePath: file });
  const state = task.prepareDisabled();
  assert.equal(state.state, 'DISABLED');
  assert.equal(state.max_distinct_trading_days, 20);
  assert.equal(state.max_concurrent_runs, 1);
  assert.equal(state.orders_enabled, false);
  assert.equal(state.os_cron_used, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).canonical_task_id, taskModule.TASK_ID);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('activation requires explicitly paused legacy v1 and keeps registration metadata truthful', () => {
  const legacyStatePath = statePath('legacy-activation');
  const options = {
    statePath: statePath('activation'), legacyStatePath,
    cutoverLockPath: statePath('activation-cutover.lock'), legacyRunLockPath: statePath('activation-v1.lock'),
    runLockPath: statePath('activation-v2.lock'), serverRegistered: true, schedulerRegistered: true,
  };
  const task = taskModule.createKisPredictionV2ValidationTask(options);
  task.prepareDisabled();
  writeLegacyState(legacyStatePath, 'ACTIVE');
  assert.throws(() => task.activate(), /legacy_v1_state_must_be_paused/);
  writeLegacyState(legacyStatePath, 'PAUSED');
  const active = task.activate({ invokedBy: 'test' });
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.live_execution_enabled, true);
  assert.equal(active.scheduler_registered, false);
  assert.equal(active.server_registered, false);
});

test('server ownership reconciliation pauses stale active v2 registration', () => {
  const file = statePath('stale-v2');
  const task = taskModule.createKisPredictionV2ValidationTask({ statePath: file });
  task.prepareDisabled();
  const stale = task.status();
  fs.writeFileSync(file, `${JSON.stringify({
    ...stale,
    state: 'ACTIVE',
    next_run_at: '2026-07-23T07:10:00.000Z',
    scheduler_registered: true,
    server_registered: true,
  })}\n`, 'utf8');

  const reconciled = task.enforceDormantOwnership();
  assert.equal(reconciled.state, 'PAUSED');
  assert.equal(reconciled.pause_reason, 'superseded_by_adaptive_scheduler');
  assert.equal(reconciled.next_run_at, null);
  assert.equal(reconciled.scheduler_registered, false);
  assert.equal(reconciled.server_registered, false);
});

test('direct v2 CLI mutating actions require the Adaptive scheduler to be dormant', async () => {
  const adaptiveStatePath = writeAdaptiveState(statePath('adaptive-active'), {
    state: 'ACTIVE', scheduler_registered: true, server_registered: true,
  });
  for (const action of ['activate', 'run-once', 'start']) {
    await assert.rejects(
      taskModule.cli([action], { adaptiveStatePath, writeOutput: false }),
      /adaptive_scheduler_must_be_dormant/,
    );
  }

  writeAdaptiveState(adaptiveStatePath);
  const legacyStatePath = writeLegacyState(statePath('cli-legacy'));
  const result = await taskModule.cli(['activate'], {
    adaptiveStatePath,
    statePath: statePath('cli-state'),
    legacyStatePath,
    cutoverLockPath: statePath('cli-cutover.lock'),
    legacyRunLockPath: statePath('cli-legacy-run.lock'),
    runLockPath: statePath('cli-v2-run.lock'),
    writeOutput: false,
  });
  assert.equal(result.state, 'ACTIVE');
});

test('direct v2 CLI fails closed when Adaptive state is missing or invalid', async () => {
  const missing = statePath('adaptive-missing');
  await assert.rejects(
    taskModule.cli(['start'], { adaptiveStatePath: missing, writeOutput: false }),
    /adaptive_state_unavailable/,
  );

  const invalid = writeAdaptiveState(statePath('adaptive-invalid'), { task_owner: 'unknown' });
  await assert.rejects(
    taskModule.cli(['run-once'], { adaptiveStatePath: invalid, writeOutput: false }),
    /adaptive_scheduler_must_be_dormant/,
  );
});

test('schedule is fixed to Seoul v1 RRULE and start/stop only register while active', () => {
  let scheduled;
  let cleared = 0;
  const task = activeTask({ schedulerRegistered: true, setTimer: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, clearTimer: () => { cleared += 1; } });
  assert.equal(taskModule.TIMEZONE, 'Asia/Seoul');
  assert.equal(taskModule.SCHEDULE_RRULE, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=16;BYMINUTE=10;BYSECOND=0');
  assert.equal(taskModule.nextRunAt(new Date('2026-07-19T00:00:00.000Z')), '2026-07-20T07:10:00.000Z');
  assert.equal(task.start().scheduler_registered, true);
  assert.equal(scheduled.ms, 60_000);
  assert.equal(task.stop().scheduler_registered, false);
  assert.equal(cleared, 1);
});

test('running server loop adopts an externally activated state without restart', () => {
  const file = statePath('external-activation');
  const legacyStatePath = writeLegacyState(statePath('external-legacy'));
  const cutoverLockPath = statePath('external-cutover.lock');
  const legacyRunLockPath = statePath('external-v1.lock');
  let scheduled;
  const serviceTask = taskModule.createKisPredictionV2ValidationTask({
    statePath: file,
    legacyStatePath,
    cutoverLockPath,
    legacyRunLockPath,
    runLockPath: statePath('external-v2.lock'),
    schedulerRegistered: true,
    serverRegistered: true,
    setTimer: (fn) => { scheduled = fn; return { unref() {} }; },
    clearTimer() {},
  });
  serviceTask.prepareDisabled();
  serviceTask.start();
  const operatorTask = taskModule.createKisPredictionV2ValidationTask({
    statePath: file, legacyStatePath,
    cutoverLockPath,
    legacyRunLockPath,
  });
  const activated = operatorTask.activate({ invokedBy: 'test_operator' });
  assert.equal(activated.scheduler_registered, false);
  scheduled();
  const adopted = serviceTask.status();
  assert.equal(adopted.state, 'ACTIVE');
  assert.equal(adopted.scheduler_registered, true);
  assert.equal(adopted.server_registered, true);
});

test('independent task instances share the filesystem run lock', async () => {
  const file = statePath('shared-state');
  const legacyStatePath = writeLegacyState(statePath('shared-legacy'));
  const cutoverLockPath = statePath('shared-cutover.lock');
  const legacyRunLockPath = statePath('shared-v1.lock');
  const runLockPath = statePath('shared-v2.lock');
  let firstCallback;
  let firstCalls = 0;
  let secondCalls = 0;
  const common = { statePath: file, legacyStatePath, cutoverLockPath, legacyRunLockPath, runLockPath };
  const firstTask = taskModule.createKisPredictionV2ValidationTask({
    ...common,
    execFile(command, args, options, callback) { firstCalls += 1; firstCallback = callback; },
  });
  firstTask.prepareDisabled();
  firstTask.activate({ invokedBy: 'test' });
  const secondTask = taskModule.createKisPredictionV2ValidationTask({
    ...common,
    execFile() { secondCalls += 1; },
  });
  const firstRun = firstTask.runOnce({ invokedBy: 'first' });
  const duplicate = await secondTask.runOnce({ invokedBy: 'second' });
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
  assert.equal(duplicate.last_run.error_class, 'scheduler_lock_active');
  assert.equal(duplicate.last_run.duplicate_execution_prevented, true);
  firstCallback(null, output());
  assert.equal((await firstRun).state, 'ACTIVE');
  assert.equal(fs.existsSync(runLockPath), false);
});

test('run uses exact fixed execFile command and valid statuses remain active', async () => {
  let received;
  const task = activeTask({ execFile(command, args, options, callback) { received = { command, args, options }; callback(null, output()); } });
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(received.command, 'python3');
  assert.deepEqual(received.args, ['-m', 'kis_trading_lab', 'prediction-v2-validation-auto-once', '--approval', taskModule.KIS_APPROVAL, '--db', taskModule.VPS_MOCK_DB_PATH]);
  assert.equal(received.options.cwd, taskModule.KIS_REPO);
  assert.equal(received.options.env, process.env);
  assert.equal(state.state, 'ACTIVE');
  for (const fixture of [
    output({ status: 'waiting', action: 'waiting_for_horizon', action_type: 'waiting_for_horizon', sample_status: 'waiting', executed: false, db_opened: false, schema_evidence_checked: false, integrity_checked: false, prediction_inserted_count: 0, outcome_inserted_count: 0, pending_matured_count: 0, distinct_decision_day_count: 0, market_data_api_calls: 0, predictions_inserted: 0, outcomes_resolved: 0, distinct_trading_days: 0, total_predictions: 0, pending_predictions: 0 }),
    output({ status: 'market_closed_no_op', action: 'market_closed_no_op', action_type: 'market_closed_no_op', sample_status: 'market_closed_no_op', executed: false, db_opened: false, schema_evidence_checked: false, integrity_checked: false, prediction_inserted_count: 0, outcome_inserted_count: 0, pending_matured_count: 0, distinct_decision_day_count: 0, market_data_api_calls: 0, predictions_inserted: 0, outcomes_resolved: 0, distinct_trading_days: 0, total_predictions: 0, pending_predictions: 0 }),
  ]) assert.equal(taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(fixture)).state, 'ACTIVE');
});

test('invalid contract and process error pause with no retry', async () => {
  const invalidTask = activeTask({ execFile(command, args, options, callback) { callback(null, output({ target_definition: 'wrong' })); } });
  assert.equal((await invalidTask.runOnce()).state, 'PAUSED');
  let calls = 0;
  const errorTask = activeTask({ execFile(command, args, options, callback) { calls += 1; callback(new Error('boom')); } });
  const state = await errorTask.runOnce();
  assert.equal(state.state, 'PAUSED');
  assert.equal(state.last_run.error_class, 'process_error');
  assert.equal(calls, 1);
});

test('exit code 2 preserves only a valid sanitized fail-closed result', async () => {
  const failClosedError = Object.assign(new Error('Command failed'), { code: 2 });
  let calls = 0;
  const runLockPath = statePath('exit-two-run.lock');
  const blockedTask = activeTask({
    runLockPath,
    execFile(command, args, options, callback) {
      calls += 1;
      callback(failClosedError, blockedFormatterOutput());
    },
  });
  const blocked = await blockedTask.runOnce({ invokedBy: 'test' });
  assert.equal(calls, 1);
  assert.equal(blocked.state, 'PAUSED');
  assert.equal(blocked.pause_reason, 'blocked');
  assert.equal(blocked.last_run.status, 'blocked');
  assert.equal(blocked.last_run.fail_closed, true);
  assert.equal(blocked.last_run.error_class, 'blocked');
  assert.equal(blocked.last_run.market_data_api_calls, 0);
  assert.equal(fs.existsSync(runLockPath), false);

  for (const [error, stdout] of [
    [Object.assign(new Error('Command failed'), { code: 2 }), output()],
    [Object.assign(new Error('Command failed'), { code: 2 }), withoutKey(blockedFormatterOutput(), 'prod_db_touched')],
    [Object.assign(new Error('Command failed'), { code: 1 }), blockedFormatterOutput()],
    [Object.assign(new Error('Command failed'), { code: 2 }), blockedFormatterOutput().replace('db_written=false', 'db_written=true').replace('prediction_inserted_count=0', 'prediction_inserted_count=3').replace('predictions_inserted=0', 'predictions_inserted=3')],
    [Object.assign(new Error('Command failed'), { code: 2 }), blockedFormatterOutput().replace('api_called=false', 'api_called=true').replace('market_data_api_calls=0', 'market_data_api_calls=3')],
    [Object.assign(new Error('Command failed'), { code: 2, signal: 'SIGTERM' }), blockedFormatterOutput()],
    [Object.assign(new Error('Command timed out'), { code: 2, killed: true }), blockedFormatterOutput()],
  ]) {
    const task = activeTask({
      execFile(command, args, options, callback) {
        callback(error, stdout);
      },
    });
    const state = await task.runOnce({ invokedBy: 'test' });
    assert.equal(state.state, 'PAUSED');
    assert.equal(state.pause_reason, 'process_error');
    assert.equal(state.last_run.error_class, 'process_error');
  }
});

test('scheduled fail-closed run does not re-register the polling timer', async () => {
  const file = statePath('scheduled-fail-closed');
  const callbacks = [];
  const task = activeTask({
    statePath: file,
    schedulerRegistered: true,
    serverRegistered: true,
    setTimer(fn) { callbacks.push(fn); return { unref() {} }; },
    clearTimer() {},
    execFile(command, args, options, callback) {
      callback(Object.assign(new Error('Command failed'), { code: 2 }), blockedFormatterOutput());
    },
  });
  task.start();
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  persisted.next_run_at = '2020-01-01T00:00:00Z';
  fs.writeFileSync(file, `${JSON.stringify(persisted)}\n`, 'utf8');
  assert.equal(callbacks.length, 1);
  callbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.status().state, 'PAUSED');
  assert.equal(callbacks.length, 1);
});

test('state persistence failure releases the shared run lock and rejects once', async () => {
  const file = statePath('state-write-failure');
  const runLockPath = statePath('state-write-failure-run.lock');
  let failWrites = false;
  const task = activeTask({
    statePath: file,
    runLockPath,
    stateWriter(target, state) {
      if (failWrites) throw new Error('state_write_failed');
      fs.writeFileSync(target, `${JSON.stringify(state)}\n`, 'utf8');
    },
    execFile(command, args, options, callback) {
      callback(Object.assign(new Error('Command failed'), { code: 2 }), blockedFormatterOutput());
    },
  });
  failWrites = true;
  await assert.rejects(task.runOnce({ invokedBy: 'test' }), /state_write_failed/);
  assert.equal(fs.existsSync(runLockPath), false);
});

test('scheduled state persistence failure latches fail-closed without another poll', async () => {
  const file = statePath('scheduled-state-write-failure');
  const runLockPath = statePath('scheduled-state-write-failure-run.lock');
  const callbacks = [];
  let failWrites = false;
  const task = activeTask({
    statePath: file,
    runLockPath,
    schedulerRegistered: true,
    serverRegistered: true,
    stateWriter(target, state) {
      if (failWrites) throw new Error('state_write_failed');
      fs.writeFileSync(target, `${JSON.stringify(state)}\n`, 'utf8');
    },
    setTimer(fn) { callbacks.push(fn); return { unref() {} }; },
    clearTimer() {},
    logger: { error() {} },
    execFile(command, args, options, callback) {
      callback(Object.assign(new Error('Command failed'), { code: 2 }), blockedFormatterOutput());
    },
  });
  task.start();
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  persisted.next_run_at = '2020-01-01T00:00:00Z';
  fs.writeFileSync(file, `${JSON.stringify(persisted)}\n`, 'utf8');
  failWrites = true;
  callbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(runLockPath), false);
  assert.equal(callbacks.length, 1);
  assert.equal(task.start().state, 'ACTIVE');
  assert.equal(callbacks.length, 1);
});

test('same-process duplicate is skipped and completed state stops scheduler', async () => {
  let callback;
  let calls = 0;
  let cleared = 0;
  const task = activeTask({ execFile(command, args, options, done) { calls += 1; callback = done; }, setTimer: () => ({ unref() {} }), clearTimer: () => { cleared += 1; } });
  task.start();
  const first = task.runOnce();
  const duplicate = await task.runOnce();
  assert.equal(calls, 1);
  assert.equal(duplicate.last_run.error_class, 'previous_run_active');
  callback(null, completedOutput());
  const completed = await first;
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.scheduler_registered, false);
  assert.equal(cleared, 1);
  assert.throws(() => taskModule.buildCommand({ targetDbPath: taskModule.PROD_DB_PATH }), /noncanonical_or_prod_db_path_blocked/);
  assert.equal(completed.orders_enabled, false);
  assert.equal(completed.os_cron_used, false);
});
