const assert = require('node:assert/strict');

const taskModule = require('./kis-prediction-v2-validation-task');

const STAGE_P_OUTPUT_KEYS = [
  'status', 'action', 'blocked', 'automation_paused', 'completed', 'db_opened', 'db_written',
  'schema_evidence_checked', 'integrity_checked', 'prediction_inserted_count', 'outcome_inserted_count',
  'pending_matured_count', 'distinct_decision_day_count', 'api_called', 'order_attempted',
  'scheduler_changed', 'cron_changed', 'raw_values_printed', 'executed', 'action_type',
  'prediction_horizon', 'target_definition', 'timezone', 'prediction_window', 'reconciliation_window',
  'max_distinct_trading_days', 'market_data_api_calls', 'predictions_inserted', 'outcomes_resolved',
  'distinct_trading_days', 'total_predictions', 'resolved_predictions', 'correct_predictions',
  'incorrect_predictions', 'neutral_predictions', 'pending_predictions', 'paper_trade_count',
  'live_trade_count', 'sample_status', 'fail_closed', 'error_class', 'prod_db_touched',
  'secret_exposed', 'raw_response_persisted', 'new_nonessential_features',
];
const STAGE_P_ACTIONS = [
  'reconcile_only', 'predict_only', 'reconcile_then_predict', 'idempotent_no_op',
  'market_closed_no_op', 'waiting_for_horizon', 'paused', 'completed',
];

function v2Output(overrides = {}) {
  const base = {
    status: 'ready',
    action: 'idempotent_no_op',
    blocked: false,
    automation_paused: false,
    completed: false,
    db_opened: true,
    db_written: false,
    schema_evidence_checked: true,
    integrity_checked: true,
    prediction_inserted_count: 0,
    outcome_inserted_count: 0,
    pending_matured_count: 0,
    distinct_decision_day_count: 1,
    api_called: false,
    order_attempted: false,
    scheduler_changed: false,
    cron_changed: false,
    raw_values_printed: false,
    executed: true,
    action_type: 'idempotent_no_op',
    prediction_horizon: 'next_session',
    target_definition: 'direction_label_next_session_from_chart_features',
    timezone: 'Asia/Seoul',
    prediction_window: '15:30-17:50 Asia/Seoul',
    reconciliation_window: 'after_next_official_session_quote_available',
    max_distinct_trading_days: 20,
    market_data_api_calls: 0,
    predictions_inserted: 0,
    outcomes_resolved: 0,
    distinct_trading_days: 1,
    total_predictions: 3,
    resolved_predictions: 0,
    correct_predictions: 0,
    incorrect_predictions: 0,
    neutral_predictions: 0,
    pending_predictions: 3,
    paper_trade_count: 0,
    live_trade_count: 0,
    sample_status: 'ready',
    fail_closed: false,
    error_class: 'none',
    prod_db_touched: false,
    secret_exposed: false,
    raw_response_persisted: false,
    new_nonessential_features: false,
  };
  return Object.entries({ ...base, ...overrides }).map(([key, value]) => `${key}=${value}`).join('\n');
}

function completionOverrides(overrides = {}) {
  return {
    status: 'completed',
    action: 'completed',
    action_type: 'completed',
    automation_paused: true,
    completed: true,
    distinct_decision_day_count: 20,
    distinct_trading_days: 20,
    total_predictions: 60,
    pending_predictions: 60,
    sample_status: 'completed',
    ...overrides,
  };
}

function zeroAggregateOverrides() {
  return {
    prediction_inserted_count: 0,
    outcome_inserted_count: 0,
    pending_matured_count: 0,
    distinct_decision_day_count: 0,
    market_data_api_calls: 0,
    predictions_inserted: 0,
    outcomes_resolved: 0,
    distinct_trading_days: 0,
    total_predictions: 0,
    resolved_predictions: 0,
    correct_predictions: 0,
    incorrect_predictions: 0,
    neutral_predictions: 0,
    pending_predictions: 0,
    paper_trade_count: 0,
    live_trade_count: 0,
  };
}

function waitingPreWindowOverrides(overrides = {}) {
  return {
    ...zeroAggregateOverrides(),
    status: 'waiting',
    action: 'waiting_for_horizon',
    action_type: 'waiting_for_horizon',
    sample_status: 'waiting',
    executed: false,
    db_opened: false,
    schema_evidence_checked: false,
    integrity_checked: false,
    ...overrides,
  };
}

function marketClosedOverrides(overrides = {}) {
  return {
    ...zeroAggregateOverrides(),
    status: 'market_closed_no_op',
    action: 'market_closed_no_op',
    action_type: 'market_closed_no_op',
    sample_status: 'market_closed_no_op',
    executed: false,
    db_opened: false,
    schema_evidence_checked: false,
    integrity_checked: false,
    ...overrides,
  };
}

