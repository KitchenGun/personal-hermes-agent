const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskModule = require('./kis-prediction-validation-task');
const v2TaskModule = require('./kis-prediction-v2-validation-task');

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
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-pred-task-'));
  return taskModule.createKisPredictionValidationTask({
    statePath: path.join(testDir, 'state.json'),
    v2StatePath: path.join(testDir, 'v2-state.json'),
    cutoverLockPath: path.join(testDir, 'cutover.lock'),
    execFile,
    pollIntervalMs: 1000000,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    ...extra,
  });
}

function disabledV2State(overrides = {}) {
  return {
    canonical_task_id: 'kis-prediction-validation-cycle-v2',
    task_owner: 'hermes',
    state: 'DISABLED',
    next_run_at: null,
    scheduler_registered: false,
    server_registered: false,
    live_execution_enabled: false,
    max_concurrent_runs: 1,
    orders_enabled: false,
    os_cron_used: false,
    ...overrides,
  };
}

async function testV2StateBlocksLegacyExecution() {
  for (const state of ['ACTIVE', 'PAUSED', 'COMPLETED']) {
    let calls = 0;
    const v2StatePath = tempStatePath(`v2-${state.toLowerCase()}`);
    fs.writeFileSync(v2StatePath, JSON.stringify({ state }));
    const task = makeTask(() => { calls += 1; }, { v2StatePath });
    const result = await task.runOnce({ invokedBy: 'test' });
    assert.equal(calls, 0, `${state} must block legacy execution`);
    assert.equal(result.state, 'PAUSED');
    assert.equal(result.last_run.error_class, 'model_v2_scheduler_active_or_invalid');
  }

  let malformedCalls = 0;
  const malformedPath = tempStatePath('v2-malformed');
  fs.writeFileSync(malformedPath, '{not json');
  const malformedTask = makeTask(() => { malformedCalls += 1; }, { v2StatePath: malformedPath });
  const malformedResult = await malformedTask.runOnce({ invokedBy: 'test' });
  assert.equal(malformedCalls, 0);
  assert.equal(malformedResult.last_run.error_class, 'model_v2_scheduler_active_or_invalid');

  let incompleteCalls = 0;
  const incompletePath = tempStatePath('v2-incomplete-disabled');
  fs.writeFileSync(incompletePath, JSON.stringify({ state: 'DISABLED' }));
  const incompleteTask = makeTask(() => { incompleteCalls += 1; }, { v2StatePath: incompletePath });
  const incompleteResult = await incompleteTask.runOnce({ invokedBy: 'test' });
  assert.equal(incompleteCalls, 0);
  assert.equal(incompleteResult.last_run.error_class, 'model_v2_scheduler_active_or_invalid');
}

async function testMissingOrDisabledV2StateAllowsLegacyExecution() {
  for (const v2State of [null, 'DISABLED']) {
    let calls = 0;
    const v2StatePath = tempStatePath(`v2-${v2State || 'missing'}`);
    if (v2State) fs.writeFileSync(v2StatePath, JSON.stringify(disabledV2State()));
    const task = makeTask((_command, _args, _options, callback) => {
      calls += 1;
      callback(null, successOutput(), '');
    }, { v2StatePath });
    await task.runOnce({ invokedBy: 'test' });
    assert.equal(calls, 1, `${v2State || 'missing'} must allow legacy execution`);
  }
}

