'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const mod = require('./kis-ai-market-open-dry-run-task');
const CALENDAR_HASH = `sha256:${'a'.repeat(64)}`;

function calendarProof(isTradingDay = true) {
  return { isTradingDay, sourceHash: CALENDAR_HASH };
}

function good(taskId, status = 'success', extra = {}) {
  const defaultAction = {
    [mod.TASKS[0].id]: 'market_open_supervisor',
    [mod.TASKS[1].id]: 'intraday_shadow',
    [mod.TASKS[2].id]: 'post_close_learning',
    [mod.TASKS[3].id]: 'daily_learning_report',
  }[taskId];
  const blocked = status === 'blocked';
  return JSON.stringify({
    task_id: taskId,
    status,
    action_type: blocked ? 'paused' : defaultAction,
    official_trade_date: blocked ? null : '2026-07-21',
    official_session_state: blocked ? 'unknown' : 'regular_session',
    official_calendar_verified: !blocked,
    official_calendar_source_hash: blocked ? null : CALENDAR_HASH,
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
    fail_closed: blocked,
    error_class: blocked ? 'safe_block' : 'none',
    failure_phase: 'none',
    failure_symbol: null,
    failure_exception_type: 'none',
    failure_errno: null,
    failure_attempt_number: 0,
    transport_degraded: false,
    report_message: null,
    ...extra,
  });
}

function orderGood(status = 'no_op', extra = {}) {
  const blocked = status === 'blocked';
  return JSON.stringify({
    task_id: 'kis-vps-model-v3-autonomous-pilot-v1',
    status,
    action_type: blocked ? 'paused' : 'no_candidate_no_op',
    official_trade_date: '2026-07-21',
    order_api_calls: 0,
    vps_live_orders: 0,
    prod_orders: 0,
    reconciliations: 0,
    open_positions: 0,
    daily_entry_count: 0,
    artifact_reused: true,
    artifact_promoted: false,
    previous_artifact_hash: null,
    artifact_hash: 'a'.repeat(64),
    shadow_predictions_inserted: 0,
    shadow_duplicates_skipped: 0,
    model_v2_changed: false,
    scheduler_changed: false,
    retry: false,
    catch_up: false,
    backfill: false,
    fail_closed: blocked,
    error_class: blocked ? 'safe_block' : 'none',
    raw_response_persisted: false,
    secret_exposure: false,
    ...extra,
  });
}

function diagnostic() {
  const occurredAt = '2026-07-21T00:00:00Z';
  return JSON.stringify({
    status: 'pass',
    task_id: 'kis-ai-quote-transport-diagnose-v1',
    official_trade_date: '2026-07-21',
    occurred_at: occurredAt,
    symbols_attempted: 3,
    symbols_succeeded: 3,
    failed_symbol_count: 0,
    transport_error_class: 'none',
    results: ['005930', '000660', '005380'].map((symbol, index) => ({
      symbol,
      status: 'pass',
      phase: 'quote_parse',
      error_class: 'none',
      exception_type: 'none',
      sanitized_errno: null,
      attempt_number: index + 1,
      occurred_at: occurredAt,
      retry: false,
      order_api_calls: 0,
    })),
    api_retries: 0,
    order_api_calls: 0,
    vps_live_orders: 0,
    prod_orders: 0,
    raw_response_persisted: false,
    secret_exposure: false,
    retry: false,
  });
}

