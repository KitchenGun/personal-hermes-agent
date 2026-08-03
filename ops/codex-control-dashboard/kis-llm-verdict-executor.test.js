'use strict';

const assert = require('node:assert/strict');
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
    risk_aggregate: { minimum_vps_entry_decisions: 1 },
    decision_contract: { actions: ['ENTER', 'HOLD'], minimum_vps_entry_decisions: 1 },
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

  assert.equal(await executor({ model: FIXED_MODEL_ID, timeoutMs: 90_000, packet: packet() }), '{"ok":true}');
  assert.equal(calls[0].file, '/opt/hermes');
  assert.deepEqual(calls[0].args.slice(0, 7), [
    '--safe-mode', '--ignore-rules', '--toolsets', '', '--model', FIXED_MODEL_ID, '--oneshot',
  ]);
  assert.equal(calls[0].options.timeout, MAX_TIMEOUT_MS);
  assert.match(calls[0].args[7], /Do not call tools/);
  assert.match(calls[0].args[7], /minimum_vps_entry_decisions is 1/);
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