async function testCutoverLockMakesV1RunAndV2ActivationAtomic() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-pred-cutover-race-'));
  const v1StatePath = path.join(testDir, 'v1-state.json');
  const v2StatePath = path.join(testDir, 'v2-state.json');
  const cutoverLockPath = path.join(testDir, 'cutover.lock');
  const legacyRunLockPath = path.join(testDir, 'legacy-run.lock');
  let v1Callback;
  const v1Task = taskModule.createKisPredictionValidationTask({
    statePath: v1StatePath,
    v2StatePath,
    cutoverLockPath,
    execFile(command, args, options, callback) { v1Callback = callback; },
  });
  v1Task.pause('test');
  const v2Task = v2TaskModule.createKisPredictionV2ValidationTask({
    statePath: v2StatePath,
    legacyStatePath: v1StatePath,
    cutoverLockPath,
    legacyRunLockPath,
    runLockPath: path.join(testDir, 'v2-run.lock'),
  });
  v2Task.prepareDisabled();
  const v1Run = v1Task.runOnce({ invokedBy: 'test', force: true });
  assert.equal(fs.existsSync(cutoverLockPath), true);
  assert.throws(() => v2Task.activate({ invokedBy: 'test' }), /scheduler_lock_active/);
  assert.equal(v2Task.status().state, 'DISABLED');
  v1Callback(null, successOutput(), '');
  await v1Run;
  assert.equal(fs.existsSync(cutoverLockPath), false);
  v1Task.pause('cutover_ready');
  assert.equal(v2Task.activate({ invokedBy: 'test' }).state, 'ACTIVE');
}

async function testExistingCutoverLockBlocksWithoutChildCall() {
  let calls = 0;
  const cutoverLockPath = tempStatePath('cutover-lock');
  fs.writeFileSync(cutoverLockPath, 'held');
  const task = makeTask(() => { calls += 1; }, { cutoverLockPath });
  const result = await task.runOnce({ invokedBy: 'test' });
  assert.equal(calls, 0);
  assert.equal(result.state, 'PAUSED');
  assert.equal(result.last_run.error_class, 'scheduler_cutover_lock_held');
  assert.equal(fs.existsSync(cutoverLockPath), true);
}

async function testCutoverLockReleasesAfterChildCallbacks() {
  for (const outcome of ['success', 'error']) {
    const cutoverLockPath = tempStatePath(`cutover-release-${outcome}`);
    const task = makeTask((_command, _args, _options, callback) => {
      if (outcome === 'success') callback(null, successOutput(), '');
      else callback(new Error('synthetic failure'), '', '');
    }, { cutoverLockPath });
    await task.runOnce({ invokedBy: 'test' });
    assert.equal(fs.existsSync(cutoverLockPath), false, `${outcome} callback must release cutover lock`);
  }
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

async function testProgressMessageOnDistinctDayIncrease() {
  const sent = [];
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ distinct_trading_days: 3 }), '');
  }, {
    progressSender: async (message) => {
      sent.push(message);
      return { discord_sent: true };
    },
  });
  task.activate();
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetChannelId, taskModule.PROGRESS_TARGET_CHANNEL_ID);
  assert.equal(sent[0].content, '[KIS \uc608\uce21 \uac80\uc99d]\n\uc9c4\ud589: 3/20 \uac70\ub798\uc77c\n\uc0c1\ud0dc: \ud45c\ubcf8 \uc218\uc9d1 \uc911\n\uc694\uc57d: \uc608\uce21 3\uac74 \u00b7 \ub300\uc870 3\uac74(\uc815\ub2f5 2/\uc624\ub2f5 1/\uc911\ub9bd 0) \u00b7 \ub300\uae30 0\uac74 \u00b7 \uac70\ub798 \uc5c6\uc74c');
  assert.equal(state.progress_notifications.last_distinct_trading_days, 3);
}

function testProgressMessageSummaryLineForCurrentCounts() {
  const message = taskModule.buildProgressMessage({
    distinctTradingDays: 7,
    taskState: 'ACTIVE',
    summary: {
      total_predictions: 21,
      resolved_predictions: 17,
      correct_predictions: 9,
      incorrect_predictions: 5,
      neutral_predictions: 3,
      pending_predictions: 999,
      paper_trade_count: 0,
      live_trade_count: 0,
    },
  });
  assert.equal(message, '[KIS \uc608\uce21 \uac80\uc99d]\n\uc9c4\ud589: 7/20 \uac70\ub798\uc77c\n\uc0c1\ud0dc: \ud45c\ubcf8 \uc218\uc9d1 \uc911\n\uc694\uc57d: \uc608\uce21 21\uac74 \u00b7 \ub300\uc870 17\uac74(\uc815\ub2f5 9/\uc624\ub2f5 5/\uc911\ub9bd 3) \u00b7 \ub300\uae30 4\uac74 \u00b7 \uac70\ub798 \uc5c6\uc74c');
  assert.equal(/005930|000660|005380|\ub9e4\uc218|\ub9e4\ub3c4|recommend|PnL|score|price/i.test(message), false);
}