function blockedDiagnostic() {
  const value = JSON.parse(diagnostic());
  value.status = 'blocked';
  value.symbols_attempted = 0;
  value.symbols_succeeded = 0;
  value.failed_symbol_count = 0;
  value.transport_error_class = 'unknown_runtime_io_failed';
  value.results = [];
  return JSON.stringify(value);
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
    orderAttestationDir: path.join(root, 'attestations'),
  };
  fs.writeFileSync(paths.legacyV1StatePath, JSON.stringify({ state: 'PAUSED', next_run_at: null }));
  fs.writeFileSync(paths.legacyV2StatePath, JSON.stringify({ state: 'PAUSED', next_run_at: null }));
  let clock = new Date('2026-07-20T23:59:00Z');
  const taskExec = options.execFile || ((c, a, o, cb) => cb(null, good(a[a.indexOf('--task-id') + 1])));
  const execFile = (command, args, execOptions, callback) => {
    if (args.includes('ai-quote-transport-diagnose-once')) {
      callback(null, options.diagnosticOutput || diagnostic());
      return;
    }
    if (args.includes('--activation-preflight')) {
      callback(null, good(mod.TASKS[0].id, 'success', { action_type: 'activation_preflight', api_calls: 2 }));
      return;
    }
    if (args.includes('vps-autonomous-order') && args.includes('activation-check')) {
      callback(
        options.activationCheckError || null,
        options.activationCheckOutput || orderGood('success', { action_type: 'activation_check' }),
      );
      return;
    }
    taskExec(command, args, execOptions, callback);
  };
  const task = mod.createKisAiMarketOpenDryRunTask({
    ...paths,
    now: () => clock,
    runtimeHealthCheck: options.runtimeHealthCheck || (async () => true),
    sourceParityCheck: options.sourceParityCheck || (() => true),
    resumeBlockingLockPaths: options.resumeBlockingLockPaths,
    execFile,
    reportSender: options.reportSender,
    calendarProofResolver: options.calendarProofResolver || (() => calendarProof(true)),
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

test('exact activation approval enables four dry-run schedules and keeps order disabled', async () => {
  const value = fixture();
  value.task.prepareDisabled();
  await assert.rejects(value.task.activate({ approval: 'wrong' }), /exact_activation/);
  const state = await value.task.activate({ approval: mod.ACTIVATION_APPROVAL });
  assert.deepEqual(mod.TASKS.map((item) => item.id), [
    'kis-ai-market-open-supervisor-v1',
    'kis-ai-intraday-shadow-validation-v1',
    'kis-ai-post-close-learning-v1',
    'kis-ai-daily-learning-report-v1',
    'kis-vps-model-v3-autonomous-pilot-v1',
  ]);
  assert.equal(Object.keys(state.tasks).length, 5);
  assert.equal(state.canonical_task_id, mod.CANONICAL_TASK_ID);
  assert.equal(state.task_owner, mod.TASK_OWNER);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, null);
  assert.equal(state.tasks[mod.TASKS[0].id].last_run.action_type, 'activation_preflight');
  assert.equal(state.retry, false); assert.equal(state.catch_up, false); assert.equal(state.backfill, false);
});

test('order command uses VM venv and exposes no per-run approval', () => {
  const dueKey = `${mod.TASKS[4].id}:2026-07-22:09:15`;
  const command = mod.buildCommand(mod.TASKS[4].id, { schedulerToken: '1'.repeat(32), dueKey });
  assert.equal(command.command, mod.KIS_VENV_PYTHON);
  assert.equal(command.cwd, mod.KIS_REPO);
  assert.deepEqual(command.args, ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'run-once']);
  assert.equal(command.env.KIS_HERMES_SCHEDULER_TOKEN, '1'.repeat(32));
  assert.equal(command.env.KIS_HERMES_DUE_KEY, dueKey);
  assert.equal(command.args.includes('--approval'), false);
  assert.throws(() => mod.buildCommand(mod.TASKS[4].id), /scheduler_attestation_required/);
  const postCloseDueKey = `${mod.TASKS[4].id}:2026-07-22:16:20`;
  const postClose = mod.buildCommand(mod.TASKS[4].id, {
    schedulerToken: '2'.repeat(32),
    dueKey: postCloseDueKey,
  });
  assert.deepEqual(
    postClose.args,
    ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'scheduled-refresh-shadow'],
  );
});

test('order schedule starts at 09:15, includes 14:55 and post-close refresh, and never catches up', () => {
  const task = mod.TASKS[4];
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T00:14:00Z')), '2026-07-21T00:15:00.000Z');
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T05:54:00Z')), '2026-07-21T05:55:00.000Z');
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T05:55:00Z')), '2026-07-21T07:20:00.000Z');
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T07:20:00Z')), '2026-07-22T00:15:00.000Z');
});

