'use strict';

const TASK_ID = 'kis-prediction-v2-validation';
const TASK_NAME = 'KIS Prediction V2 Validation';
const TASK_OWNER = 'hermes';
const TASK_STATE = 'DISABLED';
const KIS_REPO = '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab';
const KIS_APPROVAL = 'APPROVE_KIS_MODEL_V2_BOUNDED_VALIDATION_START_V1';
const VPS_MOCK_DB_PATH = '/var/lib/kis-trading-lab/kis-vps.sqlite3';
const PROD_DB_PATH = '/var/lib/kis-trading-lab/kis-prod.sqlite3';
const MAX_DISTINCT_TRADING_DAYS = 20;
const MAX_CONCURRENT_RUNS = 1;
const RETRY_ON_FAILURE = false;

const ALLOWED_ACTIONS = new Set([
  'reconcile_only',
  'predict_only',
  'reconcile_then_predict',
  'idempotent_no_op',
  'market_closed_no_op',
  'waiting_for_horizon',
  'paused',
  'completed',
]);
const SAFE_OUTPUT_KEYS = new Set([
  'status',
  'action',
  'blocked',
  'automation_paused',
  'completed',
  'db_opened',
  'db_written',
  'schema_evidence_checked',
  'integrity_checked',
  'prediction_inserted_count',
  'outcome_inserted_count',
  'pending_matured_count',
  'distinct_decision_day_count',
  'api_called',
  'order_attempted',
  'scheduler_changed',
  'cron_changed',
  'raw_values_printed',
  'executed',
  'action_type',
  'prediction_horizon',
  'target_definition',
  'timezone',
  'prediction_window',
  'reconciliation_window',
  'max_distinct_trading_days',
  'market_data_api_calls',
  'predictions_inserted',
  'outcomes_resolved',
  'distinct_trading_days',
  'total_predictions',
  'resolved_predictions',
  'correct_predictions',
  'incorrect_predictions',
  'neutral_predictions',
  'pending_predictions',
  'paper_trade_count',
  'live_trade_count',
  'sample_status',
  'fail_closed',
  'error_class',
  'prod_db_touched',
  'secret_exposed',
  'raw_response_persisted',
  'new_nonessential_features',
]);
const BOOLEAN_KEYS = new Set([
  'blocked',
  'automation_paused',
  'completed',
  'db_opened',
  'db_written',
  'schema_evidence_checked',
  'integrity_checked',
  'api_called',
  'order_attempted',
  'scheduler_changed',
  'cron_changed',
  'raw_values_printed',
  'executed',
  'fail_closed',
  'prod_db_touched',
  'secret_exposed',
  'raw_response_persisted',
  'new_nonessential_features',
]);
const NUMBER_KEYS = new Set([
  'prediction_inserted_count',
  'outcome_inserted_count',
  'pending_matured_count',
  'distinct_decision_day_count',
  'max_distinct_trading_days',
  'market_data_api_calls',
  'predictions_inserted',
  'outcomes_resolved',
  'distinct_trading_days',
  'total_predictions',
  'resolved_predictions',
  'correct_predictions',
  'incorrect_predictions',
  'neutral_predictions',
  'pending_predictions',
  'paper_trade_count',
  'live_trade_count',
]);
const FIXED_TEXT_FIELDS = Object.freeze({
  prediction_horizon: 'next_session',
  target_definition: 'direction_label_next_session_from_chart_features',
  timezone: 'Asia/Seoul',
  prediction_window: '15:30-17:50 Asia/Seoul',
  reconciliation_window: 'after_next_official_session_quote_available',
});
const STATUS_ACTIONS = new Map([
  ['ready', new Set(['predict_only', 'reconcile_only', 'reconcile_then_predict', 'idempotent_no_op'])],
  ['waiting', new Set(['waiting_for_horizon'])],
  ['market_closed_no_op', new Set(['market_closed_no_op'])],
  ['completed', new Set(['completed'])],
  ['blocked', new Set(['paused'])],
]);
const POSITIVE_STATUSES = new Set(['ready', 'waiting', 'market_closed_no_op', 'completed']);
const AGGREGATE_COUNT_KEYS = [...NUMBER_KEYS].filter((key) => key !== 'max_distinct_trading_days');
const SECRET_LIKE_RE = /(Bearer\s+[A-Za-z0-9._-]+|app[_-]?secret|app[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client_secret|[A-Za-z0-9+/]{64,}={0,2})/ig;

function sanitizeText(value, maxLength = 160) {
  return String(value ?? '')
    .replace(SECRET_LIKE_RE, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function boolValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function numberValue(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseKisV2CliOutput(stdout) {
  const result = {};
  const invalidActionKeys = new Set();
  const seenKeys = new Set();
  const duplicateKeys = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!SAFE_OUTPUT_KEYS.has(key)) continue;
    if (seenKeys.has(key)) {
      duplicateKeys.add(key);
      continue;
    }
    seenKeys.add(key);
    const raw = line.slice(index + 1).trim();
    if (key === 'action' || key === 'action_type') {
      if (ALLOWED_ACTIONS.has(raw)) result[key] = raw;
      else invalidActionKeys.add(key);
    } else if (BOOLEAN_KEYS.has(key)) {
      const parsed = boolValue(raw);
      if (parsed !== undefined) result[key] = parsed;
    } else if (NUMBER_KEYS.has(key)) {
      const parsed = numberValue(raw);
      if (parsed !== undefined) result[key] = parsed;
    } else result[key] = sanitizeText(raw);
  }
  for (const key of invalidActionKeys) delete result[key];
  for (const key of duplicateKeys) delete result[key];
  return result;
}

function buildCommand(config = {}) {
  const targetDbPath = config.targetDbPath === undefined ? VPS_MOCK_DB_PATH : config.targetDbPath;
  if (targetDbPath !== VPS_MOCK_DB_PATH || targetDbPath === PROD_DB_PATH) {
    throw new Error('noncanonical_or_prod_db_path_blocked');
  }
  if (config.kisRepo !== undefined && config.kisRepo !== KIS_REPO) {
    throw new Error('fixed_kis_repo_required');
  }
  if (config.python !== undefined && config.python !== 'python3') {
    throw new Error('fixed_python_command_required');
  }
  return {
    command: 'python3',
    args: ['-m', 'kis_trading_lab', 'prediction-v2-validation-auto-once', '--approval', KIS_APPROVAL, '--db', targetDbPath],
    cwd: KIS_REPO,
    targetDbPath,
  };
}

function hasExactOutputKeys(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  const keys = Object.keys(summary);
  return keys.length === SAFE_OUTPUT_KEYS.size
    && [...SAFE_OUTPUT_KEYS].every((key) => Object.prototype.hasOwnProperty.call(summary, key));
}

function hasValidTypedOutput(summary) {
  return [...BOOLEAN_KEYS].every((key) => typeof summary[key] === 'boolean')
    && [...NUMBER_KEYS].every((key) => Number.isSafeInteger(summary[key]) && summary[key] >= 0);
}

function hasValidFixedContract(summary) {
  return Object.entries(FIXED_TEXT_FIELDS).every(([key, value]) => summary[key] === value)
    && summary.max_distinct_trading_days === MAX_DISTINCT_TRADING_DAYS;
}

function hasValidStatusContract(summary) {
  const expectedActions = STATUS_ACTIONS.get(summary.status);
  if (!expectedActions || !expectedActions.has(summary.action) || summary.action !== summary.action_type) return false;

  const isBlocked = summary.status === 'blocked';
  const isCompleted = summary.status === 'completed';
  const expectedErrorClass = isBlocked ? 'blocked' : 'none';
  if (summary.blocked !== isBlocked
    || summary.fail_closed !== isBlocked
    || summary.automation_paused !== (isBlocked || isCompleted)
    || summary.completed !== isCompleted
    || summary.sample_status !== summary.status
    || summary.error_class !== expectedErrorClass) return false;

  if (isCompleted) return summary.distinct_trading_days === MAX_DISTINCT_TRADING_DAYS;
  if (POSITIVE_STATUSES.has(summary.status)) return summary.distinct_trading_days < MAX_DISTINCT_TRADING_DAYS;
  return isBlocked;
}

function hasValidCountContract(summary) {
  return summary.prediction_inserted_count === summary.predictions_inserted
    && summary.outcome_inserted_count === summary.outcomes_resolved
    && summary.distinct_decision_day_count === summary.distinct_trading_days
    && summary.pending_predictions === summary.total_predictions - summary.resolved_predictions
    && summary.resolved_predictions === summary.correct_predictions
      + summary.incorrect_predictions + summary.neutral_predictions;
}

function hasValidActionSemantics(summary) {
  const predictionsInserted = summary.predictions_inserted;
  const outcomesResolved = summary.outcomes_resolved;
  switch (summary.action) {
    case 'idempotent_no_op':
      return predictionsInserted === 0 && outcomesResolved === 0 && summary.db_written === false;
    case 'predict_only':
      return predictionsInserted === 3 && outcomesResolved === 0 && summary.db_written === true;
    case 'reconcile_then_predict':
      return predictionsInserted === 3 && outcomesResolved > 0 && summary.db_written === true;
    case 'reconcile_only':
      return predictionsInserted === 0 && outcomesResolved > 0 && summary.db_written === true;
    default:
      return false;
  }
}

function hasValidPositiveSemantics(summary) {
  if (!POSITIVE_STATUSES.has(summary.status)) return true;
  if (summary.total_predictions !== summary.distinct_trading_days * 3) return false;
  if (summary.db_written !== (summary.predictions_inserted + summary.outcomes_resolved > 0)) return false;
  if (summary.schema_evidence_checked && (!summary.db_opened || !summary.integrity_checked)) return false;

  if (summary.status === 'ready') {
    return summary.executed === true
      && summary.db_opened === true
      && summary.integrity_checked === true
      && hasValidActionSemantics(summary);
  }
  if (summary.status === 'waiting') {
    const preWindow = summary.executed === false && summary.db_opened === false && summary.integrity_checked === false;
    const postDb = summary.executed === true && summary.db_opened === true && summary.integrity_checked === true;
    return summary.predictions_inserted === 0
      && summary.outcomes_resolved === 0
      && summary.db_written === false
      && (preWindow || postDb);
  }
  if (summary.status === 'market_closed_no_op') {
    return summary.executed === false
      && summary.db_opened === false
      && summary.db_written === false
      && summary.integrity_checked === false
      && AGGREGATE_COUNT_KEYS.every((key) => summary[key] === 0);
  }
  if (summary.status === 'completed') {
    const validInsertPattern = summary.predictions_inserted === 0 || summary.predictions_inserted === 3;
    return summary.executed === true
      && summary.db_opened === true
      && summary.integrity_checked === true
      && summary.distinct_trading_days === MAX_DISTINCT_TRADING_DAYS
      && validInsertPattern;
  }
  return false;
}

function hasSafeExternalEffects(summary) {
  return summary.api_called === false
    && summary.market_data_api_calls === 0
    && summary.paper_trade_count === 0
    && summary.live_trade_count === 0
    && summary.order_attempted === false
    && summary.scheduler_changed === false
    && summary.cron_changed === false
    && summary.raw_values_printed === false
    && summary.prod_db_touched === false
    && summary.secret_exposed === false
    && summary.raw_response_persisted === false
    && summary.new_nonessential_features === false;
}

function mapSummaryToTaskState(summary = {}) {
  const validContract = hasExactOutputKeys(summary)
    && hasValidTypedOutput(summary)
    && hasValidFixedContract(summary)
    && hasValidStatusContract(summary)
    && hasValidCountContract(summary)
    && hasValidPositiveSemantics(summary)
    && hasSafeExternalEffects(summary);

  if (!validContract) return { state: 'PAUSED', reason: 'invalid_stage_p_contract' };
  if (summary.status === 'blocked') return { state: 'PAUSED', reason: 'blocked' };
  if (summary.status === 'completed') {
    return { state: 'COMPLETED', reason: 'minimum_distinct_trading_days_reached' };
  }
  return { state: 'DISABLED', reason: 'disabled_only_no_execution' };
}

function defaultState(overrides = {}) {
  return {
    canonical_task_id: TASK_ID,
    task_name: TASK_NAME,
    task_owner: TASK_OWNER,
    last_run: null,
    ...overrides,
    state: TASK_STATE,
    max_distinct_trading_days: MAX_DISTINCT_TRADING_DAYS,
    max_concurrent_runs: MAX_CONCURRENT_RUNS,
    retry: false,
    retry_on_failure: RETRY_ON_FAILURE,
    orders_enabled: false,
    live_execution_enabled: false,
    scheduler_registered: false,
    server_registered: false,
  };
}

function createKisPredictionV2ValidationTask(options = {}) {
  const state = defaultState(options.state);
  let running = false;

  function status() {
    return { ...state, last_run: state.last_run && { ...state.last_run } };
  }

  function prepareDisabled() {
    return status();
  }

  function runOnce({ invokedBy = 'hermes' } = {}) {
    if (running) {
      state.last_run = {
        status: 'skipped',
        action_type: 'idempotent_no_op',
        error_class: 'previous_run_active',
        duplicate_execution_prevented: true,
        invoked_by: sanitizeText(invokedBy, 80),
      };
      return Promise.resolve(status());
    }

    running = true;
    return Promise.resolve()
      .then(() => {
        state.last_run = {
          status: 'skipped',
          action_type: 'idempotent_no_op',
          error_class: 'disabled_only_no_execution',
          invoked_by: sanitizeText(invokedBy, 80),
        };
        return status();
      })
      .finally(() => {
        running = false;
      });
  }

  return { status, prepareDisabled, runOnce, buildCommand: () => buildCommand(options) };
}

module.exports = {
  TASK_ID,
  TASK_NAME,
  TASK_OWNER,
  TASK_STATE,
  KIS_REPO,
  KIS_APPROVAL,
  VPS_MOCK_DB_PATH,
  PROD_DB_PATH,
  MAX_DISTINCT_TRADING_DAYS,
  MAX_CONCURRENT_RUNS,
  RETRY_ON_FAILURE,
  ALLOWED_ACTIONS,
  SAFE_OUTPUT_KEYS,
  parseKisV2CliOutput,
  mapSummaryToTaskState,
  buildCommand,
  createKisPredictionV2ValidationTask,
};
