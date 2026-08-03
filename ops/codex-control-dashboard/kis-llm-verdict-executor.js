'use strict';

const { execFile: defaultExecFile } = require('node:child_process');

const FIXED_MODEL_ID = 'gpt-5.6-terra';
const MAX_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 64 * 1024;

function commandFor(execMode, hermesBin, args) {
  return execMode === 'direct'
    ? { file: hermesBin, args }
    : { file: 'wsl.exe', args: ['--exec', hermesBin, ...args] };
}

function buildPrompt(packet) {
  return [
    'You are the bounded KIS trade adjudicator.',
    'Do not call tools, browse, modify files, or perform broker actions.',
    'Choose only symbols present in candidates and return one raw JSON object with no markdown.',
    'Use exactly slot_id, model_id, prompt_hash, decisions.',
    'Each decision must use symbol, action, target_weight_pct, confidence_bucket, reason_codes.',
    'Respect the decision_contract exactly. When minimum_vps_entry_decisions is 1, choose exactly one eligible_entry as ENTER with positive target_weight_pct; KIS risk veto remains final.',
    'When minimum_vps_entry_decisions is 0 and evidence is weak, use HOLD or REJECT.',
    `INPUT_JSON=${JSON.stringify(packet)}`,
  ].join('\n');
}

function createHermesLlmVerdictExecutor(options = {}) {
  const execFile = options.execFile || defaultExecFile;
  const hermesBin = options.hermesBin || process.env.HERMES_BIN || '/home/ubuntu/.local/bin/hermes';
  const execMode = options.execMode || process.env.HERMES_EXEC_MODE || 'direct';
  return ({ model, timeoutMs, packet }) => new Promise((resolve, reject) => {
    if (model !== FIXED_MODEL_ID || !packet || typeof packet !== 'object' || Array.isArray(packet)) {
      reject(new Error('llm_verdict_contract_unavailable'));
      return;
    }
    const timeout = Math.min(Math.max(1, Number(timeoutMs) || MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const args = [
      '--safe-mode',
      '--ignore-rules',
      '--toolsets', '',
      '--model', FIXED_MODEL_ID,
      '--oneshot', buildPrompt(packet),
    ];
    const command = commandFor(execMode, hermesBin, args);
    execFile(command.file, command.args, { timeout, maxBuffer: MAX_BUFFER_BYTES }, (error, stdout) => {
      if (error) {
        reject(new Error(error.killed ? 'llm_response_timeout' : 'llm_verdict_contract_unavailable'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

module.exports = {
  FIXED_MODEL_ID,
  MAX_TIMEOUT_MS,
  createHermesLlmVerdictExecutor,
};
