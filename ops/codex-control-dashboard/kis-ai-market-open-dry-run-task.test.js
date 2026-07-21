'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const mod = require('./kis-ai-market-open-dry-run-task');

function good(taskId, status = 'success', extra = {}) {
  return JSON.stringify({
    task_id: taskId,
    status,
    action_type: status === 'blocked' ? 'paused' : 'intraday_shadow',
    official_trade_date: '2026-07-21',
    official_session_state: 'regular_session',
    api_calls: 0,
    quote_api_calls: 0,
    decisions: 0,
    simulated_orders: 0,
    simulated_positions: 0,
    experience_rows: 0,
    incidents: 0,
    outbox_rows: 0,
    challenger_trained: false,
    champion_changed: false,
    order_api_calls: 0,
    vps_live_orders: 0,
    prod_orders: 0,
    raw_response_persisted: false,
    secret_exposure: false,
    retry: false,
    catch_up: false,
    backfill: false,
    fail_closed: status === 'blocked',
    error_class: status === 'blocked' ? 'safe_block' : 'none',
    report_message: null,
    ...extra,
  });
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-ai-'));
  const paths = {
    statePath: path.join(root, 'state.json'),
    legacyV1StatePath: path.join(root, 'v1.json'),
    legacyV2StatePath: path.join(root, 'v2.json'),
    legacyV1RunLockPath: path.join(root, 'v1.lock'),
    legacyV2RunLockPath: path.join(root, 'v2.lock'),
    runLockPath: path.join(root, 'ai.lock'),
  };
  fs.writeFileSync(paths.legacyV1StatePath, JSON.stringify({ state: 'PAUSED', next_run_at: null }));
  fs.writeFileSync(paths.legacyV2StatePath, JSON.stringify({ state: 'PAUSED', next_run_at: null }));
  let clock = new Date('2026-07-20T23:59:00Z');
  const taskExec = options.execFile || ((c, a, o, cb) => cb(null, good(a[a.indexOf('--task-id') + 1])));
  const execFile = (command, args, execOptions, callback) => {
    if (args.includes('--activation-preflight')) {
      callback(null, good(mod.TASKS[0].id, 'success', { action_type: 'activation_preflight', api_calls: 2 }));
      return;
    }
    taskExec(command, args, execOptions, callback);
  };
  const task = mod.createKisAiMarketOpenDryRunTask({
    ...paths,
    now: () => clock,
    runtimeHealthCheck: options.runtimeHealthCheck || (async () => true),
    execFile,
    reportSender: options.reportSender,
    schedulerRegistered: options.schedulerRegistered,
    serverRegistered: options.serverRegistered,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });
  return { root, paths, task, setClock(value) { clock = new Date(value); }, rawExec: taskExec };
}

async function active(options = {}) {
  const value = fixture(options);
  value.task.prepareDisabled();
  await value.task.activate({ approval: mod.ACTIVATION_APPROVAL });
  return value;
}

test('exact activation approval, preflight, and four schedules', async () => {
  const value = fixture();
  value.task.prepareDisabled();
  await assert.rejects(value.task.activate({ approval: 'wrong' }), /exact_activation/);
  const state = await value.task.activate({ approval: mod.ACTIVATION_APPROVAL });
  assert.deepEqual(mod.TASKS.map((item) => item.id), [
    'kis-ai-market-open-supervisor-v1',
    'kis-ai-intraday-shadow-validation-v1',
    'kis-ai-post-close-learning-v1',
    'kis-ai-daily-learning-report-v1',
  ]);
  assert.equal(Object.keys(state.tasks).length, 4);
  assert.equal(state.tasks[mod.TASKS[0].id].last_run.action_type, 'activation_preflight');
  assert.equal(state.retry, false); assert.equal(state.catch_up, false); assert.equal(state.backfill, false);
});

test('activation fails closed before ACTIVE when runtime or legacy state is unsafe', async () => {
  const unhealthy = fixture({ runtimeHealthCheck: async () => false }); unhealthy.task.prepareDisabled();
  await assert.rejects(unhealthy.task.activate({ approval: mod.ACTIVATION_APPROVAL }), /runtime_health/);
  assert.equal(unhealthy.task.status().state, 'DISABLED');
  const legacy = fixture(); legacy.task.prepareDisabled();
  fs.writeFileSync(legacy.paths.legacyV2StatePath, JSON.stringify({ state: 'ACTIVE', next_run_at: 'x' }));
  await assert.rejects(legacy.task.activate({ approval: mod.ACTIVATION_APPROVAL }), /model_v2_must_be_paused/);
  assert.equal(legacy.task.status().state, 'DISABLED');
});

test('next runs skip catch-up and retain 14:40/14:50 monitor slots', () => {
  const intraday = mod.TASKS[1];
  assert.equal(mod.nextRunAt(intraday, new Date('2026-07-20T23:55:00Z')), '2026-07-21T00:10:00.000Z');
  assert.equal(mod.nextRunAt(intraday, new Date('2026-07-21T05:30:00Z')), '2026-07-21T05:40:00.000Z');
  assert.equal(mod.nextRunAt(intraday, new Date('2026-07-21T05:40:00Z')), '2026-07-21T05:50:00.000Z');
  assert.equal(mod.nextRunAt(intraday, new Date('2026-07-21T05:51:00Z')), '2026-07-22T00:10:00.000Z');
});