test('order output contract allows one reconciled VPS order and rejects unsafe drift', () => {
  const accepted = orderGood('success', {
    action_type: 'entry_reconciled', order_api_calls: 1, vps_live_orders: 1,
    reconciliations: 1, open_positions: 1, daily_entry_count: 1,
  });
  const parsed = mod.parseKisVpsAutonomousOutput(accepted);
  assert.equal(parsed.actionType, 'entry_reconciled');
  assert.equal(parsed.orderApiCalls, 1);
  assert.doesNotThrow(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    action_type: 'ai_position_held', open_positions: 1,
  })));
  for (const actionType of [
    'ai_exit_reconciled',
    'risk_stop_exit_reconciled',
    'take_profit_exit_reconciled',
    'horizon_exit_reconciled',
  ]) {
    const exit = mod.parseKisVpsAutonomousOutput(orderGood('success', {
      action_type: actionType, order_api_calls: 1, vps_live_orders: 1, reconciliations: 1,
    }));
    assert.equal(exit.actionType, actionType);
  }
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('success', {
    action_type: 'ai_exit_reconciled',
  })), /invalid_order_execution_contract/);
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('success', {
    action_type: 'entry_reconciled', order_api_calls: 2, vps_live_orders: 2, reconciliations: 1,
  })), /unsafe_order_count/);
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    error_class: 'app_secret=value',
  })), /unsafe_order_output/);
  const promoted = mod.parseKisVpsAutonomousOutput(orderGood('success', {
    action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
    previous_artifact_hash: 'a'.repeat(64), artifact_hash: 'b'.repeat(64),
  }));
  assert.equal(promoted.artifactPromoted, true);
  assert.equal(promoted.previousArtifactHash, 'a'.repeat(64));
  assert.doesNotThrow(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', { daily_entry_count: 5 })));
  assert.throws(
    () => mod.parseKisVpsAutonomousOutput(orderGood('no_op', { daily_entry_count: 6 })),
    /unsafe_order_count/,
  );
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
    previous_artifact_hash: 'a'.repeat(64), artifact_hash: 'b'.repeat(64),
  })), /artifact_promotion/);
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('success', {
    action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
    previous_artifact_hash: 'a'.repeat(64), artifact_hash: 'a'.repeat(64),
  })), /artifact_promotion/);
});

test('explicit enable check activates only the fifth order task without creating a scheduler', async () => {
  const value = await active();
  await assert.rejects(value.task.enableOrderTask(), /confirmation/);
  await assert.rejects(value.task.enableOrderTask({ confirm: true, approval: 'wrong' }), /exact_order_activation/);
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'DISABLED');
  const state = await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].activation_artifact_hash, 'a'.repeat(64));
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_check');
  assert.equal(state.retry, false); assert.equal(state.catch_up, false); assert.equal(state.backfill, false);
  assert.equal(state.os_cron_used, false);
});

test('exact enable can arm the existing order task only for the same-day post-close refresh', async () => {
  let autonomousRuns = 0;
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
    execFile(command, args, options, callback) {
      autonomousRuns += 1;
      assert.equal(args.includes('scheduled-refresh-shadow'), true);
      callback(null, orderGood('success', { action_type: 'shadow_refreshed' }));
    },
  });
  value.setClock('2026-07-21T04:42:00Z');

  let state = await value.task.enableOrderTask({
    confirm: true,
    approval: mod.ORDER_ACTIVATION_APPROVAL,
  });

  assert.equal(autonomousRuns, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-21T07:20:00.000Z');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_waiting_post_close');
  assert.equal(state.tasks[mod.TASKS[4].id].activation_artifact_hash, 'a'.repeat(64));

  value.setClock('2026-07-21T07:20:00Z');
  state = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-21T07:20:00Z'),
  });
  assert.equal(autonomousRuns, 1);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'shadow_refreshed');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-22T00:15:00.000Z');
});

test('post-close slot rejects an order result even if a child violates the refresh-only contract', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      if (args.includes('activation-check')) {
        callback(null, orderGood('success', { action_type: 'activation_check' }));
      } else {
        assert.equal(args.includes('scheduled-refresh-shadow'), true);
        callback(null, orderGood('success', {
          action_type: 'entry_reconciled', order_api_calls: 1, vps_live_orders: 1,
          reconciliations: 1, open_positions: 1, daily_entry_count: 1,
        }));
      }
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const stateBefore = value.task.status();
  stateBefore.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T07:20:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(stateBefore));

  const state = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-21T07:20:00.000Z'),
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'order_action_not_allowed_for_schedule_slot');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, null);
});

test('post-close arm rejects a stale artifact or an elapsed refresh window', async () => {
  for (const failure of ['artifact', 'window']) {
    const value = await active({
      activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
      activationCheckOutput: orderGood('blocked', {
        error_class: 'model_v3_prediction_batch_incomplete',
      }),
    });
    if (failure === 'artifact') {
      const state = value.task.status();
      state.tasks[mod.TASKS[4].id].activation_artifact_hash = 'b'.repeat(64);
      fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
      value.setClock('2026-07-21T04:42:00Z');
    } else {
      value.setClock('2026-07-21T07:21:00Z');
    }

    await assert.rejects(
      value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
      failure === 'artifact' ? /artifact_attestation_mismatch/ : /post_close_arm_window_unavailable/,
    );
    assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'DISABLED');
  }
});

