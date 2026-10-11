'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const mod = require('./kis-emergency-stop-executor');

function output(overrides = {}) {
  return JSON.stringify({
    task_id: 'kis-vps-emergency-stop-v1',
    status: 'success',
    latch_persisted: true,
    open_buys_cancelled: 1,
    positions_liquidated: 2,
    order_api_calls: 3,
    reconciliation_executed: true,
    reconciliation_passed: true,
    retry: false,
    fail_closed: true,
    error_class: 'persistent_stop_active',
    execution_owner: 'vps',
    prod_order_count: 0,
    raw_response_persisted: false,
    secret_exposure: false,
    ...overrides,
  });
}

test('builds the exact bounded KIS emergency command without secret arguments', () => {
  const command = mod.buildCommand();
  assert.equal(command.file, mod.KIS_PYTHON);
  assert.equal(command.cwd, mod.KIS_REPO);
  assert.deepEqual(command.args, [
    '-m', 'kis_trading_lab', 'vps-emergency-stop',
    '--execution-owner', 'auto', '--confirm', '--approval', mod.APPROVAL,
  ]);
  assert.doesNotMatch(command.args.join(' '), /token|secret|account/i);
});

test('parses only the sanitized fail-closed contract', () => {
  assert.deepEqual(mod.parseOutput(output()), {
    status: 'success',
    latch_persisted: true,
    open_buys_cancelled: 1,
    positions_liquidated: 2,
    reconciliation_executed: true,
    reconciliation_passed: true,
    execution_owner: 'vps',
    prod_order_count: 0,
    error_class: 'persistent_stop_active',
    operator_action_required: false,
  });
  assert.throws(() => mod.parseOutput(output({ retry: true })), /contract_mismatch/);
  assert.throws(() => mod.parseOutput(output({ latch_persisted: false })), /contract_mismatch/);
  assert.throws(() => mod.parseOutput(output({ reconciliation_executed: false })), /contract_mismatch/);
  assert.throws(() => mod.parseOutput(output({ raw_body: 'forbidden' })), /contract_mismatch/);
});

test('builds automatic risk-off command without reusing Discord approval', () => {
  const command = mod.buildCommand({ automaticRiskOff: true });
  assert.deepEqual(command.args, [
    '-m', 'kis_trading_lab', 'vps-emergency-stop',
    '--execution-owner', 'auto', '--confirm', '--automatic-risk-off',
  ]);
  assert.equal(command.args.includes(mod.APPROVAL), false);
});

test('accepts a sanitized prod liquidation count', () => {
  const parsed = mod.parseOutput(output({ execution_owner: 'prod', prod_order_count: 2 }));
  assert.equal(parsed.execution_owner, 'prod');
  assert.equal(parsed.prod_order_count, 2);
});

test('executes once and never retries a blocked emergency result', async () => {
  let calls = 0;
  const result = await mod.execute({
    execFile(_file, _args, _options, callback) {
      calls += 1;
      callback(Object.assign(new Error('blocked'), { code: 2 }), output({
        status: 'blocked',
        positions_liquidated: 0,
        reconciliation_passed: false,
        error_class: 'open_buy_cancel_unconfirmed',
      }), 'not persisted');
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error_class, 'open_buy_cancel_unconfirmed');
});

function latchOnlyOutput(overrides = {}) {
  return output({
    status: 'blocked',
    latch_persisted: true,
    open_buys_cancelled: 0,
    positions_liquidated: 0,
    order_api_calls: 0,
    reconciliation_executed: false,
    reconciliation_passed: false,
    error_class: 'emergency_stop_latch_only_no_order_authority',
    execution_owner: 'disabled',
    operator_action_required: true,
    ...overrides,
  });
}

test('parses a latch-only blocked result when the owner has no order authority', () => {
  for (const owner of ['disabled', 'unknown']) {
    assert.deepEqual(mod.parseOutput(latchOnlyOutput({ execution_owner: owner })), {
      status: 'blocked',
      latch_persisted: true,
      open_buys_cancelled: 0,
      positions_liquidated: 0,
      reconciliation_executed: false,
      reconciliation_passed: false,
      execution_owner: owner,
      prod_order_count: 0,
      error_class: 'emergency_stop_latch_only_no_order_authority',
      operator_action_required: true,
    });
  }
  const early = mod.parseOutput(output({
    status: 'blocked', latch_persisted: false, open_buys_cancelled: 0, positions_liquidated: 0,
    order_api_calls: 0, reconciliation_executed: false, reconciliation_passed: false,
    error_class: 'kill_latch_persist_failed', execution_owner: 'unknown',
  }));
  assert.equal(early.status, 'blocked');
  assert.equal(early.latch_persisted, false);
  assert.equal(early.error_class, 'kill_latch_persist_failed');
  assert.equal(early.operator_action_required, false);
});

test('owner without order authority can never report success or broker activity', () => {
  for (const owner of ['disabled', 'unknown', 'paper']) {
    assert.throws(() => mod.parseOutput(output({ execution_owner: owner })), /contract_mismatch/);
  }
  assert.throws(() => mod.parseOutput(latchOnlyOutput({ execution_owner: 'paper' })), /contract_mismatch/);
  for (const drift of [
    { order_api_calls: 1 },
    { open_buys_cancelled: 1 },
    { positions_liquidated: 1 },
    { prod_order_count: 1 },
    { reconciliation_executed: true },
    { reconciliation_passed: true },
    { operator_action_required: false },
    { operator_action_required: 'yes' },
  ]) {
    assert.throws(() => mod.parseOutput(latchOnlyOutput(drift)), /contract_mismatch/, JSON.stringify(drift));
  }
  assert.throws(() => mod.parseOutput(output({ operator_action_required: 'yes' })), /contract_mismatch/);
});

test('latch-only exit-two output reaches the caller with latch and operator flags intact', async () => {
  let calls = 0;
  const result = await mod.execute({
    execFile(file, args, _options, callback) {
      calls += 1;
      assert.equal(file, mod.KIS_PYTHON);
      assert.deepEqual(args.slice(3, 6), ['--execution-owner', 'auto', '--confirm']);
      callback(Object.assign(new Error('blocked'), { code: 2 }), `${latchOnlyOutput()}\n`, '');
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.error_class, 'emergency_stop_latch_only_no_order_authority');
  assert.equal(result.status, 'blocked');
  assert.equal(result.latch_persisted, true);
  assert.equal(result.operator_action_required, true);
  assert.equal(result.execution_owner, 'disabled');
  // Fields read by the Discord /kis-stop message builder (automation-runtime.js).
  assert.equal(result.reconciliation_passed, false);
  assert.equal(result.open_buys_cancelled, 0);
  assert.equal(result.positions_liquidated, 0);
});
