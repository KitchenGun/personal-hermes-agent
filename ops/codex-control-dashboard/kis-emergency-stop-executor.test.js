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