test('explicit enable check reactivates an order task paused for known reconciliation recovery reasons', async () => {
  for (const pauseReason of [
    'balance_mismatch',
    'order_not_fully_filled',
    'order_submission_unknown',
    'invalid_order_output_contract',
  ]) {
    const value = await active();
    const paused = value.task.status();
    paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
    paused.tasks[mod.TASKS[4].id].pause_reason = pauseReason;
    paused.tasks[mod.TASKS[4].id].next_run_at = null;
    fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

    const state = await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
    assert.equal(state.state, 'ACTIVE');
    assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
    assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, undefined);
    assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_check');
  }
});

test('unresolved ambiguous submission keeps the order task paused', async () => {
  const value = await active({
    activationCheckOutput: orderGood('blocked', {
      action_type: 'paused',
      error_class: 'pending_order_reconciliation',
    }),
  });
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'order_submission_unknown';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  await assert.rejects(
    value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
    /order_activation_check_failed/,
  );
  const after = value.task.status().tasks[mod.TASKS[4].id];
  assert.equal(after.state, 'PAUSED');
  assert.equal(after.pause_reason, 'order_submission_unknown');
  assert.equal(after.next_run_at, null);
});

test('explicit enable parses safe exit two output and preserves the exact blocker', async () => {
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      action_type: 'paused',
      error_class: 'pending_order_reconciliation',
    }),
  });

  await assert.rejects(
    value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
    /order_activation_check_failed:pending_order_reconciliation/,
  );
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'DISABLED');
});

test('explicit enable rejects a concurrent state transition instead of overwriting it', async () => {
  let healthCalls = 0;
  let value;
  const runtimeHealthCheck = async () => {
    healthCalls += 1;
    if (healthCalls === 2) {
      const changed = value.task.status();
      changed.state = 'PAUSED';
      changed.pause_reason = 'concurrent_pause';
      fs.writeFileSync(value.paths.statePath, JSON.stringify(changed));
    }
    return true;
  };
  value = await active({ runtimeHealthCheck });

  await assert.rejects(
    value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
    /order_activation_state_changed/,
  );
  assert.equal(value.task.status().state, 'PAUSED');
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'DISABLED');
});

test('explicit enable check rejects an order task paused for an unknown reason', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'unexpected_order_failure';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  await assert.rejects(
    value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
    /order_task_must_be_disabled/,
  );
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].pause_reason, 'unexpected_order_failure');
});

test('blocked autonomous order pauses only the order task and leaves dry-run tasks active', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) callback(Object.assign(new Error('blocked'), { code: 2 }), orderGood('blocked'));
    else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, null);
});

test('invalid autonomous output pauses only the order task without retry', async () => {
  let runCalls = 0;
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      runCalls += 1;
      callback(null, '{"unsafe":"output"}');
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(runCalls, 1);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.retry, false); assert.equal(state.catch_up, false); assert.equal(state.backfill, false);
});

test('order invocation uses one-time hashed scheduler attestation and clears pending state', async () => {
  let schedulerToken;
  let invocationDueKey;
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      schedulerToken = options.env.KIS_HERMES_SCHEDULER_TOKEN;
      invocationDueKey = options.env.KIS_HERMES_DUE_KEY;
      assert.equal(args.includes(schedulerToken), false);
      callback(null, orderGood());
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.match(schedulerToken, /^[a-f0-9]{32}$/);
  assert.equal(invocationDueKey.startsWith(`${mod.TASKS[4].id}:`), true);
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(JSON.stringify(state).includes(schedulerToken), false);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
});

test('artifact hash drift pauses only the order task', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) callback(null, orderGood('no_op', { artifact_hash: 'b'.repeat(64) }));
    else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'model_v3_artifact_attestation_mismatch');
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
});

