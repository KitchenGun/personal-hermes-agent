'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  FIXED_MODEL_ID,
  MAX_TIMEOUT_MS,
  createHermesLlmVerdictExecutor,
} = require('./kis-llm-verdict-executor');

function packet() {
  return {
    slot_id: 'kis-vps-model-v3-autonomous-pilot-v1:2026-07-27:09:10',
    model_id: FIXED_MODEL_ID,
    prompt_hash: 'a'.repeat(64),
    candidates: [{ symbol: '005930' }],
    risk_aggregate: { minimum_vps_entry_decisions: 0 },
    decision_contract: { actions: ['ENTER', 'HOLD'], minimum_vps_entry_decisions: 0 },
  };
}

test('uses fixed Hermes model with safe mode and an empty toolset', async () => {
  const calls = [];
  const executor = createHermesLlmVerdictExecutor({
    hermesBin: '/opt/hermes',
    execMode: 'direct',
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, '{"ok":true}\n', 'ignored');
    },
  });

  assert.equal(await executor({ model: FIXED_MODEL_ID, timeoutMs: 180_000, packet: packet() }), '{"ok":true}');
  assert.equal(calls[0].file, '/opt/hermes');
  assert.deepEqual(calls[0].args.slice(0, 7), [
    '--safe-mode', '--ignore-rules', '--toolsets', '', '--model', FIXED_MODEL_ID, '--oneshot',
  ]);
  assert.equal(calls[0].options.timeout, MAX_TIMEOUT_MS);
  assert.equal(MAX_TIMEOUT_MS, 120_000);
  assert.match(calls[0].args[7], /Do not call tools/);
  assert.match(calls[0].args[7], /exactly one decision for every supplied candidate/);
  assert.match(calls[0].args[7], /Never force a trade/);
  assert.match(calls[0].args[7], /ml_action is advisory/);
  assert.match(calls[0].args[7], /null means unavailable, never zero/);
  assert.match(calls[0].args[7], /not a calibrated or cost-adjusted profit forecast/);
  assert.match(calls[0].args[7], /KIS risk veto remains final/);
  assert.doesNotMatch(calls[0].args[7], /choose exactly one eligible_entry/);
});

test('rejects model drift before spawning Hermes', async () => {
  let calls = 0;
  const executor = createHermesLlmVerdictExecutor({ execFile() { calls += 1; } });

  await assert.rejects(
    executor({ model: 'fallback-model', timeoutMs: 1000, packet: packet() }),
    /llm_verdict_contract_unavailable/,
  );
  assert.equal(calls, 0);
});

test('maps a killed Hermes process to the bounded timeout class', async () => {
  const executor = createHermesLlmVerdictExecutor({
    execFile(file, args, options, callback) { callback(Object.assign(new Error('killed'), { killed: true }), '', ''); },
  });

  await assert.rejects(
    executor({ model: FIXED_MODEL_ID, timeoutMs: 1000, packet: packet() }),
    /llm_response_timeout/,
  );
});

test('aborting Hermes waits for ChildProcess close after an early exec callback', async () => {
  const controller = new AbortController();
  let callback;
  const child = new EventEmitter();
  child.closed = false;
  let receivedSignal;
  let settled = false;
  const executor = createHermesLlmVerdictExecutor({
    execFile(file, args, options, done) { receivedSignal = options.signal; callback = done; return child; },
  });
  const pending = executor({ model: FIXED_MODEL_ID, timeoutMs: 1000, packet: packet(), signal: controller.signal });
  pending.finally(() => { settled = true; }).catch(() => {});
  assert.equal(receivedSignal, controller.signal);
  controller.abort();
  callback(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), '', '');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.closed = true;
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, /llm_cancelled/);
  assert.equal(settled, true);
});

test('generic child errors wait for close and never become successful verdict text', async () => {
  const child = new EventEmitter();
  let callback;
  let settled = false;
  const executor = createHermesLlmVerdictExecutor({
    execFile(file, args, options, done) { callback = done; return child; },
  });
  const pending = executor({ model: FIXED_MODEL_ID, timeoutMs: 1000, packet: packet() });
  pending.finally(() => { settled = true; }).catch(() => {});
  callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), 'valid-looking-json', '');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit('close', -2, null);
  await assert.rejects(pending, /llm_verdict_contract_unavailable/);
  assert.equal(settled, true);
});

test('a close event before the callback still settles only from the callback outcome', async () => {
  const child = new EventEmitter();
  let callback;
  const expected = '{"bounded":"result"}';
  const executor = createHermesLlmVerdictExecutor({
    execFile(file, args, options, done) { callback = done; return child; },
  });
  const pending = executor({ model: FIXED_MODEL_ID, timeoutMs: 1000, packet: packet() });
  child.emit('close', 0, null);
  callback(null, expected, '');
  assert.equal(await pending, expected);
});

test('an already-aborted request is rejected without spawning Hermes', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const executor = createHermesLlmVerdictExecutor({
    execFile() { calls += 1; throw new Error('must not spawn'); },
  });
  await assert.rejects(executor({ model: FIXED_MODEL_ID, timeoutMs: 1000, packet: packet(),
    signal: controller.signal }), /llm_cancelled/);
  assert.equal(calls, 0);
});