test('strict command and output contract reject drift and unsafe fields', () => {
  const command = mod.buildCommand(mod.TASKS[1].id);
  assert.equal(command.command, 'python3'); assert.equal(command.cwd, mod.KIS_REPO);
  assert.equal(command.args.includes('--activation-preflight'), false);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id), mod.TASKS[1].id));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { unknown: 1 }), mod.TASKS[1].id), /fields/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { fail_closed: undefined }), mod.TASKS[1].id), /fields|boolean/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { report_message: 'app_secret=x' }), mod.TASKS[1].id), /unsafe/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { official_session_state: 'closed' }), mod.TASKS[1].id), /calendar/);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', { action_type: 'market_closed_no_op', official_session_state: 'closed' }), mod.TASKS[1].id));
});

test('missed slot is not executed but advances so the next slot runs once', async () => {
  let calls = 0;
  const value = await active({ execFile(c, a, o, cb) { calls += 1; cb(null, good(a[a.indexOf('--task-id') + 1])); } });
  value.setClock('2026-07-21T00:11:12Z');
  await value.task.tick();
  assert.equal(calls, 0);
  assert.equal(value.task.status().tasks[mod.TASKS[1].id].next_run_at, '2026-07-21T00:20:00.000Z');
  value.setClock('2026-07-21T00:20:31Z');
  await value.task.tick();
  assert.equal(calls, 1);
});

test('filesystem lock and legacy task state prevent child execution', async () => {
  let calls = 0;
  const value = await active({ execFile(c, a, o, cb) { calls += 1; cb(null, good(mod.TASKS[0].id)); } });
  fs.writeFileSync(value.paths.runLockPath, 'other process');
  value.setClock('2026-07-21T00:00:17Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date('2026-07-21T00:00:17Z') });
  assert.equal(calls, 0); assert.equal(state.state, 'PAUSED');
  fs.unlinkSync(value.paths.runLockPath);
});

test('invalid output, blocked result, and timeout pause all tasks without retry', async () => {
  for (const behavior of ['unsafe', 'blocked', 'timeout']) {
    let calls = 0;
    const value = await active({ execFile(c, a, o, cb) {
      calls += 1;
      if (behavior === 'unsafe') cb(null, good(mod.TASKS[0].id, 'success', { order_api_calls: 1 }));
      else if (behavior === 'blocked') cb(Object.assign(new Error('blocked'), { code: 2 }), good(mod.TASKS[0].id, 'blocked'));
      else cb(Object.assign(new Error('timeout'), { killed: true, code: null }), '');
    } });
    value.setClock('2026-07-21T00:00:11Z');
    const state = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date('2026-07-21T00:00:11Z') });
    assert.equal(calls, 1); assert.equal(state.state, 'PAUSED');
    assert.equal(Object.values(state.tasks).every((item) => item.state === 'PAUSED'), true);
    assert.equal(fs.existsSync(value.paths.runLockPath), false);
  }
});

test('state corruption faults and pauses polling without executing child', async () => {
  let calls = 0; const callbacks = [];
  const value = await active({
    schedulerRegistered: true, serverRegistered: true,
    setTimer(fn) { callbacks.push(fn); return { unref() {} }; }, clearTimer() {},
    execFile(c, a, o, cb) { calls += 1; cb(null, good(mod.TASKS[0].id)); },
  });
  value.task.start();
  fs.writeFileSync(value.paths.statePath, '{');
  const result = await value.task.tick();
  assert.equal(result.state, 'PAUSED'); assert.equal(result.scheduler_faulted, true);
  assert.equal(calls, 0); assert.equal(callbacks.length, 1);
});

const report = '[KIS Adaptive AI Dry-Run]\ndata: sessions 4 / decisions 3\nmodels: fixed_rule_v1 baseline / candidates 2\nsimulation: orders 0 / fills and positions 0\nlearning: runs 1 / champion changes 0\nquality: incidents 0 / drift reviews 0\noutcomes: no filled samples; cost and MFE/MAE not applicable\nactual orders: none';

test('daily report uses existing sender exactly once and stores status only', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(c, a, o, cb) { cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', report_message: report })); },
  });
  value.setClock('2026-07-21T07:30:29Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:29Z') });
  assert.equal(sent.length, 1); assert.equal(sent[0].targetChannelId, mod.REPORT_TARGET_CHANNEL_ID);
  assert.equal(state.tasks[mod.TASKS[3].id].last_run.status, 'report_sent');
  assert.equal(JSON.stringify(state).includes('session runs'), false);
});

test('report failure pauses all tasks and never retries the KIS cycle', async () => {
  let sends = 0; let runs = 0;
  const value = await active({
    reportSender: async () => { sends += 1; throw new Error('private detail'); },
    execFile(c, a, o, cb) { runs += 1; cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', report_message: report })); },
  });
  value.setClock('2026-07-21T07:30:00Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:00Z') });
  assert.equal(sends, 1); assert.equal(runs, 1); assert.equal(state.state, 'PAUSED');
});