test('declared post-close challenger promotion atomically rotates the order attestation hash', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      if (args.includes('activation-check')) callback(null, orderGood('success', { action_type: 'activation_check' }));
      else callback(null, orderGood('success', {
        action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
        previous_artifact_hash: 'a'.repeat(64), artifact_hash: 'b'.repeat(64),
      }));
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const stateBefore = value.task.status();
  const orderTask = stateBefore.tasks[mod.TASKS[4].id];
  orderTask.next_run_at = '2026-07-21T07:20:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(stateBefore));
  value.setClock('2026-07-21T07:20:00.000Z');

  const state = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-21T07:20:00.000Z'),
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].activation_artifact_hash, 'b'.repeat(64));
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.artifact_promoted, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.previous_artifact_hash, 'a'.repeat(64));
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
});

test('declared challenger promotion outside the post-close slot pauses without rotating attestation', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      if (args.includes('activation-check')) callback(null, orderGood('success', { action_type: 'activation_check' }));
      else callback(null, orderGood('success', {
        action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
        previous_artifact_hash: 'a'.repeat(64), artifact_hash: 'b'.repeat(64),
      }));
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const stateBefore = value.task.status();
  stateBefore.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T00:15:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(stateBefore));
  value.setClock('2026-07-21T00:15:00.000Z');

  const state = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-21T00:15:00.000Z'),
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'model_v3_promotion_outside_post_close_slot');
  assert.equal(state.tasks[mod.TASKS[4].id].activation_artifact_hash, 'a'.repeat(64));
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap, 3);
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap_approval_hash, null);
});

test('exact operator approval persists the aggressive daily cap in task attestation state', async () => {
  const value = await active();
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  assert.throws(
    () => value.task.approveAggressiveDailyEntryCap({ confirm: true, approval: `${mod.DAILY_ENTRY_CAP_5_APPROVAL} ` }),
    /exact_daily_entry_cap/,
  );

  const state = value.task.approveAggressiveDailyEntryCap({
    confirm: true,
    approval: mod.DAILY_ENTRY_CAP_5_APPROVAL,
    invokedBy: 'operator',
  });

  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap, 5);
  assert.equal(
    state.tasks[mod.TASKS[4].id].daily_entry_cap_approval_hash,
    mod.DAILY_ENTRY_CAP_5_APPROVAL_HASH,
  );
  assert.equal(JSON.stringify(state).includes(mod.DAILY_ENTRY_CAP_5_APPROVAL), false);
});

test('order output count is bounded by the task attested cap', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) callback(null, orderGood('no_op', { daily_entry_count: 4 }));
    else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'daily_entry_cap_attestation_mismatch');
});

test('approved cap five is copied into the one-time attestation and accepts count five', async () => {
  let value;
  value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      const files = fs.readdirSync(value.paths.orderAttestationDir);
      assert.equal(files.length, 1);
      const attestation = JSON.parse(fs.readFileSync(path.join(value.paths.orderAttestationDir, files[0]), 'utf8'));
      assert.equal(attestation.daily_entry_cap, 5);
      assert.equal(attestation.daily_entry_cap_approval_hash, mod.DAILY_ENTRY_CAP_5_APPROVAL_HASH);
      callback(null, orderGood('no_op', { daily_entry_count: 5 }));
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  value.task.approveAggressiveDailyEntryCap({ confirm: true, approval: mod.DAILY_ENTRY_CAP_5_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap, 5);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.daily_entry_count, 5);
});

test('post-close promotion with an unattested previous hash pauses without rotation', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      if (args.includes('activation-check')) callback(null, orderGood('success', { action_type: 'activation_check' }));
      else callback(null, orderGood('success', {
        action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
        previous_artifact_hash: 'c'.repeat(64), artifact_hash: 'b'.repeat(64),
      }));
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const stateBefore = value.task.status();
  stateBefore.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T07:20:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(stateBefore));
  value.setClock('2026-07-21T07:20:00.000Z');

  const state = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-21T07:20:00.000Z'),
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'model_v3_artifact_attestation_mismatch');
  assert.equal(state.tasks[mod.TASKS[4].id].activation_artifact_hash, 'a'.repeat(64));
});

test('legacy four-task state migrates order task as disabled', async () => {
  const value = await active();
  const state = value.task.status();
  delete state.tasks[mod.TASKS[4].id];
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  const migrated = value.task.status();
  assert.equal(Object.keys(migrated.tasks).length, 5);
  assert.equal(migrated.tasks[mod.TASKS[4].id].state, 'DISABLED');
});