function withoutKey(output, key) {
  return output.split('\n').filter((line) => !line.startsWith(`${key}=`)).join('\n');
}

function testExactCommandAndCanonicalPath() {
  const command = taskModule.buildCommand();
  assert.equal(command.command, 'python3');
  assert.deepEqual(command.args, ['-m', 'kis_trading_lab', 'prediction-v2-validation-auto-once', '--approval', 'APPROVE_KIS_MODEL_V2_BOUNDED_VALIDATION_START_V1', '--db', taskModule.VPS_MOCK_DB_PATH]);
  assert.equal(command.cwd, '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab');
  assert.equal(command.targetDbPath, taskModule.VPS_MOCK_DB_PATH);
  assert.throws(() => taskModule.buildCommand({ targetDbPath: taskModule.PROD_DB_PATH }), /noncanonical_or_prod_db_path_blocked/);
  assert.throws(() => taskModule.buildCommand({ targetDbPath: '/tmp/kis.sqlite3' }), /noncanonical_or_prod_db_path_blocked/);
  for (const targetDbPath of ['', null, false, 0]) {
    assert.throws(() => taskModule.buildCommand({ targetDbPath }), /noncanonical_or_prod_db_path_blocked/);
  }
  assert.throws(() => taskModule.buildCommand({ kisRepo: '/tmp/kis-trading-lab' }), /fixed_kis_repo_required/);
  assert.throws(() => taskModule.buildCommand({ python: 'python' }), /fixed_python_command_required/);
}

function testExactStagePOutputAndActionContract() {
  assert.equal(STAGE_P_OUTPUT_KEYS.length, 45);
  assert.equal(taskModule.SAFE_OUTPUT_KEYS.size, 45);
  assert.deepEqual([...taskModule.SAFE_OUTPUT_KEYS].sort(), [...STAGE_P_OUTPUT_KEYS].sort());
  assert.deepEqual([...taskModule.ALLOWED_ACTIONS].sort(), [...STAGE_P_ACTIONS].sort());
  const complete = taskModule.parseKisV2CliOutput(v2Output());
  assert.deepEqual(Object.keys(complete).sort(), [...STAGE_P_OUTPUT_KEYS].sort());
  for (const action of STAGE_P_ACTIONS) {
    const parsedAction = taskModule.parseKisV2CliOutput(v2Output({ action, action_type: action }));
    assert.equal(parsedAction.action, action);
    assert.equal(parsedAction.action_type, action);
  }
  const parsed = taskModule.parseKisV2CliOutput(`${v2Output({ action: 'unexpected_action', action_type: 'unexpected_action' })}\naccess_token=synthetic-secret\nraw_response=private`);
  assert.equal(parsed.action, undefined);
  assert.equal(parsed.action_type, undefined);
  assert.equal(Object.hasOwn(parsed, 'access_token'), false);
  assert.equal(Object.hasOwn(parsed, 'raw_response'), false);
}

function testFailClosedAndCompletionMapping() {
  const unsafeAtCompletion = [
    { fail_closed: true },
    { prod_db_touched: true },
    { order_attempted: true },
    { secret_exposed: true },
    { raw_values_printed: true },
    { raw_response_persisted: true },
  ];
  for (const unsafe of unsafeAtCompletion) {
    const summary = taskModule.parseKisV2CliOutput(v2Output(completionOverrides(unsafe)));
    assert.equal(taskModule.mapSummaryToTaskState(summary).state, 'PAUSED');
  }
  assert.deepEqual(taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(v2Output(completionOverrides()))), {
    state: 'COMPLETED', reason: 'minimum_distinct_trading_days_reached',
  });
  const completedAfterReconcile = completionOverrides({
    db_written: true,
    outcome_inserted_count: 1,
    outcomes_resolved: 1,
    resolved_predictions: 1,
    correct_predictions: 1,
    pending_predictions: 59,
  });
  assert.equal(taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(v2Output(completedAfterReconcile))).state, 'COMPLETED');
  assert.deepEqual(taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(v2Output())), {
    state: 'DISABLED', reason: 'disabled_only_no_execution',
  });
}

