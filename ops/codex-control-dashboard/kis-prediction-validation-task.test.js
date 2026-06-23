const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskModule = require('./kis-prediction-validation-task');

function tempStatePath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kis-pred-task-')), `${name}.json`);
}

function successOutput(overrides = {}) {
  const base = {
    executed: true,
    action_type: 'idempotent_no_op',
    prediction_horizon: 'next_session',
    target_definition: 'direction_label_next_session_from_chart_features',
    timezone: 'Asia/Seoul',
    market_data_api_calls: 0,
    predictions_inserted: 0,
    outcomes_resolved: 0,
    distinct_trading_days: 1,
    total_predictions: 3,
    resolved_predictions: 3,
    correct_predictions: 2,
    incorrect_predictions: 1,
    pending_predictions: 0,
    sample_status: 'insufficient_sample',
    fail_closed: false,
    error_class: 'none',
    status: 'success',
  };
  return Object.entries({ ...base, ...overrides }).map(([key, value]) => `${key}=${value}`).join('\n');
}

function makeTask(execFile, extra = {}) {
  return taskModule.createKisPredictionValidationTask({
    statePath: tempStatePath('state'),
    execFile,
    pollIntervalMs: 1000000,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    ...extra,
  });
}

async function testCommandAndCwdAreFixed() {
  let captured;
  const task = makeTask((command, args, options, callback) => {
    captured = { command, args, cwd: options.cwd };
    callback(null, successOutput(), '');
  });
  await task.runOnce({ invokedBy: 'test' });
  assert.equal(captured.command, 'python3');
  assert.deepEqual(captured.args, ['-m', 'kis_trading_lab', 'prediction-validation-auto-once', '--approval', taskModule.KIS_APPROVAL]);
  assert.equal(captured.cwd, taskModule.KIS_REPO);
}

async function testSuccessKeepsActiveAndSanitized() {
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, `${successOutput()}\nsecret_token=synthetic-secret-value\nraw_response=full`, '');
  });
  task.activate();
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.last_run.action_type, 'idempotent_no_op');
  assert.equal(JSON.stringify(state).includes('synthetic-secret-value'), false);
  assert.equal(JSON.stringify(state).includes('raw_response=full'), false);
}

async function testFailClosedPauses() {
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ status: 'paused', action_type: 'paused', fail_closed: true, error_class: 'market_calendar_unknown' }), '');
  });
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(state.state, 'PAUSED');
  assert.equal(state.pause_reason, 'market_calendar_unknown');
}

async function testMinimumReachedCompletes() {
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ distinct_trading_days: 20, error_class: 'none' }), '');
  });
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(state.state, 'COMPLETED');
  assert.equal(state.completion_reason, 'minimum_distinct_trading_days_reached');
}

async function testConcurrencyPreventsDuplicateRun() {
  let callbackRef;
  let calls = 0;
  const task = makeTask((_command, _args, _options, callback) => {
    calls += 1;
    callbackRef = callback;
  });
  const first = task.runOnce({ invokedBy: 'test' });
  const second = await task.runOnce({ invokedBy: 'test' });
  assert.equal(calls, 1);
  assert.equal(second.last_run.duplicate_execution_prevented, true);
  callbackRef(null, successOutput(), '');
  await first;
}

async function testProdDbPathBlocksBeforeExec() {
  let calls = 0;
  const task = makeTask(() => { calls += 1; }, { targetDbPath: taskModule.PROD_DB_PATH });
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(calls, 0);
  assert.equal(state.state, 'PAUSED');
  assert.equal(state.pause_reason, 'prod_db_path_blocked');
}

async function testNoRetryOnError() {
  let calls = 0;
  const task = makeTask((_command, _args, _options, callback) => {
    calls += 1;
    callback(Object.assign(new Error('synthetic failure'), { code: 'ETIMEOUT' }), '', '');
  });
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(calls, 1);
  assert.equal(state.state, 'PAUSED');
  assert.equal(state.last_run.error_class, 'timeout');
}

function testScheduleAndDuplicateSchedulerGuard() {
  assert.equal(taskModule.nextRunAt(new Date('2026-06-23T06:00:00Z')), '2026-06-23T07:10:00.000Z');
  assert.equal(taskModule.nextRunAt(new Date('2026-06-23T07:20:00Z')), '2026-06-24T07:10:00.000Z');
  assert.deepEqual(taskModule.activeSchedulerCount({ codexTaskState: 'PAUSED', hermesTaskState: 'ACTIVE' }), {
    active_scheduler_count: 1,
    duplicate_scheduler_detected: false,
  });
  assert.equal(taskModule.activeSchedulerCount({ codexTaskState: 'ACTIVE', hermesTaskState: 'ACTIVE' }).duplicate_scheduler_detected, true);
}

(async () => {
  await testCommandAndCwdAreFixed();
  await testSuccessKeepsActiveAndSanitized();
  await testFailClosedPauses();
  await testMinimumReachedCompletes();
  await testConcurrencyPreventsDuplicateRun();
  await testProdDbPathBlocksBeforeExec();
  await testNoRetryOnError();
  testScheduleAndDuplicateSchedulerGuard();
  console.log('KIS prediction validation task tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