test('explicit Adaptive ownership metadata conflicts fail closed', async () => {
  const value = await active();
  const state = value.task.status();
  state.canonical_task_id = 'conflicting-task';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));

  const blocked = value.task.status();
  assert.equal(blocked.state, 'PAUSED');
  assert.equal(blocked.pause_reason, 'state_unavailable');
  assert.equal(blocked.scheduler_faulted, true);
});

test('missing legacy Adaptive ownership metadata is backfilled', async () => {
  const value = await active();
  const state = value.task.status();
  delete state.canonical_task_id;
  delete state.task_owner;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));

  const migrated = value.task.status();
  assert.equal(migrated.canonical_task_id, mod.CANONICAL_TASK_ID);
  assert.equal(migrated.task_owner, mod.TASK_OWNER);
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

test('server polling survives DISABLED state and adopts later CLI activation', async () => {
  const callbacks = [];
  let scheduledRuns = 0;
  const value = fixture({
    schedulerRegistered: true,
    serverRegistered: true,
    setTimer(fn) { callbacks.push(fn); return { unref() {} }; },
    clearTimer() {},
    execFile(c, a, o, cb) { scheduledRuns += 1; cb(null, good(a[a.indexOf('--task-id') + 1])); },
  });
  value.task.prepareDisabled();
  value.task.start();
  callbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.length, 1);
  await value.task.activate({ approval: mod.ACTIVATION_APPROVAL });
  value.setClock('2026-07-21T00:10:31Z');
  callbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduledRuns, 1);
  assert.equal(value.task.status().state, 'ACTIVE');
});

test('strict command and output contract reject drift and unsafe fields', () => {
  const command = mod.buildCommand(mod.TASKS[1].id);
  assert.equal(command.command, 'python3'); assert.equal(command.cwd, mod.KIS_REPO);
  assert.equal(command.args.includes('--activation-preflight'), false);
  const trading = () => calendarProof(true);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id), mod.TASKS[1].id, trading));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { unknown: 1 }), mod.TASKS[1].id, trading), /fields/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { fail_closed: undefined }), mod.TASKS[1].id, trading), /fields|boolean/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { report_message: 'app_secret=x' }), mod.TASKS[1].id, trading), /unsafe/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { official_session_state: 'closed' }), mod.TASKS[1].id, trading), /calendar/);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', { action_type: 'market_closed_no_op', official_session_state: 'closed' }), mod.TASKS[1].id, () => calendarProof(false)));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { official_calendar_verified: false }), mod.TASKS[1].id, trading), /calendar/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', { official_calendar_source_hash: 'sha256:fake' }), mod.TASKS[1].id, trading), /calendar/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id), mod.TASKS[1].id, () => ({ isTradingDay: true, sourceHash: `sha256:${'b'.repeat(64)}` })), /proof/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[3].id, 'success'), mod.TASKS[3].id, trading), /task_result/);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', {
    action_type: 'transport_degraded_no_op', error_class: 'timeout', transport_degraded: true,
    failure_phase: 'quote_request', failure_symbol: '005930', failure_exception_type: 'TimeoutError',
    failure_errno: 110, failure_attempt_number: 1,
  }), mod.TASKS[1].id, trading));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', {
    action_type: 'transport_degraded_no_op', error_class: 'tls_failed', transport_degraded: true,
    failure_phase: 'quote_request', failure_symbol: '005930', failure_exception_type: 'SSLError',
    failure_errno: null, failure_attempt_number: 1,
  }), mod.TASKS[1].id, trading), /task_result/);
});

test('quote diagnosis parser requires sanitized exact three-of-three success', () => {
  assert.deepEqual(mod.parseQuoteTransportDiagnosticOutput(diagnostic()), {
    passed: true, symbolsAttempted: 3, symbolsSucceeded: 3, errorClass: 'none',
  });
  const unsafe = JSON.parse(diagnostic());
  unsafe.results[0].detail = 'authorization=private';
  assert.throws(() => mod.parseQuoteTransportDiagnosticOutput(JSON.stringify(unsafe)), /unsafe|fields|result/);
});