function testStatusAndRelationshipContract() {
  const safeDisabled = [
    {},
    { schema_evidence_checked: false },
    waitingPreWindowOverrides(),
    { status: 'waiting', action: 'waiting_for_horizon', action_type: 'waiting_for_horizon', sample_status: 'waiting' },
    marketClosedOverrides(),
  ];
  for (const fixture of safeDisabled) {
    const mapped = taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(v2Output(fixture)));
    assert.equal(mapped.state, 'DISABLED');
  }
  const readyActions = [
    {},
    { action: 'predict_only', action_type: 'predict_only', prediction_inserted_count: 3, predictions_inserted: 3, db_written: true },
    { action: 'reconcile_only', action_type: 'reconcile_only', outcome_inserted_count: 1, outcomes_resolved: 1, resolved_predictions: 1, correct_predictions: 1, pending_predictions: 2, db_written: true },
    { action: 'reconcile_then_predict', action_type: 'reconcile_then_predict', prediction_inserted_count: 3, predictions_inserted: 3, outcome_inserted_count: 1, outcomes_resolved: 1, resolved_predictions: 1, correct_predictions: 1, pending_predictions: 2, db_written: true },
  ];
  for (const fixture of readyActions) {
    const mapped = taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(v2Output(fixture)));
    assert.equal(mapped.state, 'DISABLED');
  }

  const blocked = taskModule.parseKisV2CliOutput(v2Output({
    status: 'blocked',
    action: 'paused',
    action_type: 'paused',
    blocked: true,
    automation_paused: true,
    sample_status: 'blocked',
    fail_closed: true,
    error_class: 'blocked',
  }));
  assert.deepEqual(taskModule.mapSummaryToTaskState(blocked), { state: 'PAUSED', reason: 'blocked' });
}

function testDuplicateAndExactPresenceFailClosed() {
  const duplicate = taskModule.parseKisV2CliOutput(`${v2Output()}\nfail_closed=false`);
  assert.equal(Object.hasOwn(duplicate, 'fail_closed'), false);
  assert.equal(taskModule.mapSummaryToTaskState(duplicate).state, 'PAUSED');

  for (const key of ['prediction_horizon', 'target_definition', 'timezone', 'prediction_window', 'reconciliation_window']) {
    const missing = taskModule.parseKisV2CliOutput(withoutKey(v2Output(), key));
    assert.equal(taskModule.mapSummaryToTaskState(missing).state, 'PAUSED');
  }
}

function testAdversarialStagePContractsFailClosed() {
  const adversarial = [
    { prediction_horizon: 'same_session' },
    { target_definition: 'modified_target' },
    { timezone: 'UTC' },
    { prediction_window: '00:00-23:59 Asia/Seoul' },
    { reconciliation_window: 'immediate' },
    { status: 'success', sample_status: 'success' },
    { action: 'predict_only', action_type: 'reconcile_only' },
    { blocked: true },
    { completed: true },
    { error_class: 'blocked' },
    { prediction_inserted_count: 1 },
    { outcome_inserted_count: 1 },
    { distinct_decision_day_count: 2 },
    { pending_predictions: 2 },
    { resolved_predictions: 1 },
    { api_called: true },
    { market_data_api_calls: 1 },
    { paper_trade_count: 1 },
    { live_trade_count: 1 },
    { order_attempted: true },
    { scheduler_changed: true },
    { cron_changed: true },
    { raw_values_printed: true },
    { prod_db_touched: true },
    { secret_exposed: true },
    { raw_response_persisted: true },
    { new_nonessential_features: true },
    { distinct_decision_day_count: 20, distinct_trading_days: 20 },
    completionOverrides({ automation_paused: false }),
    completionOverrides({ distinct_decision_day_count: 19, distinct_trading_days: 19, total_predictions: 57, pending_predictions: 57 }),
  ];
  for (const fixture of adversarial) {
    const mapped = taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(v2Output(fixture)));
    assert.equal(mapped.state, 'PAUSED', JSON.stringify(fixture));
  }
}

function testReviewerSemanticAdversarialCases() {
  const cases = [
    ['three-symbol ledger total', { total_predictions: 4, pending_predictions: 4 }],
    ['write flag without inserts', { db_written: true }],
    ['ready execution required', { executed: false }],
    ['ready DB required', { db_opened: false }],
    ['ready integrity required', { integrity_checked: false, schema_evidence_checked: false }],
    ['predict-only batch required', { action: 'predict_only', action_type: 'predict_only' }],
    ['reconcile-then-predict outcomes required', { action: 'reconcile_then_predict', action_type: 'reconcile_then_predict', prediction_inserted_count: 3, predictions_inserted: 3, db_written: true }],
    ['reconcile-only outcomes required', { action: 'reconcile_only', action_type: 'reconcile_only' }],
    ['waiting DB state must not be hybrid', waitingPreWindowOverrides({ executed: true })],
    ['market-closed aggregates must be zero', marketClosedOverrides({ distinct_decision_day_count: 1, distinct_trading_days: 1, total_predictions: 3, pending_predictions: 3 })],
    ['schema evidence requires open verified DB', waitingPreWindowOverrides({ schema_evidence_checked: true })],
    ['completed insert batch is zero or three', completionOverrides({ prediction_inserted_count: 1, predictions_inserted: 1, db_written: true })],
  ];
  for (const [name, fixture] of cases) {
    const mapped = taskModule.mapSummaryToTaskState(taskModule.parseKisV2CliOutput(v2Output(fixture)));
    assert.equal(mapped.state, 'PAUSED', name);
  }
}