async function testNoProgressMessageForSameDistinctDay() {
  let calls = 0;
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ distinct_trading_days: 2 }), '');
  }, {
    progressSender: async () => {
      calls += 1;
      return { discord_sent: true };
    },
  });
  task.activate();
  await task.runOnce({ invokedBy: 'test' });
  await task.runOnce({ invokedBy: 'test' });
  assert.equal(calls, 1);
}

async function testPausedTransitionSendsStatusMessage() {
  const sent = [];
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ status: 'paused', action_type: 'paused', fail_closed: true, error_class: 'market_calendar_unknown', distinct_trading_days: 2 }), '');
  }, {
    progressSender: async (message) => {
      sent.push(message);
      return { discord_sent: true };
    },
  });
  task.activate();
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(state.state, 'PAUSED');
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /\uc0c1\ud0dc: \ubcf4\ud638 \uc911\ub2e8/);
}

async function testCompletedSendsMinimumReachedMessage() {
  const sent = [];
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ distinct_trading_days: 20 }), '');
  }, {
    progressSender: async (message) => {
      sent.push(message);
      return { discord_sent: true };
    },
  });
  task.activate();
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(state.state, 'COMPLETED');
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /\uc9c4\ud589: 20\/20 \uac70\ub798\uc77c/);
  assert.match(sent[0].content, /\uc0c1\ud0dc: \ucd5c\uc18c \uac80\uc99d \uc644\ub8cc/);
}

async function testDuplicateProgressKeySkipsSend() {
  let calls = 0;
  const key = taskModule.progressIdempotencyKey({ distinctTradingDays: 2, taskState: 'ACTIVE' });
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ distinct_trading_days: 2 }), '');
  }, {
    progressSender: async () => {
      calls += 1;
      return { discord_sent: true };
    },
  });
  const active = task.activate();
  fs.writeFileSync(task.statePath, JSON.stringify({
    ...active,
    last_run: { distinct_trading_days: 2 },
    progress_notifications: {
      sent_keys: { [key]: '2026-06-23T00:00:00Z' },
      last_distinct_trading_days: 2,
      last_task_state: 'ACTIVE',
    },
  }));
  const state = await task.notifyCurrentProgress({ invokedBy: 'test' });
  assert.equal(calls, 0);
  assert.equal(state.progress_notifications.last_delivery.duplicate_skipped, true);
}

async function testDiscordFailureDoesNotPauseTaskOrRetry() {
  let calls = 0;
  const task = makeTask((_command, _args, _options, callback) => {
    callback(null, successOutput({ distinct_trading_days: 3 }), '');
  }, {
    progressSender: async () => {
      calls += 1;
      return { discord_sent: false, error_class: 'discord_send_failed' };
    },
  });
  task.activate();
  const state = await task.runOnce({ invokedBy: 'test' });
  assert.equal(calls, 1);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.progress_notifications.last_delivery.discord_sent, false);
  assert.equal(state.progress_notifications.last_delivery.send_attempt_count, 1);
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
  await testV2StateBlocksLegacyExecution();
  await testMissingOrDisabledV2StateAllowsLegacyExecution();
  await testExistingCutoverLockBlocksWithoutChildCall();
  await testCutoverLockReleasesAfterChildCallbacks();
  await testCutoverLockMakesV1RunAndV2ActivationAtomic();
  await testProgressMessageOnDistinctDayIncrease();
  testProgressMessageSummaryLineForCurrentCounts();
  await testNoProgressMessageForSameDistinctDay();
  await testPausedTransitionSendsStatusMessage();
  await testCompletedSendsMinimumReachedMessage();
  await testDuplicateProgressKeySkipsSend();
  await testDiscordFailureDoesNotPauseTaskOrRetry();
  testScheduleAndDuplicateSchedulerGuard();
  console.log('KIS prediction validation task tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