test('official calendar proof is bound to the versioned local snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-calendar-'));
  const snapshot = path.join(root, 'calendar.json');
  const payload = {
    metadata: { source_type: 'official', environment: 'live_candidate', is_official: true, valid_for_live_manual_run: true, timezone: 'Asia/Seoul', source_hash: CALENDAR_HASH },
    sessions: [{ trade_date: '2026-07-21', is_trading_day: true, source_hash: CALENDAR_HASH }],
  };
  fs.writeFileSync(snapshot, JSON.stringify(payload));
  assert.deepEqual(mod.loadOfficialCalendarProof('2026-07-21', snapshot), calendarProof(true));
  payload.sessions[0].source_hash = `sha256:${'b'.repeat(64)}`;
  fs.writeFileSync(snapshot, JSON.stringify(payload));
  assert.throws(() => mod.loadOfficialCalendarProof('2026-07-21', snapshot), /proof/);
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

test('active filesystem lock prevents duplicate child execution without overwriting state', async () => {
  let calls = 0;
  const value = await active({ execFile(c, a, o, cb) { calls += 1; cb(null, good(mod.TASKS[0].id)); } });
  const release = mod.acquireExclusiveLock(value.paths.runLockPath);
  value.setClock('2026-07-21T00:00:17Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date('2026-07-21T00:00:17Z') });
  assert.equal(calls, 0); assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[0].id].state, 'ACTIVE');
  release();
});

test('stale filesystem lock pauses visibly without deleting the lock', async () => {
  let calls = 0;
  const value = await active({ execFile(c, a, o, cb) { calls += 1; cb(null, good(mod.TASKS[0].id)); } });
  fs.writeFileSync(value.paths.runLockPath, JSON.stringify({ pid: 999999999, created_at: '2020-01-01T00:00:00.000Z' }));
  value.setClock('2026-07-21T00:00:17Z');

  const state = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date('2026-07-21T00:00:17Z') });

  assert.equal(calls, 0);
  assert.equal(state.state, 'PAUSED');
  assert.equal(state.pause_reason, 'scheduler_lock_stale');
  assert.equal(fs.existsSync(value.paths.runLockPath), true);
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

test('one transient transport no-op stays active, success resets, and consecutive two pauses', async () => {
  let mode = 'degraded';
  const value = await active({ execFile(c, a, o, cb) {
    const taskId = a[a.indexOf('--task-id') + 1];
    if (mode === 'success') cb(null, good(taskId));
    else cb(null, good(taskId, 'no_op', {
      action_type: 'transport_degraded_no_op', error_class: 'timeout', transport_degraded: true,
      failure_phase: 'quote_request', failure_symbol: '005930', failure_exception_type: 'TimeoutError',
      failure_errno: 110, failure_attempt_number: 1,
    }));
  } });
  value.setClock('2026-07-21T00:10:00Z');
  let state = await value.task.runOnce({ taskId: mod.TASKS[1].id, dueAt: new Date('2026-07-21T00:10:00Z') });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[1].id].consecutive_transport_failures, 1);
  mode = 'success'; value.setClock('2026-07-21T00:20:00Z');
  state = await value.task.runOnce({ taskId: mod.TASKS[1].id, dueAt: new Date('2026-07-21T00:20:00Z') });
  assert.equal(state.tasks[mod.TASKS[1].id].consecutive_transport_failures, 0);
  mode = 'degraded'; value.setClock('2026-07-21T00:30:00Z');
  state = await value.task.runOnce({ taskId: mod.TASKS[1].id, dueAt: new Date('2026-07-21T00:30:00Z') });
  assert.equal(state.state, 'ACTIVE');
  value.setClock('2026-07-21T00:40:00Z');
  state = await value.task.runOnce({ taskId: mod.TASKS[1].id, dueAt: new Date('2026-07-21T00:40:00Z') });
  assert.equal(state.state, 'PAUSED');
  assert.equal(Object.values(state.tasks).every((item) => item.state === 'PAUSED'), true);
});

test('one transient supervisor read failure stays active and preserves peer schedules', async () => {
  const value = await active({ execFile(c, a, o, cb) {
    const taskId = a[a.indexOf('--task-id') + 1];
    cb(null, good(taskId, 'no_op', {
      action_type: 'transport_degraded_no_op', error_class: 'http_transport_failed',
      transport_degraded: true, api_calls: 2,
      failure_phase: 'open_orders_read_request', failure_symbol: null,
      failure_exception_type: 'HTTPError', failure_errno: 500,
      failure_attempt_number: 2,
    }));
  } });
  value.setClock('2026-07-21T00:00:00Z');

  const state = await value.task.runOnce({
    taskId: mod.TASKS[0].id,
    dueAt: new Date('2026-07-21T00:00:00Z'),
  });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.pause_reason, undefined);
  assert.equal(state.tasks[mod.TASKS[0].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[0].id].consecutive_transport_failures, 1);
  assert.equal(state.tasks[mod.TASKS[1].id].state, 'ACTIVE');
  assert.notEqual(state.tasks[mod.TASKS[1].id].next_run_at, null);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');

  value.setClock('2026-07-22T00:00:00Z');
  const paused = await value.task.runOnce({
    taskId: mod.TASKS[0].id,
    dueAt: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.pause_reason, 'http_transport_failed');
  assert.equal(Object.values(paused.tasks).every((item) => item.state === 'PAUSED'), true);
});

