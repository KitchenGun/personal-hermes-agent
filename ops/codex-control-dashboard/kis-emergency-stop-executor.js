'use strict';

const { execFile } = require('node:child_process');

const KIS_REPO = '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab';
const KIS_PYTHON = '/home/ubuntu/.hermes/venvs/kis-trading-lab/bin/python';
const APPROVAL = 'APPROVE_KIS_DISCORD_STOP_V1';
const TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER_BYTES = 64 * 1024;

const OUTPUT_KEYS = new Set([
  'task_id', 'status', 'latch_persisted', 'open_buys_cancelled',
  'positions_liquidated', 'order_api_calls', 'reconciliation_executed',
  'reconciliation_passed', 'retry', 'fail_closed', 'error_class',
  'execution_owner', 'prod_order_count', 'raw_response_persisted', 'secret_exposure',
]);

function buildCommand({ automaticRiskOff = false } = {}) {
  const args = [
    '-m', 'kis_trading_lab', 'vps-emergency-stop',
    '--execution-owner', 'auto',
    '--confirm',
  ];
  if (automaticRiskOff) args.push('--automatic-risk-off');
  else args.push('--approval', APPROVAL);
  return Object.freeze({
    file: KIS_PYTHON,
    args,
    cwd: KIS_REPO,
  });
}

function parseOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || Buffer.byteLength(lines[0], 'utf8') > 16_384) {
    throw new Error('emergency_stop_output_invalid');
  }
  const value = JSON.parse(lines[0]);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('emergency_stop_output_invalid');
  }
  if (Object.keys(value).some((key) => !OUTPUT_KEYS.has(key))) {
    throw new Error('emergency_stop_output_contract_mismatch');
  }
  if (value.task_id !== 'kis-vps-emergency-stop-v1'
      || !['success', 'blocked'].includes(value.status)
      || value.fail_closed !== true
      || !['vps', 'prod'].includes(value.execution_owner)
      || !Number.isInteger(value.prod_order_count) || value.prod_order_count < 0
      || value.raw_response_persisted !== false
      || value.secret_exposure !== false
      || value.retry !== false
      || (value.status === 'success' && (
        value.latch_persisted !== true
        || value.reconciliation_executed !== true
        || value.reconciliation_passed !== true
      ))) {
    throw new Error('emergency_stop_output_contract_mismatch');
  }
  return Object.freeze({
    status: value.status,
    latch_persisted: value.latch_persisted === true,
    open_buys_cancelled: Number(value.open_buys_cancelled || 0),
    positions_liquidated: Number(value.positions_liquidated || 0),
    reconciliation_passed: value.reconciliation_passed === true,
    reconciliation_executed: value.reconciliation_executed === true,
    execution_owner: value.execution_owner,
    prod_order_count: value.prod_order_count,
    error_class: String(value.error_class || 'emergency_stop_failed').slice(0, 80),
  });
}

function execute(options = {}) {
  const exec = options.execFile || execFile;
  const command = buildCommand({ automaticRiskOff: options.automaticRiskOff === true });
  return new Promise((resolve) => {
    exec(command.file, command.args, {
      cwd: command.cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        try {
          const parsed = parseOutput(stdout);
          resolve(parsed);
        } catch {
          resolve(Object.freeze({
            status: 'blocked',
            latch_persisted: false,
            open_buys_cancelled: 0,
            positions_liquidated: 0,
            reconciliation_passed: false,
            execution_owner: 'unknown',
            prod_order_count: 0,
            error_class: error.killed ? 'timeout' : 'emergency_stop_execution_failed',
          }));
        }
        return;
      }
      try {
        resolve(parseOutput(stdout));
      } catch {
        resolve(Object.freeze({
          status: 'blocked',
          latch_persisted: false,
          open_buys_cancelled: 0,
          positions_liquidated: 0,
          reconciliation_passed: false,
          execution_owner: 'unknown',
          prod_order_count: 0,
          error_class: 'emergency_stop_output_invalid',
        }));
      }
    });
  });
}

module.exports = {
  APPROVAL,
  KIS_PYTHON,
  KIS_REPO,
  MAX_BUFFER_BYTES,
  TIMEOUT_MS,
  buildCommand,
  execute,
  parseOutput,
};