function testInvalidTypedOutputFailsClosed() {
  const invalidBoolean = taskModule.parseKisV2CliOutput(v2Output({ fail_closed: 'not-a-boolean' }));
  assert.equal(Object.hasOwn(invalidBoolean, 'fail_closed'), false);
  assert.equal(taskModule.mapSummaryToTaskState(invalidBoolean).state, 'PAUSED');

  const invalidNumber = taskModule.parseKisV2CliOutput(v2Output({ distinct_trading_days: 'twenty' }));
  assert.equal(Object.hasOwn(invalidNumber, 'distinct_trading_days'), false);
  assert.equal(taskModule.mapSummaryToTaskState(invalidNumber).state, 'PAUSED');
}

function testSampleStatusAndErrorClassMismatchFailClosed() {
  const sampleStatusMismatch = taskModule.parseKisV2CliOutput(v2Output({ sample_status: 'waiting' }));
  assert.deepEqual(taskModule.mapSummaryToTaskState(sampleStatusMismatch), {
    state: 'PAUSED', reason: 'invalid_stage_p_contract',
  });

  const errorClassMismatch = taskModule.parseKisV2CliOutput(v2Output({ error_class: 'blocked' }));
  assert.deepEqual(taskModule.mapSummaryToTaskState(errorClassMismatch), {
    state: 'PAUSED', reason: 'invalid_stage_p_contract',
  });
}

async function testDisabledOnlyNoInvocationOrRegistration() {
  let mockInvocationCount = 0;
  const task = taskModule.createKisPredictionV2ValidationTask({
    execFile: () => { mockInvocationCount += 1; },
    state: {
      state: 'ACTIVE',
      max_distinct_trading_days: 999,
      max_concurrent_runs: 9,
      retry: true,
      retry_on_failure: true,
      orders_enabled: true,
      live_execution_enabled: true,
      scheduler_registered: true,
      server_registered: true,
      benign_note: 'preserved',
    },
  });
  const prepared = task.prepareDisabled();
  assert.equal(prepared.state, 'DISABLED');
  assert.equal(prepared.max_distinct_trading_days, 20);
  assert.equal(prepared.max_concurrent_runs, 1);
  assert.equal(prepared.retry, false);
  assert.equal(prepared.retry_on_failure, false);
  assert.equal(prepared.orders_enabled, false);
  assert.equal(prepared.live_execution_enabled, false);
  assert.equal(prepared.scheduler_registered, false);
  assert.equal(prepared.server_registered, false);
  assert.equal(prepared.benign_note, 'preserved');
  assert.equal(typeof task.start, 'undefined');
  assert.equal(typeof task.activate, 'undefined');
  const result = await task.runOnce({ invokedBy: 'mock-test' });
  assert.equal(mockInvocationCount, 0);
  assert.equal(result.state, 'DISABLED');
  assert.equal(result.last_run.error_class, 'disabled_only_no_execution');
}

async function testConcurrentDisabledRunsPreventDuplicateExecution() {
  let mockInvocationCount = 0;
  const task = taskModule.createKisPredictionV2ValidationTask({
    execFile: () => { mockInvocationCount += 1; },
  });
  const first = task.runOnce({ invokedBy: 'first' });
  const second = await task.runOnce({ invokedBy: 'second' });
  const firstResult = await first;

  assert.equal(mockInvocationCount, 0);
  assert.equal(firstResult.state, 'DISABLED');
  assert.equal(firstResult.last_run.error_class, 'disabled_only_no_execution');
  assert.equal(second.state, 'DISABLED');
  assert.equal(second.last_run.status, 'skipped');
  assert.equal(second.last_run.duplicate_execution_prevented, true);
  assert.equal(second.last_run.error_class, 'previous_run_active');
  assert.equal(task.status().last_run.error_class, 'disabled_only_no_execution');
}

(async () => {
  testExactCommandAndCanonicalPath();
  testExactStagePOutputAndActionContract();
  testFailClosedAndCompletionMapping();
  testStatusAndRelationshipContract();
  testDuplicateAndExactPresenceFailClosed();
  testAdversarialStagePContractsFailClosed();
  testReviewerSemanticAdversarialCases();
  testInvalidTypedOutputFailsClosed();
  testSampleStatusAndErrorClassMismatchFailClosed();
  await testDisabledOnlyNoInvocationOrRegistration();
  await testConcurrentDisabledRunsPreventDuplicateExecution();
  console.log('KIS prediction v2 disabled validation task tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