test('exact IO resume runs 3-of-3 diagnosis and schedules only future slots', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'runtime_io_failed';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  await assert.rejects(value.task.resumeAfterIoFix({ approval: `${mod.RESUME_AFTER_IO_FIX_APPROVAL} ` }), /exact_resume/);
  value.setClock('2026-07-21T00:11:00Z');
  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(new Date(state.tasks[mod.TASKS[1].id].next_run_at).getTime() > new Date('2026-07-21T00:11:00Z').getTime(), true);
  assert.equal(state.retry, false); assert.equal(state.catch_up, false); assert.equal(state.backfill, false);
});

test('IO resume remains paused when health, writer lock, parity, or diagnosis fails', async () => {
  for (const failure of ['health', 'lock', 'parity', 'diagnosis']) {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-resume-lock-'));
    const blockingLock = path.join(lockRoot, 'writer.lock');
    let resumePhase = false;
    const value = await active({
      runtimeHealthCheck: async () => !(resumePhase && failure === 'health'),
      sourceParityCheck: () => failure !== 'parity',
      resumeBlockingLockPaths: [blockingLock],
      diagnosticOutput: failure === 'diagnosis' ? blockedDiagnostic() : diagnostic(),
    });
    const paused = value.task.status();
    paused.state = 'PAUSED'; paused.pause_reason = 'runtime_io_failed';
    for (const item of Object.values(paused.tasks)) {
      item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
    }
    fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
    if (failure === 'lock') fs.writeFileSync(blockingLock, 'active');
    resumePhase = true;
    let rejection = null;
    try { await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }); }
    catch (error) { rejection = error; }
    assert.ok(rejection, `resume should reject on ${failure}`);
    assert.equal(value.task.status().state, 'PAUSED');
  }
  assert.equal(mod.APPROVED_SOURCE_TASK_PATH, '/home/ubuntu/work/personal-hermes-agent/ops/codex-control-dashboard/kis-ai-market-open-dry-run-task.js');
  assert.equal(mod.defaultSourceParityCheck(), false);
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

const report = '[KIS VPS 모의투자 일일 결과]\n기준일: 2026-07-21\n오늘 체결: 매수 삼성전자(005930) 2주; 매도 현대차(005380) 1주\n현재 보유: 삼성전자(005930) 2주\n오늘 실현손익: +1,000원 (현금 증감 기준)\nAI 검증: 판단 3건 / 학습 1회 / 모델 변경 0회\n운영 상태: 정상\n실전계좌: 주문 없음';

test('daily report uses existing sender exactly once and stores status only', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(c, a, o, cb) { cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', report_message: report })); },
  });
  value.setClock('2026-07-21T07:30:29Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:29Z') });
  assert.equal(sent.length, 1); assert.equal(sent[0].targetChannelId, mod.REPORT_TARGET_CHANNEL_ID);
  assert.equal(sent[0].content, report);
  assert.equal(state.tasks[mod.TASKS[3].id].last_run.status, 'report_sent');
  assert.equal(JSON.stringify(state).includes('삼성전자'), false);
});

test('daily report rejects unapproved symbols and price details before delivery', async () => {
  for (const unsafeReport of (
    [
      report.replace('삼성전자(005930)', '미승인종목(999999)'),
      report.replace('2주', '2주 @ 70,000원'),
    ]
  )) {
    let sends = 0;
    const value = await active({
      reportSender: async () => { sends += 1; return { discord_sent: true }; },
      execFile(c, a, o, cb) { cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', report_message: unsafeReport })); },
    });
    value.setClock('2026-07-21T07:30:29Z');
    const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:29Z') });
    assert.equal(state.state, 'PAUSED');
    assert.equal(state.pause_reason, 'invalid_report_message');
    assert.equal(sends, 0);
  }
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
