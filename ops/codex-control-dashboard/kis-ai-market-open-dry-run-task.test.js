'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
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
  const actionType = blocked ? 'paused' : (extra.action_type || defaultAction);
  const intraday = taskId === mod.TASKS[1].id && status === 'success' && actionType === 'intraday_shadow'
    ? {
        intraday_decisions: 3,
        intraday_mode: 'hybrid_bootstrap',
        intraday_model_version: 'intraday_hybrid_v2',
        intraday_feature_version: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_feature_version,
        intraday_policy_version: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_policy_version,
        intraday_feature_hash: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_feature_hash,
        intraday_policy_hash: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_policy_hash,
      }
    : {};
  const postClose = taskId === mod.TASKS[2].id && status === 'success' && actionType === 'post_close_learning'
    ? {
        intraday_outcomes_inserted: 0,
        intraday_labeled_rows: 0,
        intraday_official_dates: 0,
      }
    : {};
  return JSON.stringify({
    task_id: taskId,
    status,
    action_type: actionType,
    official_trade_date: blocked ? null : '2026-07-21',
    official_session_state: blocked ? 'unknown' : 'regular_session',
    official_calendar_verified: !blocked,
    official_calendar_source_hash: blocked ? null : CALENDAR_HASH,
    api_calls: 0,
    quote_api_calls: 0,
    decisions: Object.keys(intraday).length ? 3 : 0,
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
    ...intraday,
    ...postClose,
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
    intraday_mode: null,
    intraday_model_version: null,
    decision_provider: mod.INTRADAY_PROVIDER_ATTESTATION.decision_provider,
    intraday_feature_version: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_feature_version,
    intraday_policy_version: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_policy_version,
    intraday_feature_hash: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_feature_hash,
    intraday_policy_hash: mod.INTRADAY_PROVIDER_ATTESTATION.intraday_policy_hash,
    order_symbol: null,
    order_name: null,
    order_side: null,
    requested_quantity: 0,
    filled_quantity: 0,
    unfilled_quantity: 0,
    lifecycle_status: null,
    decision_reason_codes: [],
    notification_idempotency_key: null,
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

function aiVerdict(packet, decisions = []) {
  return { slot_id: packet.slot_id, model_id: mod.LLM_MODEL_ID, prompt_hash: packet.prompt_hash, decisions };
}

function safetyOutput(status = 'success', extra = {}) {
  return JSON.stringify({
    task_id: 'kis-vps-safety-monitor-v1', status, action_type: 'safety_monitor',
    execution_owner: 'vps',
    process_lock: 'clear', kill_state: 'clear', open_order_status: 'clear',
    reconciliation_status: 'clear', account_risk_status: 'clear', order_api_calls: 0,
    vps_live_orders: 0, prod_orders: 0, retry: false, catch_up: false,
    fail_closed: status === 'blocked', error_class: status === 'blocked' ? 'safe_block' : 'none', ...extra,
  });
}

function weeklyUniverseOutput(status = 'success', extra = {}) {
  const blocked = status === 'blocked';
  const values = {
    status,
    action_type: 'weekly_universe_refresh',
    iso_week: '2026-W31',
    selected_count: blocked ? 0 : 50,
    exit_only_count: 0,
    api_calls: 3,
    official_downloads: 2,
    db_written: !blocked,
    artifact_changed: false,
    live_candidates_changed: false,
    raw_response_persisted: false,
    prod_db_touched: false,
    order_attempted: false,
    fail_closed: blocked,
    error_class: blocked ? 'weekly_universe_not_ready' : 'none',
    ...extra,
  };
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
}

function cutoverOutput(status = 'INELIGIBLE', extra = {}) {
  const blocked = status === 'blocked';
  return JSON.stringify({
    task_id: 'kis-vps-to-prod-cutover-v1',
    status,
    action_type: status === 'success' ? 'cutover_activated' : status === 'CUTOVER_PENDING' ? 'cutover_pending' : status === 'INELIGIBLE' ? 'cutover_ineligible' : 'cutover_check',
    activation_performed: status === 'success',
    execution_owner_before: 'vps',
    execution_owner_after: status === 'success' ? 'prod' : 'vps',
    distinct_vps_days: status === 'INELIGIBLE' ? 1 : 20,
    reconciled_round_trips: status === 'INELIGIBLE' ? 1 : 30,
    unresolved_major_incidents: 0,
    vps_flat: true,
    open_orders: 0,
    db_integrity_ok: true,
    active_scheduler_count: 1,
    blocked_issue_count: status === 'INELIGIBLE' ? 2 : 0,
    prod_db_touched: status === 'success',
    prod_orders: 0,
    vps_live_orders: 0,
    order_api_calls: 0,
    retry: false,
    fail_closed: blocked,
    error_class: blocked ? 'cutover_check_failed' : status === 'INELIGIBLE' ? 'blocked:insufficient_distinct_vps_days' : 'none',
    ...extra,
  });
}

function decisionContext(slotId, candidates = ['005930'], minimumVpsEntryDecisions = 0) {
  return JSON.stringify({
    task_id: 'kis-llm-decision-context-v1',
    status: 'success',
    slot_id: slotId,
    model_id: mod.LLM_MODEL_ID,
    official_trade_date: slotId.split(':')[1],
    candidates: candidates.map((symbol) => ({
      symbol,
      role: 'eligible_entry',
      review_tier: 'primary',
      ml_action: 'ENTER',
      confidence_bucket: 'high',
      prob_up: 0.7,
      prob_flat: 0.2,
      prob_down: 0.1,
      expected_net_return: 0.01,
      risk_overlay: 'ALLOW',
      data_quality: 'PASS',
    })),
    holdings: [],
    account_aggregate: { available_cash: 1000000, account_equity: 1000000 },
    risk_aggregate: {
      open_positions: 0,
      open_orders: 0,
      daily_entry_submit_count: 0,
      active_daily_entry_cap: null,
      max_positions: 5,
      minimum_vps_entry_decisions: minimumVpsEntryDecisions,
      max_symbol_equity_pct: 50,
      planned_position_loss_pct: 1,
      daily_loss_limit_pct: 3,
    },
    event_metadata: [],
    fail_closed: false,
    error_class: 'none',
    raw_response_persisted: false,
    secret_exposure: false,
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
    schedulerOwnerLockPath: path.join(root, 'scheduler-owner.lock'),
    orderAttestationDir: path.join(root, 'attestations'),
    verdictDir: path.join(root, 'verdicts'),
  };
  fs.writeFileSync(paths.legacyV1StatePath, JSON.stringify({ state: 'PAUSED', next_run_at: null }));
  fs.writeFileSync(paths.legacyV2StatePath, JSON.stringify({ state: 'PAUSED', next_run_at: null }));
  let clock = new Date('2026-07-20T23:59:00Z');
  const taskExec = options.execFile || ((c, a, o, cb) => cb(null, good(a[a.indexOf('--task-id') + 1])));
  const execFile = (command, args, execOptions, callback) => {
    if (args.includes('safety-monitor')) {
      callback(options.safetyError || null, typeof options.safetyOutput === 'function'
        ? options.safetyOutput()
        : options.safetyOutput || safetyOutput());
      return;
    }
    if (args.includes('decision-context')) {
      if (typeof options.onDecisionContext === 'function') {
        options.onDecisionContext({ command, args, execOptions });
      }
      callback(options.decisionContextError || null, typeof options.decisionContextOutput === 'function'
        ? options.decisionContextOutput(execOptions.env.KIS_HERMES_DUE_KEY)
        : options.decisionContextOutput || decisionContext(execOptions.env.KIS_HERMES_DUE_KEY));
      return;
    }
    if (args.includes('ai-quote-transport-diagnose-once')) {
      callback(null, options.diagnosticOutput || diagnostic());
      return;
    }
    if (args.includes('model-v3-run') && args.includes('weekly-universe')) {
      callback(options.weeklyUniverseError || null, options.weeklyUniverseOutput || weeklyUniverseOutput());
      return;
    }
    if (args.includes('vps-autonomous-order') && args.includes('refresh-shadow')) {
      if (typeof options.onIndependentShadowRefresh === 'function') {
        options.onIndependentShadowRefresh({ command, args, execOptions });
      }
      callback(options.independentShadowRefreshError || null, options.independentShadowRefreshOutput || orderGood('success', {
        action_type: 'shadow_refreshed', previous_artifact_hash: 'a'.repeat(64),
        artifact_hash: 'a'.repeat(64), shadow_predictions_inserted: 30,
      }));
      return;
    }
    if (args.includes('vps-autonomous-order') && args.includes('scheduled-refresh-shadow')) {
      if (typeof options.onShadowRefresh === 'function') {
        options.onShadowRefresh({ command, args, execOptions });
      }
      callback(options.shadowRefreshError || null, options.shadowRefreshOutput || orderGood('success', {
        action_type: 'shadow_refreshed', previous_artifact_hash: 'a'.repeat(64),
        artifact_hash: 'a'.repeat(64), shadow_predictions_inserted: 3,
      }));
      return;
    }
    if (args.includes('--activation-preflight')) {
      if (typeof options.onActivationPreflight === 'function') {
        options.onActivationPreflight({ command, args, execOptions });
      }
      callback(
        options.activationPreflightError || null,
        options.activationPreflightOutput
          || good(mod.TASKS[0].id, 'success', { action_type: 'activation_preflight', api_calls: 2 }),
      );
      return;
    }
    if (args.includes('vps-autonomous-order') && args.includes('activation-check')) {
      const activationCheckOutput = typeof options.activationCheckOutput === 'function'
        ? options.activationCheckOutput()
        : options.activationCheckOutput;
      callback(
        options.activationCheckError || null,
        activationCheckOutput || orderGood('success', { action_type: 'activation_check' }),
      );
      return;
    }
    taskExec(command, args, execOptions, callback);
  };
  const task = mod.createKisAiMarketOpenDryRunTask({
    ...paths,
    now: () => clock,
    runtimeContract: options.runtimeContract || mod.REQUIRED_RUNTIME_CONTRACT,
    runtimeHealthCheck: options.runtimeHealthCheck || (async () => true),
    sourceParityCheck: options.sourceParityCheck || (() => true),
    resumeBlockingLockPaths: options.resumeBlockingLockPaths,
    execFile,
    reportSender: options.reportSender,
    repairTaskSender: options.repairTaskSender,
    calendarProofResolver: options.calendarProofResolver || (() => calendarProof(true)),
    llmExecutor: options.llmExecutor || (async ({ packet }) => aiVerdict(packet)),
    emergencyStopExecutor: options.emergencyStopExecutor,
    schedulerRegistered: options.schedulerRegistered,
    serverRegistered: options.serverRegistered,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    enforceSchedulerOwnership: options.enforceSchedulerOwnership ?? false,
  });
  return { root, paths, task, setClock(value) { clock = new Date(value); }, rawExec: taskExec };
}

async function active(options = {}) {
  const value = fixture(options);
  value.task.prepareDisabled();
  await value.task.activate({ approval: mod.ACTIVATION_APPROVAL });
  return value;
}

function markOrderActive(value) {
  const state = value.task.status();
  state.order_activated_at = '2026-07-21T00:00:00.000Z';
  state.tasks[mod.TASKS[4].id].state = 'ACTIVE';
  state.tasks[mod.TASKS[4].id].pause_reason = undefined;
  state.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T00:10:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
}

test('order review receipt survives reload and never activates or executes a task', async () => {
  let sends = 0;
  let commands = 0;
  const value = fixture({
    execFile() { commands += 1; throw new Error('no subprocess allowed'); },
    reportSender: async (message) => {
      sends += 1;
      assert.match(message.content, /주문은 제출하지 않습니다/);
      return { discord_sent: true, message_id: '123456789012345670' };
    },
  });
  value.task.prepareDisabled();
  const before = value.task.status();
  const proposal = { environment: 'prod', account_ref: 'a'.repeat(64), account_alias: '주식 전용',
    symbol: '005930', name: '삼성전자', side: 'buy', quantity: 2, limit_price_krw: 70000 };
  const receipt = await value.task.requestOrderReview(proposal);
  await assert.rejects(value.task.requestOrderReview(proposal), /order_review_pending_or_recent/);
  const reloaded = mod.createKisAiMarketOpenDryRunTask({ ...value.paths,
    runtimeContract: mod.REQUIRED_RUNTIME_CONTRACT, now: () => new Date('2026-07-20T23:59:30Z') });
  const input = { id: receipt.id, action: 'confirm', messageId: '123456789012345670',
    userId: '123456789012345671', interactionId: '123456789012345672', channelId: '1512691418605420634' };
  const decided = reloaded.decideOrderReview(input);
  assert.equal(decided.status, 'confirmed');
  assert.equal(decided.order_submitted, false);
  assert.equal(decided.execution_authorized, false);
  // A stale scheduler snapshot must not roll a confirmed review back to pending.
  fs.writeFileSync(value.paths.statePath, JSON.stringify(before));
  assert.throws(() => reloaded.decideOrderReview(input), /already_decided/);
  assert.equal(reloaded.status().state, before.state);
  assert.deepEqual(reloaded.status().tasks, before.tasks);
  assert.equal(commands, 0);
  assert.equal(sends, 1);
});

test('ambiguous order review delivery never retries or accepts confirmation', async () => {
  let sends = 0;
  const value = fixture({ reportSender: async () => { sends += 1; return { discord_sent: true }; } });
  value.task.prepareDisabled();
  const proposal = { environment: 'vps', account_ref: 'a'.repeat(64), account_alias: '주식 전용',
    symbol: '005930', name: '삼성전자', side: 'sell', quantity: 1, limit_price_krw: 70000 };
  await assert.rejects(value.task.requestOrderReview(proposal), /delivery_unconfirmed/);
  const saved = JSON.parse(fs.readFileSync(`${value.paths.statePath}.order-review.json`, 'utf8'));
  assert.equal(saved.delivery_status, 'claimed');
  assert.throws(() => value.task.decideOrderReview({ id: saved.id, action: 'confirm',
    messageId: '123456789012345670', userId: '123456789012345671',
    interactionId: '123456789012345672', channelId: '1512691418605420634' }), /message_mismatch/);
  await assert.rejects(value.task.requestOrderReview(proposal), /pending_or_recent/);
  assert.equal(sends, 1);
});

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
  const dueKey = `${mod.TASKS[4].id}:2026-07-22:09:10`;
  const command = mod.buildCommand(mod.TASKS[4].id, { schedulerToken: '1'.repeat(32), dueKey });
  assert.equal(command.command, mod.KIS_VENV_PYTHON);
  assert.equal(command.cwd, mod.KIS_REPO);
  assert.deepEqual(command.args, ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'run-once']);
  assert.equal(command.env.KIS_HERMES_SCHEDULER_TOKEN, '1'.repeat(32));
  assert.equal(command.env.KIS_HERMES_DUE_KEY, dueKey);
  assert.equal(command.env.KIS_INTRADAY_PROVIDER_ID, 'intraday_v1');
  assert.equal(command.env.KIS_INTRADAY_FEATURE_VERSION, 'intraday-quote-10m-v2-dynamic-universe');
  assert.equal(command.env.KIS_INTRADAY_FEATURE_HASH, mod.INTRADAY_PROVIDER_ATTESTATION.intraday_feature_hash);
  assert.equal(command.env.KIS_INTRADAY_POLICY_VERSION, 'intraday-fast-track-v3-intraday-discovery');
  assert.equal(command.env.KIS_INTRADAY_POLICY_HASH, mod.INTRADAY_PROVIDER_ATTESTATION.intraday_policy_hash);
  assert.equal(command.env.KIS_INTRADAY_DAILY_ENTRY_CAP, 'null');
  assert.equal(command.args.includes('--approval'), false);
  assert.throws(() => mod.buildCommand(mod.TASKS[4].id), /scheduler_attestation_required/);
  const finalDueKey = `${mod.TASKS[4].id}:2026-07-22:14:40`;
  const finalSlot = mod.buildCommand(mod.TASKS[4].id, {
    schedulerToken: '2'.repeat(32),
    dueKey: finalDueKey,
  });
  assert.deepEqual(
    finalSlot.args,
    ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'run-once'],
  );
});

test('post-close candidate refresh uses the existing bounded KIS shadow path', () => {
  const command = mod.buildIndependentShadowRefreshCommand();
  assert.equal(command.command, mod.KIS_VENV_PYTHON);
  assert.equal(command.cwd, mod.KIS_REPO);
  assert.deepEqual(command.args, [
    '-m', 'kis_trading_lab', 'vps-autonomous-order',
    '--action', 'refresh-shadow', '--confirm',
    '--approval', 'APPROVE_KIS_MODEL_V3_30D_RESEARCH_API_VPS_V1',
  ]);
});

test('post-close creates Model v3 candidates while the order task stays disabled', async () => {
  let refreshCalls = 0;
  const value = await active({
    onIndependentShadowRefresh() { refreshCalls += 1; },
  });
  const due = '2026-07-21T07:20:00.000Z';
  const state = value.task.status();
  state.tasks[mod.TASKS[2].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);

  const after = await value.task.runOnce({ taskId: mod.TASKS[2].id, dueAt: new Date(due) });
  const lastRun = after.tasks[mod.TASKS[2].id].last_run;

  assert.equal(refreshCalls, 1);
  assert.equal(after.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(lastRun.model_v3_candidate_refresh_status, 'success');
  assert.equal(lastRun.model_v3_candidate_refresh_action_type, 'shadow_refreshed');
  assert.equal(lastRun.model_v3_candidate_predictions_inserted, 30);
  assert.equal(lastRun.model_v3_candidate_refresh_fail_closed, false);
});

test('post-close does not duplicate candidate refresh when the order task is active', async () => {
  let refreshCalls = 0;
  const value = await active({
    onIndependentShadowRefresh() { refreshCalls += 1; },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = '2026-07-21T07:20:00.000Z';
  const state = value.task.status();
  state.tasks[mod.TASKS[2].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);

  const after = await value.task.runOnce({ taskId: mod.TASKS[2].id, dueAt: new Date(due) });

  assert.equal(refreshCalls, 0);
  assert.equal(after.tasks[mod.TASKS[2].id].last_run.model_v3_candidate_refresh_status, undefined);
});

test('post-close candidate refresh preserves an exact fail-closed blocker', async () => {
  const messages = [];
  const value = await active({
    independentShadowRefreshError: Object.assign(new Error('blocked'), { code: 2 }),
    independentShadowRefreshOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
    reportSender: async (message) => { messages.push(message); return { discord_sent: true }; },
  });
  const due = '2026-07-21T07:20:00.000Z';
  const state = value.task.status();
  state.tasks[mod.TASKS[2].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);

  const after = await value.task.runOnce({ taskId: mod.TASKS[2].id, dueAt: new Date(due) });
  const lastRun = after.tasks[mod.TASKS[2].id].last_run;

  assert.equal(after.state, 'ACTIVE');
  assert.equal(after.tasks[mod.TASKS[2].id].state, 'PAUSED');
  assert.equal(lastRun.model_v3_candidate_refresh_status, 'blocked');
  assert.equal(lastRun.model_v3_candidate_refresh_fail_closed, true);
  assert.equal(lastRun.model_v3_candidate_refresh_error_class, 'model_v3_prediction_batch_incomplete');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /model_v3_prediction_batch_incomplete/);
});

test('intraday decision and order schedules align on future 10-minute slots', () => {
  assert.deepEqual(mod.TASKS[1].minutes, Array.from({ length: 34 }, (_, i) => 550 + (i * 10)));
  assert.deepEqual(mod.TASKS[2].minutes, [980]);
  assert.deepEqual(mod.TASKS[3].minutes, [990]);
  const task = mod.TASKS[4];
  assert.deepEqual(task.minutes, [...mod.TASKS[1].minutes, 881, 882, 980]);
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T00:09:00Z')), '2026-07-21T00:10:00.000Z');
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T05:39:00Z')), '2026-07-21T05:40:00.000Z');
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T05:40:00Z')), '2026-07-21T05:41:00.000Z');
  assert.equal(mod.nextRunAt(task, new Date('2026-07-21T05:42:00Z')), '2026-07-21T07:20:00.000Z');
});

test('post-close shadow refresh reuses the existing order task and never invokes an LLM', async () => {
  let llmCalls = 0;
  const value = await active({
    llmExecutor: async ({ packet }) => { llmCalls += 1; return aiVerdict(packet); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const state = value.task.status();
  const due = '2026-07-21T07:20:00.000Z';
  state.tasks[mod.TASKS[4].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);

  const after = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });

  assert.equal(llmCalls, 0);
  assert.equal(after.state, 'ACTIVE');
  assert.equal(after.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(after.tasks[mod.TASKS[4].id].last_run.action_type, 'shadow_refreshed');
  assert.equal(after.tasks[mod.TASKS[4].id].last_run.shadow_predictions_inserted, 3);
  assert.equal(after.tasks[mod.TASKS[4].id].last_run.order_api_calls, 0);
  assert.equal(Object.keys(after.tasks).length, 5);
});

test('post-close backfill transport failure defers refresh without pausing or retrying', async () => {
  let refreshRuns = 0;
  const value = await active({
    shadowRefreshError: Object.assign(new Error('blocked'), { code: 2 }),
    shadowRefreshOutput: orderGood('blocked', {
      error_class: 'model_v3_backfill_transport_unavailable',
      artifact_hash: null,
    }),
    onShadowRefresh() { refreshRuns += 1; },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = '2026-07-21T07:20:00.000Z';
  const current = value.task.status();
  current.tasks[mod.TASKS[4].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(current));
  value.setClock(due);

  const after = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  const orderTask = after.tasks[mod.TASKS[4].id];

  assert.equal(refreshRuns, 1);
  assert.equal(after.state, 'ACTIVE');
  assert.equal(orderTask.state, 'ACTIVE');
  assert.equal(orderTask.pending_invocation, null);
  assert.equal(orderTask.refresh_only_pending, true);
  assert.equal(orderTask.last_run.action_type, 'transport_degraded_no_op');
  assert.equal(orderTask.last_run.error_class, 'model_v3_backfill_transport_unavailable');
  assert.equal(orderTask.last_run.fail_closed, false);
  assert.equal(orderTask.last_run.no_same_slot_retry, true);
  assert.equal(orderTask.next_run_at, '2026-07-22T07:20:00.000Z');
});

test('post-close refresh command is attested and exposes no order approval', () => {
  const dueKey = `${mod.TASKS[4].id}:2026-07-21:16:20`;
  const command = mod.buildCommand(mod.TASKS[4].id, { schedulerToken: '3'.repeat(32), dueKey });
  assert.deepEqual(command.args, ['-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'scheduled-refresh-shadow']);
  assert.equal(command.env.KIS_ACTIVE_SCHEDULER_COUNT, undefined);
  assert.equal(command.args.includes('--approval'), false);
});

test('invalid legacy 16:40 refresh slot recovers only into the next attested 16:20 slot', async () => {
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
  });
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'scheduled_shadow_refresh_slot_invalid';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  paused.tasks[mod.TASKS[4].id].refresh_only_pending = true;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  value.setClock('2026-07-21T07:50:00Z');

  const state = await value.task.enableOrderTask({
    confirm: true,
    approval: mod.ORDER_ACTIVATION_APPROVAL,
  });

  const orderTask = state.tasks[mod.TASKS[4].id];
  assert.equal(orderTask.state, 'ACTIVE');
  assert.equal(orderTask.refresh_only_pending, true);
  assert.equal(orderTask.activation_artifact_hash, 'a'.repeat(64));
  assert.equal(orderTask.last_run.action_type, 'activation_waiting_post_close');
  assert.equal(orderTask.next_run_at, '2026-07-22T07:20:00.000Z');
  assert.equal(state.retry, false);
  assert.equal(state.catch_up, false);
  assert.equal(Object.keys(state.tasks).length, 5);
  assert.equal(fs.existsSync(value.paths.orderAttestationDir), false);
});

test('post-close market-closed no-op accepts only the current artifact attestation', async () => {
  for (const [artifactHash, expectedState] of [
    ['a'.repeat(64), 'ACTIVE'],
    ['b'.repeat(64), 'PAUSED'],
  ]) {
    const value = await active({
      shadowRefreshOutput: orderGood('no_op', {
        action_type: 'market_closed_no_op',
        previous_artifact_hash: null,
        artifact_hash: artifactHash,
      }),
    });
    await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
    const before = value.task.status();
    before.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T07:20:00.000Z';
    fs.writeFileSync(value.paths.statePath, JSON.stringify(before));
    value.setClock('2026-07-21T07:20:00.000Z');

    const state = await value.task.runOnce({
      taskId: mod.TASKS[4].id,
      dueAt: new Date('2026-07-21T07:20:00.000Z'),
    });

    assert.equal(state.tasks[mod.TASKS[4].id].state, expectedState);
    if (expectedState === 'PAUSED') {
      assert.equal(
        state.tasks[mod.TASKS[4].id].pause_reason,
        'model_v3_artifact_attestation_mismatch',
      );
    }
  }
});

test('cutover parser remains fail-closed while automatic cutover is unscheduled', () => {
  const parsed = mod.parseCutoverOutput(cutoverOutput('CUTOVER_PENDING'));
  assert.equal(parsed.actionType, 'cutover_pending');
  assert.equal(parsed.activationPerformed, false);
  assert.throws(
    () => mod.parseCutoverOutput(cutoverOutput('success', { execution_owner_before: 'disabled' })),
    /invalid_cutover_output/,
  );
  assert.throws(
    () => mod.parseCutoverOutput(cutoverOutput('CUTOVER_PENDING', { prod_db_touched: true })),
    /invalid_cutover_output/,
  );
  for (const unsafe of [
    { vps_flat: false }, { open_orders: 1 }, { db_integrity_ok: false },
    { unresolved_major_incidents: 1 }, { blocked_issue_count: 1 },
    { distinct_vps_days: 19 }, { reconciled_round_trips: 29 },
  ]) {
    assert.throws(() => mod.parseCutoverOutput(cutoverOutput('success', unsafe)), /invalid_cutover_output/);
  }
});

test('weekly universe refresh reuses each weekday supervisor and strict KIS action', () => {
  const monday = new Date('2026-08-10T00:00:00Z');
  assert.equal(mod.isWeeklyUniverseRefreshDue(mod.TASKS[0], monday), true);
  assert.equal(mod.isWeeklyUniverseRefreshDue(mod.TASKS[0], new Date('2026-08-15T00:00:00Z')), false);
  assert.equal(mod.isWeeklyUniverseRefreshDue(mod.TASKS[2], monday), false);
  const command = mod.buildWeeklyUniverseCommand();
  assert.equal(command.command, mod.KIS_VENV_PYTHON);
  assert.equal(command.cwd, mod.KIS_REPO);
  assert.deepEqual(command.args, [
    '-m', 'kis_trading_lab', 'model-v3-run',
    '--approval', 'APPROVE_KIS_MODEL_V3_30D_RESEARCH_API_VPS_V1',
    '--action', 'weekly-universe', '--db', mod.VPS_DB_PATH,
  ]);
  const parsed = mod.parseWeeklyUniverseOutput(weeklyUniverseOutput());
  assert.equal(parsed.selectedCount, 50);
  assert.equal(parsed.apiCalls, 3);
  assert.equal(parsed.failClosed, false);
});

test('weekday supervisor records weekly universe without adding a scheduler', async () => {
  const calls = [];
  const value = await active({
    execFile(command, args, options, callback) {
      calls.push([...args]);
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  const due = '2026-08-10T00:00:00.000Z';
  const state = JSON.parse(fs.readFileSync(value.paths.statePath, 'utf8'));
  state.tasks[mod.TASKS[0].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);
  const result = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date(due) });

  assert.equal(result.tasks[mod.TASKS[0].id].last_run.weekly_universe_status, 'success');
  assert.equal(result.tasks[mod.TASKS[0].id].last_run.weekly_universe_selected_count, 50);
  assert.equal(result.tasks[mod.TASKS[0].id].last_run.weekly_universe_db_written, true);
  assert.equal(calls.length, 1);
  assert.equal(result.scheduler_registered, false);
});

test('weekly future-universe block does not change the frozen active model owner', async () => {
  const value = await active({ weeklyUniverseOutput: weeklyUniverseOutput('blocked') });
  const due = '2026-08-10T00:00:00.000Z';
  const state = JSON.parse(fs.readFileSync(value.paths.statePath, 'utf8'));
  state.tasks[mod.TASKS[0].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);
  const result = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date(due) });

  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.tasks[mod.TASKS[0].id].state, 'ACTIVE');
  assert.equal(result.tasks[mod.TASKS[0].id].last_run.weekly_universe_fail_closed, true);
  assert.equal(result.tasks[mod.TASKS[0].id].last_run.weekly_universe_error_class, 'weekly_universe_not_ready');
});

test('14:41 risk-off slot reuses the order task without a new LLM decision', async () => {
  let llmCalls = 0;
  let contextCalls = 0;
  let orderCalls = 0;
  const value = await active({
    onDecisionContext() { contextCalls += 1; },
    llmExecutor: async ({ packet }) => { llmCalls += 1; return aiVerdict(packet); },
    execFile(command, args, options, callback) {
      if (args.includes('vps-autonomous-order')) {
        orderCalls += 1;
        callback(null, orderGood('success', {
          action_type: 'horizon_exit_reconciled',
          order_api_calls: 1, vps_live_orders: 1, reconciliations: 1,
          order_symbol: '005930', order_side: 'sell', requested_quantity: 1,
          filled_quantity: 1, unfilled_quantity: 0, lifecycle_status: 'liquidated',
          decision_reason_codes: ['RISK_REDUCTION'], notification_idempotency_key: 'f'.repeat(64),
        }));
      } else callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const state = value.task.status();
  state.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T05:41:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock('2026-07-21T05:41:00.000Z');

  const after = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-21T05:41:00.000Z'),
  });

  assert.equal(llmCalls, 0);
  assert.equal(contextCalls, 0);
  assert.equal(orderCalls, 1);
  assert.equal(after.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(after.tasks[mod.TASKS[4].id].last_run.action_type, 'horizon_exit_reconciled');
});

test('14:40 horizon slot accepts only zero-position non-order no-op outcomes', async () => {
  for (const actionType of ['no_candidate_no_op', 'entry_window_closed_no_op']) {
    const value = await active({
      execFile(command, args, options, callback) {
        callback(null, orderGood('no_op', { action_type: actionType }));
      },
    });
    await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
    const due = new Date('2026-07-21T05:40:00Z');
    const state = value.task.status();
    state.tasks[mod.TASKS[4].id].next_run_at = due.toISOString();
    fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
    value.setClock(due);

    const after = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: due });
    assert.equal(after.tasks[mod.TASKS[4].id].state, 'ACTIVE');
    assert.equal(after.tasks[mod.TASKS[4].id].last_run.action_type, actionType);
  }
});

test('14:40 horizon slot rejects either no-op outcome that reports an open position', async () => {
  for (const actionType of ['no_candidate_no_op', 'entry_window_closed_no_op']) {
    const value = await active({
      execFile(command, args, options, callback) {
        callback(null, orderGood('no_op', {
          action_type: actionType,
          open_positions: 1,
        }));
      },
    });
    await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
    const due = new Date('2026-07-21T05:40:00Z');
    const state = value.task.status();
    state.tasks[mod.TASKS[4].id].next_run_at = due.toISOString();
    fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
    value.setClock(due);

    const after = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: due });
    assert.equal(after.tasks[mod.TASKS[4].id].state, 'PAUSED');
    assert.equal(after.tasks[mod.TASKS[4].id].pause_reason, 'order_action_not_allowed_for_schedule_slot');
  }
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
    action_type: 'ai_position_held', open_positions: 3,
  })));
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    action_type: 'ai_position_held', open_positions: 6,
  })), /unsafe_order_count/);
  assert.doesNotThrow(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    intraday_mode: 'hybrid_bootstrap', intraday_model_version: 'intraday_hybrid_v2',
  })));
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    intraday_mode: 'hybrid_bootstrap', intraday_model_version: 'intraday_hybrid_v1',
  })), /intraday_model_contract_invalid/);
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
    action_type: 'no_candidate_no_op', order_api_calls: 1, vps_live_orders: 1, reconciliations: 1,
  })), /unexpected_order_execution/);
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    error_class: 'app_secret=value',
  })), /unsafe_order_output/);
  const normalized = mod.parseKisVpsAutonomousOutput(orderGood('blocked', {
    action_type: 'paused', error_class: 'HTTP 500 from private endpoint',
  }));
  assert.equal(normalized.errorClass, 'sanitized_runtime_error');
  const promoted = mod.parseKisVpsAutonomousOutput(orderGood('success', {
    action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
    previous_artifact_hash: 'a'.repeat(64), artifact_hash: 'b'.repeat(64),
  }));
  assert.equal(promoted.artifactPromoted, true);
  assert.equal(promoted.previousArtifactHash, 'a'.repeat(64));
  assert.doesNotThrow(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', { daily_entry_count: 37 })));
  assert.throws(() => mod.parseKisVpsAutonomousOutput(orderGood('no_op', {
    intraday_feature_hash: '0'.repeat(64),
  })), /intraday_provider_attestation_mismatch/);
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

test('exact provider cutover migrates the existing active order task without creating a scheduler', async () => {
  const value = await active();
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const legacy = value.task.status();
  const legacyOrder = legacy.tasks[mod.TASKS[4].id];
  for (const key of Object.keys(mod.INTRADAY_PROVIDER_ATTESTATION)) {
    if (key !== 'daily_entry_cap') delete legacyOrder[key];
  }
  legacyOrder.daily_entry_cap = 5;
  legacyOrder.daily_entry_cap_approval_hash = crypto.createHash('sha256')
    .update('APPROVE_KIS_VPS_MOCK_DAILY_ENTRY_CAP_5_V1').digest('hex');
  fs.writeFileSync(value.paths.statePath, JSON.stringify(legacy));

  await assert.rejects(
    value.task.cutoverIntradayProvider({ confirm: true, approval: 'wrong' }),
    /exact_provider_cutover_approval_required/,
  );
  const state = await value.task.cutoverIntradayProvider({
    confirm: true,
    approval: mod.INTRADAY_PROVIDER_CUTOVER_APPROVAL,
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap, null);
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap_approval_hash, null);
  assert.equal(state.tasks[mod.TASKS[4].id].decision_provider, 'intraday_v1');
  assert.equal(state.tasks[mod.TASKS[4].id].schedule, mod.TASKS[4].schedule);
  assert.equal(Object.keys(state.tasks).length, 5);
  assert.equal(state.os_cron_used, false);
});

test('exact v2 provider attestation remains readable for atomic v3 synchronization', async () => {
  const value = await active();
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const legacy = value.task.status();
  const order = legacy.tasks[mod.TASKS[4].id];
  const legacyFeatureVersion = 'intraday-quote-10m-v2-dynamic-universe';
  const legacyPolicyVersion = 'intraday-fast-track-v2-dynamic-universe';
  Object.assign(order, {
    decision_provider: 'intraday_v1',
    intraday_feature_version: legacyFeatureVersion,
    intraday_policy_version: legacyPolicyVersion,
    intraday_feature_hash: crypto.createHash('sha256').update(legacyFeatureVersion).digest('hex'),
    intraday_policy_hash: crypto.createHash('sha256').update(legacyPolicyVersion).digest('hex'),
  });
  fs.writeFileSync(value.paths.statePath, JSON.stringify(legacy));

  const before = value.task.status();
  assert.equal(before.state, 'ACTIVE');
  assert.equal(before.tasks[mod.TASKS[4].id].intraday_feature_version, legacyFeatureVersion);
  const state = await value.task.cutoverIntradayProvider({
    confirm: true,
    approval: mod.INTRADAY_PROVIDER_CUTOVER_APPROVAL,
  });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(
    state.tasks[mod.TASKS[4].id].intraday_feature_version,
    'intraday-quote-10m-v2-dynamic-universe',
  );
  assert.equal(
    state.tasks[mod.TASKS[4].id].intraday_policy_version,
    'intraday-fast-track-v3-intraday-discovery',
  );
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(Object.keys(state.tasks).length, 5);
  assert.equal(state.os_cron_used, false);
});

test('mixed v2 provider attestation remains fail closed', async () => {
  const value = await active();
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const state = value.task.status();
  const order = state.tasks[mod.TASKS[4].id];
  order.intraday_feature_version = 'intraday-quote-10m-v2-dynamic-universe';
  order.intraday_policy_version = 'intraday-fast-track-v2-dynamic-universe';
  order.intraday_feature_hash = '0'.repeat(64);
  order.intraday_policy_hash = crypto.createHash('sha256')
    .update(order.intraday_policy_version).digest('hex');
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));

  const blocked = value.task.status();
  assert.equal(blocked.state, 'PAUSED');
  assert.equal(blocked.pause_reason, 'state_unavailable');
  assert.equal(blocked.scheduler_faulted, true);
});

test('post-close refresh failure waits for the next refresh slot without enabling intraday orders', async () => {
  let autonomousRuns = 0;
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
    onShadowRefresh() {
      autonomousRuns += 1;
    },
  });
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'model_v3_shadow_batch_failed';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  value.setClock('2026-07-21T07:50:00Z');

  let state = await value.task.enableOrderTask({
    confirm: true,
    approval: mod.ORDER_ACTIVATION_APPROVAL,
  });

  assert.equal(autonomousRuns, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-22T07:20:00.000Z');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_waiting_post_close');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.fail_closed, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.order_api_calls, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].activation_artifact_hash, 'a'.repeat(64));
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);

  value.setClock('2026-07-22T07:20:00Z');
  state = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-22T07:20:00Z'),
  });
  assert.equal(autonomousRuns, 1);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'shadow_refreshed');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-23T00:10:00.000Z');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, false);
});

test('refresh-only recovery survives a missed refresh and restart without opening an intraday slot', async () => {
  let shadowRuns = 0;
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
    onShadowRefresh() { shadowRuns += 1; },
  });
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'model_v3_shadow_batch_failed';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  value.setClock('2026-07-21T07:50:00Z');

  let state = await value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL,
  });
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-22T07:20:00.000Z');

  value.setClock('2026-07-22T07:41:00Z');
  state = await value.task.runOnce({
    taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-22T07:41:00Z'),
  });
  assert.equal(shadowRuns, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'missed_refresh_window_no_op');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-23T07:20:00.000Z');

  value.setClock('2026-07-23T00:10:00Z');
  state = await value.task.runOnce({
    taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-23T00:10:00Z'),
  });
  assert.equal(shadowRuns, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-23T07:20:00.000Z');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);

  value.setClock('2026-07-23T07:20:00Z');
  state = await value.task.runOnce({
    taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-23T07:20:00Z'),
  });
  assert.equal(shadowRuns, 1);
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, false);
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-24T00:10:00.000Z');
});

test('post-close waiting recovery refuses to rotate the attested artifact', async () => {
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete', artifact_hash: 'b'.repeat(64),
    }),
  });
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'model_v3_shadow_batch_failed';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  await assert.rejects(
    value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
    /artifact_recovery_hash_changed/,
  );
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
});

test('activation check success cannot clear an existing refresh-only marker', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'model_v3_shadow_batch_failed';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  paused.tasks[mod.TASKS[4].id].refresh_only_pending = true;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  value.setClock('2026-07-21T07:50:00Z');

  const state = await value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL,
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_waiting_post_close');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-22T07:20:00.000Z');
});

test('explicit refresh adoption verifies the batch before restoring intraday order slots', async () => {
  const value = await active();
  const current = value.task.status();
  current.tasks[mod.TASKS[4].id].state = 'ACTIVE';
  current.tasks[mod.TASKS[4].id].next_run_at = '2026-07-22T07:20:00.000Z';
  current.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  current.tasks[mod.TASKS[4].id].refresh_only_pending = true;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(current));
  value.setClock('2026-07-21T07:50:00Z');

  await assert.rejects(
    value.task.enableOrderTask({
      confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL,
    }),
    /order_task_must_be_disabled/,
  );
  const state = await value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL, adoptRefresh: true,
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, false);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_check');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-22T00:10:00.000Z');
});

test('refresh adoption preserves refresh-only state when activation check fails', async () => {
  for (const options of [
    {
      activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
      activationCheckOutput: orderGood('blocked', { error_class: 'model_v3_prediction_batch_incomplete' }),
    },
    {
      activationCheckError: Object.assign(new Error('process'), { code: 1 }),
      activationCheckOutput: orderGood('success', { action_type: 'activation_check' }),
    },
  ]) {
    const value = await active(options);
    const current = value.task.status();
    const prior = current.tasks[mod.TASKS[4].id];
    prior.state = 'ACTIVE';
    prior.next_run_at = '2026-07-22T07:20:00.000Z';
    prior.activation_artifact_hash = 'a'.repeat(64);
    prior.refresh_only_pending = true;
    fs.writeFileSync(value.paths.statePath, JSON.stringify(current));

    await assert.rejects(value.task.enableOrderTask({
      confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL, adoptRefresh: true,
    }));
    const after = value.task.status().tasks[mod.TASKS[4].id];
    assert.equal(after.state, 'ACTIVE');
    assert.equal(after.refresh_only_pending, true);
    assert.equal(after.next_run_at, '2026-07-22T07:20:00.000Z');
    assert.equal(after.activation_artifact_hash, 'a'.repeat(64));
  }
});

test('refresh adoption stores a newly verified artifact hash and is idempotent', async () => {
  const value = await active({
    activationCheckOutput: orderGood('success', {
      action_type: 'activation_check', artifact_hash: 'b'.repeat(64),
    }),
  });
  const current = value.task.status();
  const prior = current.tasks[mod.TASKS[4].id];
  prior.state = 'ACTIVE';
  prior.next_run_at = '2026-07-22T07:20:00.000Z';
  prior.activation_artifact_hash = 'a'.repeat(64);
  prior.refresh_only_pending = true;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(current));

  const adopted = await value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL, adoptRefresh: true,
  });
  assert.equal(adopted.tasks[mod.TASKS[4].id].activation_artifact_hash, 'b'.repeat(64));
  assert.equal(adopted.tasks[mod.TASKS[4].id].refresh_only_pending, false);
  await assert.rejects(value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL, adoptRefresh: true,
  }), /order_task_must_be_disabled/);
});

test('enable-order CLI maps the explicit refresh adoption contract only', () => {
  assert.deepEqual(mod.parseEnableOrderArgs([
    'enable-order', '--confirm', '--adopt-refresh', '--approval', mod.ORDER_ACTIVATION_APPROVAL,
  ]), {
    confirm: true,
    approval: mod.ORDER_ACTIVATION_APPROVAL,
    invokedBy: 'hermes_cli',
    adoptRefresh: true,
  });
  assert.equal(mod.parseEnableOrderArgs([
    'enable-order', '--confirm', '--approval', mod.ORDER_ACTIVATION_APPROVAL,
  ]).adoptRefresh, false);
  assert.equal(mod.parseEnableOrderArgs([
    'enable-order', '--adopt-refresh', '--approval', 'wrong',
  ]).confirm, false);
});

test('global recovery preserves a disabled failed refresh for the next post-close slot', async () => {
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
  });
  const recovered = value.task.status();
  recovered.tasks[mod.TASKS[4].id].state = 'DISABLED';
  recovered.tasks[mod.TASKS[4].id].pause_reason = undefined;
  recovered.tasks[mod.TASKS[4].id].next_run_at = null;
  recovered.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  recovered.tasks[mod.TASKS[4].id].refresh_only_pending = false;
  recovered.tasks[mod.TASKS[4].id].last_run = {
    status: 'blocked', error_class: 'model_v3_shadow_execution_failed', fail_closed: true,
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(recovered));
  value.setClock('2026-07-21T07:50:00Z');

  const state = await value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL,
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_waiting_post_close');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-22T07:20:00.000Z');
});

test('recovered post-close failure arms refresh-only activation from canonical evidence', async () => {
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
  });
  const recovered = value.task.status();
  recovered.last_error_notification = {
    task_id: mod.TASKS[2].id,
    error_class: 'runtime_unhandled_error',
    attempted: true,
    succeeded: true,
  };
  recovered.tasks[mod.TASKS[2].id].last_run = {
    error_class: 'runtime_unhandled_error', fail_closed: true,
  };
  recovered.tasks[mod.TASKS[4].id].state = 'DISABLED';
  recovered.tasks[mod.TASKS[4].id].next_run_at = null;
  recovered.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  recovered.tasks[mod.TASKS[4].id].refresh_only_pending = false;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(recovered));
  value.setClock('2026-07-21T07:50:00Z');

  const state = await value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL,
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_waiting_post_close');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-22T07:20:00.000Z');
});

test('provider cutover is blocked while a refresh-only gate is pending', async () => {
  const value = await active();
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const waiting = value.task.status();
  waiting.tasks[mod.TASKS[4].id].refresh_only_pending = true;
  waiting.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T07:20:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(waiting));

  await assert.rejects(
    value.task.cutoverIntradayProvider({
      confirm: true, approval: mod.INTRADAY_PROVIDER_CUTOVER_APPROVAL,
    }),
    /post_close_refresh_pending/,
  );
  const after = value.task.status().tasks[mod.TASKS[4].id];
  assert.equal(after.refresh_only_pending, true);
  assert.equal(after.next_run_at, '2026-07-21T07:20:00.000Z');
});

test('refresh-only recovery stays refresh-only after a market-closed no-op', async () => {
  const value = await active({
    activationCheckError: Object.assign(new Error('blocked'), { code: 2 }),
    activationCheckOutput: orderGood('blocked', {
      error_class: 'model_v3_prediction_batch_incomplete',
    }),
    shadowRefreshOutput: orderGood('no_op', {
      action_type: 'market_closed_no_op', previous_artifact_hash: null,
    }),
  });
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'model_v3_shadow_batch_failed';
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  value.setClock('2026-07-21T07:50:00Z');

  let state = await value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL,
  });
  value.setClock('2026-07-22T07:20:00Z');
  state = await value.task.runOnce({
    taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-22T07:20:00Z'),
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'market_closed_no_op');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, '2026-07-23T07:20:00.000Z');
});

test('post-close refresh rejects order execution output', async () => {
  const value = await active({
    shadowRefreshOutput: orderGood('success', {
      action_type: 'entry_reconciled', order_api_calls: 1, vps_live_orders: 1,
      reconciliations: 1, open_positions: 1, daily_entry_count: 1,
    }),
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const stateBefore = value.task.status();
  stateBefore.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T07:20:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(stateBefore));

  const state = await value.task.runOnce({
    taskId: mod.TASKS[4].id,
    dueAt: new Date('2026-07-21T07:20:00.000Z'),
  });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'entry_after_cutoff_blocked');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, null);
});

test('post-close refresh rejects artifact promotion and hash drift', async () => {
  for (const scenario of ['promotion', 'drift']) {
    const extra = scenario === 'promotion'
      ? {
        action_type: 'shadow_refreshed', artifact_reused: false, artifact_promoted: true,
        previous_artifact_hash: 'a'.repeat(64), artifact_hash: 'b'.repeat(64),
        shadow_predictions_inserted: 3,
      }
      : {
        action_type: 'shadow_refreshed', previous_artifact_hash: 'b'.repeat(64),
        artifact_hash: 'b'.repeat(64), shadow_predictions_inserted: 3,
      };
    const value = await active({ shadowRefreshOutput: orderGood('success', extra) });
    await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
    const before = value.task.status();
    before.tasks[mod.TASKS[4].id].next_run_at = '2026-07-21T07:20:00.000Z';
    fs.writeFileSync(value.paths.statePath, JSON.stringify(before));
    value.setClock('2026-07-21T07:20:00.000Z');

    const state = await value.task.runOnce({
      taskId: mod.TASKS[4].id,
      dueAt: new Date('2026-07-21T07:20:00.000Z'),
    });

    assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
    assert.equal(
      state.tasks[mod.TASKS[4].id].pause_reason,
      scenario === 'promotion'
        ? 'model_v3_post_close_promotion_forbidden'
        : 'model_v3_artifact_attestation_mismatch',
    );
  }
});

test('explicit enable check reactivates an order task paused for known reconciliation recovery reasons', async () => {
  for (const pauseReason of [
    'decision_context_failed',
    'intraday_position_signal_missing',
    'llm_response_timeout',
    'llm_candidate_limit_exceeded',
    'http_transport_failed',
    'balance_mismatch',
    'order_not_fully_filled',
    'order_submission_unknown',
    'invalid_order_output_contract',
    'unsafe_order_count',
    'intraday_prediction_contract_mismatch',
    'symbol_not_allowed',
    'unmanaged_position_present',
    'preflight_or_reconciliation_invalid',
    'risk_guard_blocked',
    'model_v3_artifact_attestation_mismatch',
    'model_v3_shadow_batch_failed',
    'model_v3_backfill_failed',
    'model_v3_shadow_execution_failed',
    'model_v3_artifact_load_failed',
    'model_v3_artifact_verify_failed',
    'hermes_scheduler_attestation_unavailable',
  ]) {
    const value = await active();
    const paused = value.task.status();
    paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
    paused.tasks[mod.TASKS[4].id].pause_reason = pauseReason;
    paused.tasks[mod.TASKS[4].id].next_run_at = null;
    if (pauseReason === 'model_v3_artifact_attestation_mismatch') {
      paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
    }
    fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

    const state = await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
    assert.equal(state.state, 'ACTIVE');
    assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
    assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, undefined);
    assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'activation_check');
  }
});

test('artifact mismatch recovery refuses to rotate the attested artifact', async () => {
  const value = await active({
    activationCheckOutput: orderGood('success', {
      action_type: 'activation_check', artifact_hash: 'b'.repeat(64),
    }),
  });
  const paused = value.task.status();
  paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
  paused.tasks[mod.TASKS[4].id].pause_reason = 'model_v3_artifact_attestation_mismatch';
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  paused.tasks[mod.TASKS[4].id].next_run_at = null;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  await assert.rejects(
    value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
    /artifact_recovery_hash_changed/,
  );
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
});

test('attestation contract recovery requires runtime source parity', async () => {
  for (const pauseReason of [
    'model_v3_artifact_attestation_mismatch',
    'hermes_scheduler_attestation_unavailable',
  ]) {
    const value = await active({ sourceParityCheck: () => false });
    const paused = value.task.status();
    paused.tasks[mod.TASKS[4].id].state = 'PAUSED';
    paused.tasks[mod.TASKS[4].id].pause_reason = pauseReason;
    paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
    paused.tasks[mod.TASKS[4].id].next_run_at = null;
    fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

    await assert.rejects(
      value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
      /runtime_source_parity_failed/,
    );
    const after = value.task.status().tasks[mod.TASKS[4].id];
    assert.equal(after.state, 'PAUSED');
    assert.equal(after.pause_reason, pauseReason);
    assert.equal(after.next_run_at, null);
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
    /^Error: pending_order_reconciliation$/,
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
    /^Error: pending_order_reconciliation$/,
  );
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'DISABLED');
});

test('explicit enable does not surface none as an activation error', async () => {
  const value = await active({
    activationCheckOutput: orderGood('success', { action_type: 'no_candidate_no_op' }),
  });

  await assert.rejects(
    value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL }),
    /^Error: order_activation_check_failed$/,
  );
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
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) callback(Object.assign(new Error('blocked'), { code: 2 }), orderGood('blocked'));
    else callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetChannelId, mod.REPORT_TARGET_CHANNEL_ID);
  assert.equal(sent[0].deliveryLayer, 'hermes_ai_market_open_error');
  assert.match(sent[0].content, /^\[KIS 자동운영 기능 제한\]/);
  assert.match(sent[0].content, /작업: AI 자동매매/);
  assert.match(sent[0].content, /원인: safe_block/);
  assert.match(sent[0].content, /자동 재시도: 없음/);
  assert.match(sent[0].content, /신규 주문: 중단/);
  assert.equal(state.last_error_notification.succeeded, true);
  await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(sent.length, 1);
});

test('repairable pause queues one isolated self-heal task and reports it', async () => {
  const repairs = []; const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    repairTaskSender: async (incident) => {
      repairs.push(incident);
      return { queued: true, task_id: 't_self_heal' };
    },
    execFile(command, args, options, callback) {
      if (args.includes('vps-autonomous-order')) {
        callback(Object.assign(new Error('blocked'), { code: 2 }), orderGood('blocked', {
          error_class: 'intraday_position_signal_missing',
        }));
      } else callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].errorClass, 'intraday_position_signal_missing');
  assert.equal(state.last_self_heal.queued, true);
  assert.equal(state.last_self_heal.task_id, 't_self_heal');
  assert.match(sent[0].content, /자동 복구: 격리 작업 생성 \(t_self_heal\)/);
  await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(repairs.length, 1);
});

test('unexpected KIS child exit preserves sanitized evidence for self-heal without raw stderr', async () => {
  const repairs = [];
  const rawStderr = 'Traceback (most recent call last):\nRuntimeError: bounded failure detail';
  const value = await active({
    reportSender: async () => ({ discord_sent: true }),
    repairTaskSender: async (incident) => {
      repairs.push(incident);
      return { queued: true, task_id: 't_process_repair' };
    },
    execFile(command, args, options, callback) {
      callback(Object.assign(new Error('child failed'), { code: 1 }), '', rawStderr);
    },
  });
  const due = '2026-07-21T07:20:00.000Z';
  const state = value.task.status();
  state.tasks[mod.TASKS[2].id].next_run_at = due;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);

  const after = await value.task.runOnce({ taskId: mod.TASKS[2].id, dueAt: new Date(due) });
  const lastRun = after.tasks[mod.TASKS[2].id].last_run;

  assert.equal(after.state, 'ACTIVE');
  assert.equal(after.tasks[mod.TASKS[2].id].pause_reason, 'process_error');
  assert.equal(repairs.length, 1);
  assert.deepEqual(repairs[0], {
    notificationKey: after.last_error_notification.key,
    taskId: mod.TASKS[2].id,
    errorClass: 'process_error',
    repairOwner: 'kis',
    failurePhase: 'child_process',
    failureExceptionType: 'RuntimeError',
    failureExitCode: 1,
    failureSignal: 'none',
    failureFingerprint: crypto.createHash('sha256').update(rawStderr).digest('hex'),
  });
  assert.equal(lastRun.failure_phase, 'child_process');
  assert.equal(lastRun.failure_exception_type, 'RuntimeError');
  assert.equal(lastRun.failure_exit_code, 1);
  assert.doesNotMatch(JSON.stringify(after), /bounded failure detail/);
  assert.doesNotMatch(JSON.stringify(repairs), /bounded failure detail/);
});

test('financial-state blocker stays paused without autonomous repair', async () => {
  let repairs = 0;
  const value = await active({
    reportSender: async () => ({ discord_sent: true }),
    repairTaskSender: async () => { repairs += 1; return { queued: true, task_id: 'unsafe' }; },
    execFile(command, args, options, callback) {
      if (args.includes('vps-autonomous-order')) {
        callback(Object.assign(new Error('blocked'), { code: 2 }), orderGood('blocked', {
          error_class: 'order_submission_unknown',
        }));
      } else callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(repairs, 0);
  assert.equal(state.last_self_heal.status, 'manual_review_required');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
});

test('artifactless blocked order preserves the original fail-closed reason', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order') && args.includes('activation-check')) {
      callback(null, orderGood('success', { action_type: 'activation_check' }));
    } else if (args.includes('vps-autonomous-order')) {
      callback(Object.assign(new Error('blocked'), { code: 2 }), orderGood('blocked', {
        error_class: 'scheduler_attestation_invalid', artifact_hash: null,
      }));
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'scheduler_attestation_invalid');
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
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

test('blocked dry-run attempts one alert and preserves the original pause when delivery fails', async () => {
  let runs = 0; let sends = 0;
  const value = await active({
    reportSender: async () => { sends += 1; throw new Error('private delivery detail'); },
    execFile(command, args, options, callback) {
      runs += 1;
      callback(Object.assign(new Error('blocked'), { code: 2 }), good(args[args.indexOf('--task-id') + 1], 'blocked'));
    },
  });
  const due = value.task.status().tasks[mod.TASKS[0].id].next_run_at;
  value.setClock(due);
  const state = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date(due) });
  assert.equal(runs, 1); assert.equal(sends, 1);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[0].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[0].id].pause_reason, 'safe_block');
  assert.equal(state.last_error_notification.attempted, true);
  assert.equal(state.last_error_notification.succeeded, false);
  assert.equal(state.last_error_notification.retry, false);
  await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date(due) });
  assert.equal(runs, 1); assert.equal(sends, 1);
});

test('order invocation uses one-time hashed scheduler attestation and clears pending state', async () => {
  let schedulerToken;
  let invocationDueKey;
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      schedulerToken = options.env.KIS_HERMES_SCHEDULER_TOKEN;
      invocationDueKey = options.env.KIS_HERMES_DUE_KEY;
      const files = fs.readdirSync(value.paths.orderAttestationDir);
      const attestation = JSON.parse(fs.readFileSync(path.join(value.paths.orderAttestationDir, files[0]), 'utf8'));
      assert.equal(args.includes(schedulerToken), false);
      assert.deepEqual(attestation, {
        due_key: invocationDueKey,
        token_hash: attestation.token_hash,
        expires_at: attestation.expires_at,
        ...mod.INTRADAY_PROVIDER_ATTESTATION,
        daily_entry_cap_approval_hash: null,
      });
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

test('runtime contract disables legacy daily cap elevation', async () => {
  const value = await active();
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  assert.throws(
    () => value.task.approveAggressiveDailyEntryCap({ confirm: true, approval: mod.DAILY_ENTRY_CAP_5_APPROVAL }),
    /daily_entry_cap_managed_by_runtime_contract/,
  );
  const state = value.task.status();
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap, null);
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap_approval_hash, null);
});

test('order output count is aggregate evidence and does not impose a daily cap', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) callback(null, orderGood('no_op', { daily_entry_count: 4 }));
    else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.daily_entry_count, 4);
});

test('order attestation persists the runtime contract daily cap', async () => {
  let value;
  value = await active({ execFile(command, args, options, callback) {
    if (args.includes('vps-autonomous-order')) {
      const files = fs.readdirSync(value.paths.orderAttestationDir);
      assert.equal(files.length, 1);
      const attestation = JSON.parse(fs.readFileSync(path.join(value.paths.orderAttestationDir, files[0]), 'utf8'));
      assert.equal(attestation.daily_entry_cap, null);
      assert.equal(attestation.daily_entry_cap_approval_hash, null);
      callback(null, orderGood('no_op', { daily_entry_count: 5 }));
    } else callback(null, good(args[args.indexOf('--task-id') + 1]));
  } });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = value.task.status().tasks[mod.TASKS[4].id].next_run_at;
  value.setClock(due);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date(due) });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].daily_entry_cap, null);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.daily_entry_count, 5);
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

test('next runs skip catch-up and stop intraday inference after 14:40', () => {
  const intraday = mod.TASKS[1];
  assert.equal(mod.nextRunAt(intraday, new Date('2026-07-20T23:55:00Z')), '2026-07-21T00:10:00.000Z');
  assert.equal(mod.nextRunAt(intraday, new Date('2026-07-21T05:30:00Z')), '2026-07-21T05:40:00.000Z');
  assert.equal(mod.nextRunAt(intraday, new Date('2026-07-21T05:40:00Z')), '2026-07-22T00:10:00.000Z');
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


test('task-scoped pause keeps status polling and peer tasks active', async () => {
  const callbacks = [];
  let cleared = 0;
  const value = await active({
    schedulerRegistered: true,
    serverRegistered: true,
    setTimer(fn) { callbacks.push(fn); return { unref() {} }; },
    clearTimer() { cleared += 1; },
    execFile(_command, _args, _options, callback) { callback(new Error('failed'), ''); },
  });
  value.task.start();

  const state = await value.task.runOnce({
    taskId: mod.TASKS[0].id,
    dueAt: new Date('2026-07-21T00:00:00Z'),
  });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[0].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[1].id].state, 'ACTIVE');
  assert.equal(cleared, 0);
  assert.equal(callbacks.length, 1);
});


test('scheduler ownership lock permits exactly one live scheduler process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-scheduler-owner-'));
  const lockPath = path.join(root, 'owner.lock');
  const release = mod.acquireSchedulerOwnershipLock(lockPath);
  assert.throws(() => mod.acquireSchedulerOwnershipLock(lockPath), /scheduler_owner_lock_active/);
  release();
  const releaseAfter = mod.acquireSchedulerOwnershipLock(lockPath);
  releaseAfter();
});

test('scheduler poll is aligned to the next minute boundary', () => {
  const delays = [];
  const value = fixture({
    schedulerRegistered: true,
    serverRegistered: true,
    setTimer(_fn, delay) { delays.push(delay); return { unref() {} }; },
    clearTimer() {},
  });
  value.task.prepareDisabled();
  value.setClock('2026-07-21T00:00:30.000Z');
  value.task.start();
  assert.equal(delays[0], 30_000);
  value.task.stop();
});

test('production ownership blocks direct tick and runOnce until scheduler start owns the lock', async () => {
  const value = fixture({ enforceSchedulerOwnership: true, setTimer() { return { unref() {} }; }, clearTimer() {} });
  value.task.prepareDisabled();
  await value.task.activate({ approval: mod.ACTIVATION_APPROVAL });
  await assert.rejects(value.task.tick(), /scheduler_owner_required/);
  await assert.rejects(
    value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date('2026-07-21T00:00:00Z') }),
    /scheduler_owner_required/,
  );
  value.task.start();
  await assert.doesNotReject(value.task.tick());
  value.task.stop();
});

test('14:30 and later entry output is rejected even when KIS reports success', async () => {
  const value = await active({
    execFile(command, args, options, callback) {
      callback(null, orderGood('success', {
        action_type: 'entry_reconciled', order_api_calls: 1, vps_live_orders: 1,
        reconciliations: 1, open_positions: 1, daily_entry_count: 1,
      }));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const due = new Date('2026-07-21T05:40:00Z');
  const state = value.task.status();
  state.tasks[mod.TASKS[4].id].next_run_at = due.toISOString();
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock(due);

  const after = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: due });
  assert.equal(after.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(after.tasks[mod.TASKS[4].id].pause_reason, 'entry_after_cutoff_blocked');
});

test('strict command and output contract reject drift and unsafe fields', () => {
  const command = mod.buildCommand(mod.TASKS[1].id);
  assert.equal(command.command, mod.KIS_VENV_PYTHON); assert.equal(command.cwd, mod.KIS_REPO);
  for (const task of mod.TASKS.slice(0, 4)) {
    assert.equal(mod.buildCommand(task.id).command, mod.KIS_VENV_PYTHON);
  }
  assert.equal(command.args.includes('--activation-preflight'), false);
  const trading = () => calendarProof(true);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id), mod.TASKS[1].id, trading));
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', {
    quote_api_calls: 10, decisions: 10, intraday_decisions: 10,
  }), mod.TASKS[1].id, trading));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', {
    decisions: 10, intraday_decisions: 3,
  }), mod.TASKS[1].id, trading), /intraday_output_contract/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', {
    quote_api_calls: 21,
  }), mod.TASKS[1].id, trading), /unsafe/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[0].id, 'success', {
    quote_api_calls: 21,
  }), mod.TASKS[0].id, trading), /unsafe/);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', {
    intraday_mode: 'ml_champion', intraday_model_version: `intraday_ml_logistic_${'a'.repeat(12)}`,
  }), mod.TASKS[1].id, trading));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', {
    intraday_decisions: 2,
  }), mod.TASKS[1].id, trading), /intraday_output_contract/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'success', {
    intraday_feature_hash: 'b'.repeat(64),
  }), mod.TASKS[1].id, trading), /intraday_output_contract/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[0].id, 'success', {
    intraday_decisions: 3,
  }), mod.TASKS[0].id, trading), /fields/);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[2].id), mod.TASKS[2].id, trading));
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[2].id, 'blocked', {
    error_class: 'runtime_unhandled_error', failure_phase: 'post_close_learning',
    failure_exception_type: 'RuntimeError', failure_attempt_number: 1,
  }), mod.TASKS[2].id, trading));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[0].id, 'blocked', {
    error_class: 'runtime_unhandled_error', failure_phase: 'post_close_learning',
    failure_exception_type: 'RuntimeError', failure_attempt_number: 1,
  }), mod.TASKS[0].id, trading), /invalid_failure_evidence/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[2].id, 'success', {
    intraday_outcomes_inserted: -1,
  }), mod.TASKS[2].id, trading), /count/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[2].id, 'success', {
    intraday_labeled_rows: Number.MAX_SAFE_INTEGER + 1,
  }), mod.TASKS[2].id, trading), /count/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[0].id, 'success', {
    intraday_outcomes_inserted: 0,
  }), mod.TASKS[0].id, trading), /fields/);
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
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', {
    action_type: 'transport_degraded_no_op', error_class: 'timeout', transport_degraded: true,
    failure_phase: 'quote_request', failure_symbol: '035420', failure_exception_type: 'TimeoutError',
    failure_errno: 110, failure_attempt_number: 20,
  }), mod.TASKS[1].id, trading));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', {
    action_type: 'transport_degraded_no_op', error_class: 'timeout', transport_degraded: true,
    failure_phase: 'quote_request', failure_symbol: '035420', failure_exception_type: 'TimeoutError',
    failure_errno: 110, failure_attempt_number: 21,
  }), mod.TASKS[1].id, trading), /invalid_failure_evidence/);
  assert.doesNotThrow(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', {
    action_type: 'no_candidates_no_op', api_calls: 0, order_api_calls: 0,
  }), mod.TASKS[1].id, trading));
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[0].id, 'no_op', {
    action_type: 'no_candidates_no_op', api_calls: 0, order_api_calls: 0,
  }), mod.TASKS[0].id, trading), /task_result/);
  assert.throws(() => mod.parseKisAiMarketOpenOutput(good(mod.TASKS[1].id, 'no_op', {
    action_type: 'transport_degraded_no_op', error_class: 'tls_failed', transport_degraded: true,
    failure_phase: 'quote_request', failure_symbol: '005930', failure_exception_type: 'SSLError',
    failure_errno: null, failure_attempt_number: 1,
  }), mod.TASKS[1].id, trading), /task_result/);
});

test('post-close runtime failure preserves its sanitized cause instead of masking evidence', async () => {
  const value = await active({ execFile(command, args, options, callback) {
    const taskId = args[args.indexOf('--task-id') + 1];
    callback(null, good(taskId, 'blocked', {
      error_class: 'runtime_unhandled_error', failure_phase: 'post_close_learning',
      failure_exception_type: 'RuntimeError', failure_attempt_number: 1,
    }));
  } });
  const due = new Date('2026-07-21T07:20:00Z');
  value.setClock(due);

  const state = await value.task.runOnce({ taskId: mod.TASKS[2].id, dueAt: due });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[2].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[2].id].pause_reason, 'runtime_unhandled_error');
  assert.equal(state.tasks[mod.TASKS[2].id].last_run.failure_phase, 'post_close_learning');
  assert.equal(state.tasks[mod.TASKS[2].id].last_run.failure_exception_type, 'RuntimeError');
});

test('error class sanitizer allows codes and blocks secret-like or raw detail', () => {
  assert.equal(mod.sanitizeErrorClass('daily_entry_cap_attestation_mismatch'), 'daily_entry_cap_attestation_mismatch');
  assert.equal(mod.sanitizeErrorClass('unsafe_order_count'), 'unsafe_order_count');
  for (const errorClass of [
    'invalid_report_message',
    'model_v3_refresh_failed',
    'model_v3_shadow_failed',
    'model_v3_shadow_batch_failed',
    'model_v3_backfill_failed',
    'model_v3_shadow_execution_failed',
    'model_v3_artifact_load_failed',
    'model_v3_artifact_verify_failed',
    'weekly_universe_not_ready',
    'intraday_universe_unavailable',
    'intraday_shortlist_unavailable',
    'intraday_position_signal_missing',
    'vps_position_ledger_invalid',
  ]) {
    assert.equal(mod.sanitizeErrorClass(errorClass), errorClass);
  }
  assert.equal(mod.sanitizeErrorClass('app_secret=value'), 'sanitized_runtime_error');
  assert.equal(mod.sanitizeErrorClass('Bearer abc.def.ghi'), 'sanitized_runtime_error');
  assert.equal(mod.sanitizeErrorClass('sk-proj-fixturetoken1234567890'), 'sanitized_runtime_error');
  assert.equal(mod.sanitizeErrorClass('openai_api_key_fixturetoken1234567890'), 'sanitized_runtime_error');
  assert.equal(mod.sanitizeErrorClass('HTTP 500 from private endpoint'), 'sanitized_runtime_error');
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

test('active filesystem lock persistently pauses without duplicate child execution', async () => {
  let calls = 0;
  const value = await active({ execFile(c, a, o, cb) { calls += 1; cb(null, good(mod.TASKS[0].id)); } });
  const release = mod.acquireExclusiveLock(value.paths.runLockPath);
  value.setClock('2026-07-21T00:00:17Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date('2026-07-21T00:00:17Z') });
  assert.equal(calls, 0); assert.equal(state.state, 'PAUSED');
  assert.equal(state.pause_reason, 'scheduler_lock_active');
  assert.equal(Object.values(state.tasks).every((item) => item.state === 'PAUSED'), true);
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

test('invalid output and blocked result pause only the failing task while one timeout degrades once', async () => {
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
    assert.equal(calls, 1); assert.equal(state.state, 'ACTIVE');
    assert.equal(state.tasks[mod.TASKS[0].id].state, behavior === 'timeout' ? 'ACTIVE' : 'PAUSED');
    assert.equal(state.tasks[mod.TASKS[1].id].state, 'ACTIVE');
    assert.equal(fs.existsSync(value.paths.runLockPath), false);
  }
});

test('supervisor timeout notification identifies automatic safety checks', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(command, args, options, callback) {
      callback(Object.assign(new Error('timeout'), { killed: true, code: null }), '');
    },
  });
  value.setClock('2026-07-21T00:00:11Z');

  await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date('2026-07-21T00:00:11Z') });

  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /자동 복구: 안전 확인 자동 진행 중/);
  assert.doesNotMatch(sent[0].content, /운영자 확인 필요/);
});

test('task parser failures preserve the exact sanitized error class', async () => {
  const value = await active({ execFile(c, a, o, cb) {
    cb(null, good(a[a.indexOf('--task-id') + 1], 'success', { quote_api_calls: 21 }));
  } });
  const due = new Date('2026-07-21T00:10:00Z');
  value.setClock(due);

  const state = await value.task.runOnce({ taskId: mod.TASKS[1].id, dueAt: due });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[1].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[1].id].pause_reason, 'unsafe_output');
  assert.equal(state.tasks[mod.TASKS[1].id].last_run.error_class, 'unsafe_output');
});

test('one transient database busy no-op stays active, success resets, and consecutive two pauses', async () => {
  let mode = 'degraded';
  const value = await active({ execFile(c, a, o, cb) {
    const taskId = a[a.indexOf('--task-id') + 1];
    if (mode === 'success') cb(null, good(taskId));
    else cb(null, good(taskId, 'no_op', {
      action_type: 'transport_degraded_no_op', error_class: 'database_busy', transport_degraded: true,
      failure_phase: 'database_begin', failure_symbol: null, failure_exception_type: 'OperationalError',
      failure_errno: null, failure_attempt_number: 1,
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
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[1].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[0].id].state, 'ACTIVE');
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
  assert.equal(paused.state, 'ACTIVE');
  assert.equal(paused.tasks[mod.TASKS[0].id].state, 'PAUSED');
  assert.equal(paused.tasks[mod.TASKS[0].id].pause_reason, 'http_transport_failed');
  assert.equal(paused.tasks[mod.TASKS[1].id].state, 'ACTIVE');
});

test('exact IO resume runs 3-of-3 diagnosis and schedules only future slots', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'invalid_failure_evidence';
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

test('exact IO resume recovers a process error only after the safety monitor is clear', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'process_error';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.resume_reason, 'io_fix_verified');
});

test('exact IO resume recovers a legacy lock pause only after the lock is absent', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'legacy_run_lock_active';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  fs.writeFileSync(value.paths.legacyV1RunLockPath, 'active');

  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /legacy_run_lock_active/,
  );

  fs.unlinkSync(value.paths.legacyV1RunLockPath);
  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(state.resume_reason, 'io_fix_verified');
});

test('exact IO resume recovers a fixed post-close unhandled runtime error', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'runtime_unhandled_error';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.resume_reason, 'io_fix_verified');
});

test('exact IO resume recovers resumable task pauses while the supervisor remains active', async () => {
  const value = await active();
  const partial = value.task.status();
  partial.state = 'ACTIVE';
  for (const taskId of [mod.TASKS[0].id, mod.TASKS[1].id]) {
    partial.tasks[taskId].state = 'PAUSED';
    partial.tasks[taskId].pause_reason = 'runtime_unhandled_error';
    partial.tasks[taskId].next_run_at = null;
  }
  partial.tasks[mod.TASKS[4].id].state = 'PAUSED';
  partial.tasks[mod.TASKS[4].id].pause_reason = 'decision_context_process_error';
  partial.tasks[mod.TASKS[4].id].next_run_at = null;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(partial));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(state.resume_reason, 'io_fix_verified');
});

test('exact IO resume converts a legacy daily risk pause to disabled pending activation preflight', async () => {
  const value = await active({
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'vps', account_risk_status: 'active', error_class: 'daily_loss_entry_blocked',
    }),
  });
  const partial = value.task.status();
  partial.state = 'ACTIVE';
  partial.tasks[mod.TASKS[4].id].state = 'PAUSED';
  partial.tasks[mod.TASKS[4].id].pause_reason = 'daily_risk_budget_insufficient';
  partial.tasks[mod.TASKS[4].id].next_run_at = null;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(partial));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, null);
  assert.equal(state.retry, false);
  assert.equal(state.catch_up, false);
});

test('partial IO resume requires database preflight when any paused task needs it', async () => {
  const options = {};
  const value = await active(options);
  options.activationPreflightOutput = good(mod.TASKS[0].id, 'no_op', {
    action_type: 'idempotent_no_op',
  });
  const partial = value.task.status();
  partial.state = 'ACTIVE';
  partial.tasks[mod.TASKS[0].id].state = 'PAUSED';
  partial.tasks[mod.TASKS[0].id].pause_reason = 'runtime_unhandled_error';
  partial.tasks[mod.TASKS[1].id].state = 'PAUSED';
  partial.tasks[mod.TASKS[1].id].pause_reason = 'database_file_io_failed';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(partial));

  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /database_recovery_preflight_failed/,
  );
  assert.equal(value.task.status().tasks[mod.TASKS[1].id].state, 'PAUSED');
});

test('partial IO resume never overwrites a concurrent scheduler state change', async () => {
  let resumePhase = false;
  let value;
  value = await active({
    async runtimeHealthCheck() {
      if (resumePhase) {
        const changed = JSON.parse(fs.readFileSync(value.paths.statePath, 'utf8'));
        changed.tasks[mod.TASKS[1].id].state = 'PAUSED';
        changed.tasks[mod.TASKS[1].id].pause_reason = 'scheduler_lock_active';
        fs.writeFileSync(value.paths.statePath, JSON.stringify(changed));
      }
      return true;
    },
  });
  const partial = value.task.status();
  partial.state = 'ACTIVE';
  partial.tasks[mod.TASKS[0].id].state = 'PAUSED';
  partial.tasks[mod.TASKS[0].id].pause_reason = 'runtime_unhandled_error';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(partial));
  resumePhase = true;

  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /resume_state_changed/,
  );
  assert.equal(value.task.status().tasks[mod.TASKS[1].id].pause_reason, 'scheduler_lock_active');
});

test('exact IO resume preserves a post-close shadow refresh without enabling orders', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'process_error';
  paused.last_error_notification = {
    task_id: mod.TASKS[2].id,
    error_class: 'process_error',
    attempted: true,
    succeeded: true,
  };
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  paused.tasks[mod.TASKS[2].id].last_run = { error_class: 'process_error', fail_closed: true };
  paused.tasks[mod.TASKS[4].id].activation_artifact_hash = 'a'.repeat(64);
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(state.tasks[mod.TASKS[4].id].refresh_only_pending, true);
  assert.equal(state.tasks[mod.TASKS[4].id].next_run_at, null);
});


test('exact IO resume recovers a cleared reconciliation latch with order disabled', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'reconciliation_status_active';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
});

test('exact IO resume accepts only a sanitized VPS reconciliation pause after it clears', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED';
  paused.pause_reason = 'sanitized_runtime_error';
  paused.order_pause_reason = 'order_submission_unknown';
  paused.last_safety_monitor = {
    execution_owner: 'vps',
    reconciliation_status: 'active',
  };
  for (const item of Object.values(paused.tasks)) item.state = 'PAUSED';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
});

test('exact IO resume rejects an unclassified sanitized runtime pause', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED';
  paused.pause_reason = 'sanitized_runtime_error';
  for (const item of Object.values(paused.tasks)) item.state = 'PAUSED';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /task_not_resumable/,
  );
});

test('exact IO resume keeps a VPS daily-loss entry block while restoring supervision', async () => {
  const value = await active({
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'vps',
      account_risk_status: 'active',
      error_class: 'daily_loss_entry_blocked',
    }),
  });
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'account_risk_status_active';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  assert.equal(state.retry, false);
  assert.equal(state.catch_up, false);
});

test('exact IO resume does not treat prod account risk as a day-scoped VPS entry block', async () => {
  const value = await active({
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'prod',
      account_risk_status: 'active',
      error_class: 'account_risk_status_active',
    }),
  });
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'account_risk_status_active';
  for (const item of Object.values(paused.tasks)) item.state = 'PAUSED';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /account_risk_status_active/,
  );
  assert.equal(value.task.status().state, 'PAUSED');
});


test('exact IO resume accepts a persisted safety monitor failure only after diagnostics are clear', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'safety_monitor_failed';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.resume_reason, 'io_fix_verified');
});

test('exact recovery resumes a repaired output contract only after all checks pass', async () => {
  for (const pauseReason of ['invalid_output_fields', 'unsafe_output', 'invalid_safety_output', 'invalid_intraday_output_contract', 'invalid_report_message']) {
    const value = await active();
    const paused = value.task.status();
    paused.state = 'PAUSED'; paused.pause_reason = pauseReason;
    for (const item of Object.values(paused.tasks)) {
      item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
    }
    fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
    const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });
    assert.equal(state.state, 'ACTIVE');
    assert.equal(state.resume_reason, 'io_fix_verified');
    assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
    assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  }
});

test('exact recovery resumes after the missing weekly universe is repaired', async () => {
  for (const pauseReason of ['intraday_universe_unavailable', 'intraday_universe_invalid']) {
    const value = await active();
    const paused = value.task.status();
    paused.state = 'PAUSED'; paused.pause_reason = pauseReason;
    for (const item of Object.values(paused.tasks)) {
      item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
    }
    fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
    const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });
    assert.equal(state.state, 'ACTIVE');
    assert.equal(state.resume_reason, 'io_fix_verified');
    assert.equal(state.tasks[mod.TASKS[1].id].state, 'ACTIVE');
    assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
  }
});

test('IO resume preserves pause when the safety monitor remains blocked', async () => {
  const value = await active({
    safetyOutput: safetyOutput('blocked', {
      open_order_status: 'active', error_class: 'open_order_status_active',
    }),
  });
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'process_error';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /open_order_status_active/,
  );
  assert.equal(value.task.status().state, 'PAUSED');
});

test('database IO recovery requires the existing activation preflight before resume', async () => {
  const value = await active();
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'database_file_io_failed';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.resume_reason, 'io_fix_verified');
});

test('account-risk evidence recovery requires activation preflight and clear safety state', async () => {
  let activationPreflights = 0;
  const options = {
    onActivationPreflight() { activationPreflights += 1; },
  };
  const value = await active(options);
  options.activationPreflightOutput = good(mod.TASKS[0].id, 'no_op', {
    action_type: 'idempotent_no_op',
  });
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'account_risk_evidence_missing';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  const state = await value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL });

  assert.equal(activationPreflights, 2);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.resume_reason, 'io_fix_verified');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'DISABLED');
});

test('database recovery does not accept an idempotent activation preflight', async () => {
  const options = {};
  const value = await active(options);
  options.activationPreflightOutput = good(mod.TASKS[0].id, 'no_op', {
    action_type: 'idempotent_no_op',
  });
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'database_file_io_failed';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));

  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /database_recovery_preflight_failed/,
  );
  assert.equal(value.task.status().state, 'PAUSED');
});

test('database IO recovery remains paused when the activation preflight fails closed', async () => {
  const options = {};
  const value = await active(options);
  options.activationPreflightError = Object.assign(new Error('blocked'), { code: 2, killed: false });
  options.activationPreflightOutput = good(mod.TASKS[0].id, 'blocked', {
    action_type: 'paused', error_class: 'database_file_io_failed',
  });
  const paused = value.task.status();
  paused.state = 'PAUSED'; paused.pause_reason = 'database_file_io_failed';
  for (const item of Object.values(paused.tasks)) {
    item.state = 'PAUSED'; item.pause_reason = 'peer_task_fail_closed'; item.next_run_at = null;
  }
  fs.writeFileSync(value.paths.statePath, JSON.stringify(paused));
  await assert.rejects(
    value.task.resumeAfterIoFix({ approval: mod.RESUME_AFTER_IO_FIX_APPROVAL }),
    /database_file_io_failed/,
  );
  assert.equal(value.task.status().state, 'PAUSED');
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
  assert.equal(typeof mod.defaultSourceParityCheck(), 'boolean');
});

test('state corruption faults and pauses polling without executing child', async () => {
  let calls = 0; const callbacks = []; const sent = [];
  const value = await active({
    schedulerRegistered: true, serverRegistered: true,
    setTimer(fn) { callbacks.push(fn); return { unref() {} }; }, clearTimer() {},
    execFile(c, a, o, cb) { calls += 1; cb(null, good(mod.TASKS[0].id)); },
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
  });
  value.task.start();
  fs.writeFileSync(value.paths.statePath, '{');
  const result = await value.task.tick();
  assert.equal(result.state, 'PAUSED'); assert.equal(result.scheduler_faulted, true);
  assert.equal(calls, 0); assert.equal(callbacks.length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /원인: scheduler_state_fault/);
});

test('status and direct runOnce share one persistent state-fault notification claim', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
  });
  fs.writeFileSync(value.paths.statePath, '{');
  assert.equal(value.task.status().pause_reason, 'state_unavailable');
  await new Promise((resolve) => setImmediate(resolve));
  const direct = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date() });
  assert.equal(direct.pause_reason, 'state_unavailable');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].deliveryLayer, 'hermes_ai_market_open_error');
  assert.match(sent[0].content, /scheduler_state_fault/);
});

test('independent task instances acquire one exclusive state-fault notification claim', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
  });
  const peer = mod.createKisAiMarketOpenDryRunTask({
    ...value.paths,
    runtimeContract: mod.REQUIRED_RUNTIME_CONTRACT,
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
  });
  fs.writeFileSync(value.paths.statePath, '{');
  assert.equal(value.task.status().pause_reason, 'state_unavailable');
  assert.equal(peer.status().pause_reason, 'state_unavailable');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
});

test('state-fault claim I/O failure remains fail-closed without an unhandled alert promise', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
  });
  fs.writeFileSync(value.paths.statePath, '{');
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (typeof target === 'number') throw new Error('claim write failed');
    return originalWrite(target, ...args);
  };
  try {
    assert.equal(value.task.status().pause_reason, 'state_unavailable');
    await new Promise((resolve) => setImmediate(resolve));
    const direct = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date() });
    assert.equal(direct.pause_reason, 'state_unavailable');
    assert.equal(sent.length, 0);
  } finally {
    fs.writeFileSync = originalWrite;
  }
});

const report = '[KIS VPS 모의투자 일일 결과]\n기준일: 2026-07-21\n오늘 체결: 매수 삼성전자(005930) 2주; 매도 현대차(005380) 1주\n현재 보유: 삼성전자(005930) 2주\n오늘 실현손익: +1,000원 (현금 증감 기준)\nAI 검증: 판단 3건 / 모델 변경 0회\n운영 상태: 정상\n실전계좌: 주문 없음';

test('daily report uses existing sender exactly once and stores status only', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(c, a, o, cb) { cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', decisions: 3, report_message: report })); },
  });
  value.setClock('2026-07-21T07:30:29Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:29Z') });
  assert.equal(sent.length, 1); assert.equal(sent[0].targetChannelId, mod.REPORT_TARGET_CHANNEL_ID);
  assert.equal(sent[0].content, report);
  assert.equal(state.tasks[mod.TASKS[3].id].last_run.status, 'report_sent');
  assert.equal(JSON.stringify(state).includes('삼성전자'), false);
});

test('daily report rejects unapproved symbols, price details, and mismatched facts before delivery', async () => {
  for (const unsafeReport of (
    [
      report.replace('삼성전자(005930)', '미승인종목(999999)'),
      report.replace('2주', '2주 @ 70,000원'),
      report.replace('2026-07-21', '2099-01-01'),
      report.replace('판단 3건', '판단 999건'),
    ]
  )) {
    let sends = 0;
    const value = await active({
      reportSender: async () => { sends += 1; return { discord_sent: true }; },
      execFile(c, a, o, cb) { cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', decisions: 3, report_message: unsafeReport })); },
    });
    value.setClock('2026-07-21T07:30:29Z');
    const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:29Z') });
    assert.equal(state.state, 'ACTIVE');
    assert.equal(state.tasks[mod.TASKS[3].id].state, 'PAUSED');
    assert.equal(state.tasks[mod.TASKS[3].id].pause_reason, 'invalid_report_message');
    assert.equal(sends, 1);
    assert.equal(state.last_error_notification.succeeded, true);
  }
});

test('daily report accepts bounded no-ledger and estimated-pnl variants', async () => {
  const variants = [
    report
      .replace('매수 삼성전자(005930) 2주; 매도 현대차(005380) 1주', '확인 불가 (주문 원장 없음)')
      .replace('삼성전자(005930) 2주', '확인 불가')
      .replace('+1,000원 (현금 증감 기준)', '계산 불가 (체결 근거 부족)'),
    report
      .replace('매수 삼성전자(005930) 2주; 매도 현대차(005380) 1주', '없음')
      .replace('삼성전자(005930) 2주', '없음')
      .replace('+1,000원 (현금 증감 기준)', '추정 -500원 (체결가 기준, 비용 제외)'),
    report
      .replace('매수 삼성전자(005930) 2주; 매도 현대차(005380) 1주', '매수 123456 2주; 매도 654321 1주')
      .replace('삼성전자(005930) 2주', '123456 2주'),
  ];
  for (const variant of variants) {
    const sent = [];
    const value = await active({
      reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
      execFile(c, a, o, cb) { cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', decisions: 3, report_message: variant })); },
    });
    value.setClock('2026-07-21T07:30:29Z');
    const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:29Z') });
    assert.equal(state.tasks[mod.TASKS[3].id].last_run.status, 'report_sent');
    assert.equal(sent.length, 1);
  }
});

test('report failure pauses only reporting and never retries the KIS cycle', async () => {
  let sends = 0; let runs = 0;
  const value = await active({
    reportSender: async () => { sends += 1; throw new Error('private detail'); },
    execFile(c, a, o, cb) { runs += 1; cb(null, good(mod.TASKS[3].id, 'report_ready', { action_type: 'daily_learning_report', decisions: 3, report_message: report })); },
  });
  value.setClock('2026-07-21T07:30:00Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[3].id, dueAt: new Date('2026-07-21T07:30:00Z') });
  assert.equal(sends, 1); assert.equal(runs, 1); assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[3].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[0].id].state, 'ACTIVE');
  assert.equal(state.last_error_notification.attempted, false);
  assert.equal(state.last_error_notification.succeeded, false);
});

test('AI verdict packet and response enforce the fixed model and decision contract', () => {
  const slotId = `${mod.TASKS[4].id}:2026-07-21:09:10`;
  const context = mod.parseDecisionContextOutput(decisionContext(slotId, ['005930', '000660']), slotId);
  const packet = mod.buildSanitizedAiPacket({ slotId, context });
  assert.equal(packet.model_id, 'gpt-5.6-terra');
  assert.equal(packet.candidates.length, 2);
  assert.deepEqual(packet.candidates.map((item) => item.review_tier), ['primary', 'primary']);
  assert.equal(packet.decision_contract.minimum_vps_entry_decisions, 0);
  assert.deepEqual(packet.decision_contract.required_position_symbols, []);
  assert.doesNotThrow(() => mod.parseAiVerdict(aiVerdict(packet, [{
    symbol: '005930', action: 'ENTER', target_weight_pct: 25, confidence_bucket: 'high',
    reason_codes: ['MOMENTUM_CONFIRMATION', 'RELATIVE_STRENGTH'],
  }]), packet));
  assert.throws(() => mod.parseAiVerdict({ ...aiVerdict(packet), model_id: 'fallback' }, packet), /invalid_ai_verdict/);
  assert.throws(() => mod.parseAiVerdict(aiVerdict(packet, [{
    symbol: '005930', action: 'HOLD', target_weight_pct: 1, confidence_bucket: 'high', reason_codes: ['NO_EDGE'],
  }]), packet), /invalid_ai_verdict/);
  assert.throws(() => mod.parseAiVerdict(aiVerdict(packet, [{
    symbol: '005380', action: 'REJECT', target_weight_pct: 0, confidence_bucket: 'low', reason_codes: ['NO_EDGE'],
  }]), packet), /invalid_ai_verdict/);
  assert.doesNotThrow(() => mod.parseAiVerdict(aiVerdict(packet), packet));
  const held = JSON.parse(decisionContext(slotId, ['005930', '000660']));
  Object.assign(held.candidates[0], { role: 'held_position', review_tier: 'position' });
  held.holdings = [{ symbol: '005930', quantity: 2 }];
  held.risk_aggregate.open_positions = 1;
  const heldContext = mod.parseDecisionContextOutput(JSON.stringify(held), slotId);
  const heldPacket = mod.buildSanitizedAiPacket({ slotId, context: heldContext });
  assert.deepEqual(heldPacket.decision_contract.required_position_symbols, ['005930']);
  assert.throws(() => mod.parseAiVerdict(aiVerdict(heldPacket), heldPacket), /llm_position_decision_missing/);
  assert.doesNotThrow(() => mod.parseAiVerdict(aiVerdict(heldPacket, [{
    symbol: '005930', action: 'HOLD', target_weight_pct: 0, confidence_bucket: 'medium',
    reason_codes: ['NO_EDGE'],
  }]), heldPacket));
  assert.throws(
    () => mod.parseDecisionContextOutput(decisionContext(slotId, ['005930'], 1), slotId),
    /invalid_decision_context/,
  );
});

test('2026-08-04 09:10 stale decision context pauses before LLM and KIS execution', async () => {
  const slotId = `${mod.TASKS[4].id}:2026-08-04:09:10`;
  const stale = JSON.parse(decisionContext(slotId, ['005930']));
  stale.official_trade_date = '2026-08-03';
  let llmCalls = 0;
  let executionCalls = 0;
  const value = await active({
    decisionContextOutput: JSON.stringify(stale),
    llmExecutor: async () => { llmCalls += 1; throw new Error('must not run'); },
    execFile(command, args, options, callback) {
      executionCalls += 1;
      callback(null, orderGood());
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const scheduled = value.task.status();
  scheduled.tasks[mod.TASKS[4].id].next_run_at = '2026-08-04T00:10:00.000Z';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(scheduled));
  value.setClock('2026-08-04T00:10:00Z');

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-08-04T00:10:00Z') });

  assert.equal(llmCalls, 0);
  assert.equal(executionCalls, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'invalid_decision_context');
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.deepEqual(fs.readdirSync(value.paths.orderAttestationDir), []);
  assert.equal(fs.existsSync(value.paths.verdictDir), false);
});

test('one transient decision-context failure skips the slot and consecutive two pauses', async () => {
  const slotId = `${mod.TASKS[4].id}:2026-07-21:09:10`;
  const blocked = JSON.parse(decisionContext(slotId, []));
  Object.assign(blocked, {
    status: 'blocked',
    holdings: [],
    account_aggregate: {},
    risk_aggregate: {},
    event_metadata: [],
    fail_closed: true,
    error_class: 'http_transport_failed',
  });
  let llmCalls = 0;
  let orderRuns = 0;
  const value = await active({
    decisionContextOutput: (dueKey) => JSON.stringify({ ...blocked, slot_id: dueKey }),
    llmExecutor: async () => { llmCalls += 1; throw new Error('must not run'); },
    execFile(command, args, options, callback) {
      orderRuns += 1;
      callback(null, orderGood());
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  value.setClock('2026-07-21T00:10:00Z');

  let state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:10:00Z') });
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].consecutive_transport_failures, 1);
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'transport_degraded_no_op');

  value.setClock('2026-07-21T00:20:00Z');
  state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:20:00Z') });
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'http_transport_failed');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.consecutive_transport_failures, 2);
  assert.equal(llmCalls, 0);
  assert.equal(orderRuns, 0);
});

test('decision-context child timeout degrades one slot without pausing or invoking orders', async () => {
  let decisionContextTimeout = null;
  let orderRuns = 0;
  const value = await active({
    decisionContextError: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }),
    onDecisionContext({ execOptions }) { decisionContextTimeout = execOptions.timeout; },
    execFile(command, args, options, callback) { orderRuns += 1; callback(null, orderGood()); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });

  assert.equal(decisionContextTimeout, mod.DECISION_CONTEXT_TIMEOUT_MS);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'transport_degraded_no_op');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.error_class, 'decision_context_timeout');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.no_same_slot_retry, true);
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.match(state.tasks[mod.TASKS[4].id].next_run_at, /T00:20:00\.000Z$/);
  assert.equal(orderRuns, 0);
});

test('non-timeout decision-context process failure remains fail-closed', async () => {
  let orderRuns = 0;
  const value = await active({
    decisionContextError: Object.assign(new Error('process failed'), { code: 1, killed: false }),
    execFile(command, args, options, callback) { orderRuns += 1; callback(null, orderGood()); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });

  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'decision_context_process_error');
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(orderRuns, 0);
});

test('AI packet accepts bounded six-digit symbols outside the legacy three-symbol watchlist', () => {
  const slotId = `${mod.TASKS[4].id}:2026-07-21:09:10`;
  const context = mod.parseDecisionContextOutput(decisionContext(slotId, ['035720', '247540']), slotId);
  const packet = mod.buildSanitizedAiPacket({ slotId, context });
  assert.deepEqual(packet.candidates.map((item) => item.symbol), ['035720', '247540']);
});

test('AI packet preserves bounded watch review metadata without expanding actions', () => {
  const slotId = `${mod.TASKS[4].id}:2026-07-21:09:10`;
  const parsed = JSON.parse(decisionContext(slotId, ['005930']));
  parsed.candidates[0] = {
    ...parsed.candidates[0],
    review_tier: 'watch',
    ml_action: 'EXIT',
    confidence_bucket: 'low',
    prob_up: 0.44,
    prob_flat: 0.25,
    prob_down: 0.31,
  };
  const context = mod.parseDecisionContextOutput(JSON.stringify(parsed), slotId);
  const packet = mod.buildSanitizedAiPacket({ slotId, context });

  assert.equal(packet.candidates[0].review_tier, 'watch');
  assert.equal(packet.candidates[0].ml_action, 'EXIT');
  assert.deepEqual(packet.decision_contract.actions, ['ENTER', 'EXIT', 'HOLD', 'HOLD_OVERNIGHT', 'REJECT']);
});

test('order lifecycle notification is once-only and delivery failure never retries the order', async () => {
  const sent = [];
  let orderRuns = 0;
  const notificationKey = 'c'.repeat(64);
  const output = orderGood('success', {
    action_type: 'entry_reconciled', order_api_calls: 1, vps_live_orders: 1,
    reconciliations: 1, open_positions: 1, daily_entry_count: 1,
    order_symbol: '035720', order_name: '카카오', order_side: 'buy', requested_quantity: 3,
    filled_quantity: 3, unfilled_quantity: 0, lifecycle_status: 'filled',
    decision_reason_codes: ['MOMENTUM_CONFIRMATION', 'RELATIVE_STRENGTH'],
    notification_idempotency_key: notificationKey,
  });
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: false }; },
    execFile(command, args, options, callback) { orderRuns += 1; callback(null, output); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  value.setClock('2026-07-21T00:10:00Z');
  let state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:10:00Z') });
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.order_notification_succeeded, false);
  assert.equal(sent[0].idempotencyKey, notificationKey);
  assert.match(sent[0].content, /매수 카카오\(035720\) 3주/);
  assert.match(sent[0].content, /판단 근거: 상승 흐름 확인, 시장·동종 종목 대비 강세/);
  assert.doesNotMatch(sent[0].content, /MOMENTUM_CONFIRMATION|RELATIVE_STRENGTH/);
  value.setClock('2026-07-21T00:20:00Z');
  state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:20:00Z') });
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.order_notification_duplicate_suppressed, true);
  assert.equal(sent.length, 1);
  assert.equal(orderRuns, 2);
});

test('intraday AI verdict is bounded, passed by path only, and deleted after KIS completes', async () => {
  let seenPath = null;
  let contextToken = null;
  let contextDueKey = null;
  let contextAttestation = null;
  let executionToken = null;
  const value = await active({
    onDecisionContext({ execOptions }) {
      contextToken = execOptions.env.KIS_HERMES_SCHEDULER_TOKEN;
      const dueKey = execOptions.env.KIS_HERMES_DUE_KEY;
      contextDueKey = dueKey;
      const file = path.join(
        value.paths.orderAttestationDir,
        `${crypto.createHash('sha256').update(dueKey).digest('hex')}.json`,
      );
      contextAttestation = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(contextAttestation.token_hash, crypto.createHash('sha256').update(contextToken).digest('hex'));
      fs.unlinkSync(file);
    },
    execFile(command, args, options, callback) {
      executionToken = options.env.KIS_HERMES_SCHEDULER_TOKEN;
      assert.notEqual(executionToken, contextToken);
      const dueKey = options.env.KIS_HERMES_DUE_KEY;
      assert.equal(dueKey, contextDueKey);
      const attestationFile = path.join(
        value.paths.orderAttestationDir,
        `${crypto.createHash('sha256').update(dueKey).digest('hex')}.json`,
      );
      const attestation = JSON.parse(fs.readFileSync(attestationFile, 'utf8'));
      assert.equal(attestation.token_hash, crypto.createHash('sha256').update(executionToken).digest('hex'));
      for (const key of [
        'due_key', 'daily_entry_cap', 'decision_provider', 'intraday_feature_version',
        'intraday_policy_version', 'intraday_feature_hash', 'intraday_policy_hash',
      ]) assert.equal(attestation[key], contextAttestation[key]);
      const pending = JSON.parse(fs.readFileSync(value.paths.statePath, 'utf8'))
        .tasks[mod.TASKS[4].id].pending_invocation;
      assert.deepEqual(pending, attestation);
      seenPath = options.env.KIS_LLM_VERDICT_PATH;
      assert.ok(seenPath);
      assert.equal(args.includes(seenPath), false);
      if (process.platform !== 'win32') assert.equal(fs.statSync(seenPath).mode & 0o777, 0o600);
      const verdict = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
      assert.equal(verdict.model_id, mod.LLM_MODEL_ID);
      assert.match(options.env.KIS_LLM_PROMPT_HASH, /^[a-f0-9]{64}$/);
      callback(null, orderGood());
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  value.setClock('2026-07-21T00:10:00Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:10:00Z') });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(fs.existsSync(seenPath), false);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.decision_context_candidate_count, 1);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.llm_invoked, true);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.llm_verdict_status, 'validated');
});

test('empty decision context still rotates the consumed attestation before no-op execution', async () => {
  let contextToken = null;
  let executionToken = null;
  let llmCalls = 0;
  const value = await active({
    decisionContextOutput: decisionContext(
      `${mod.TASKS[4].id}:2026-07-21:09:10`,
      [],
    ),
    llmExecutor: async () => { llmCalls += 1; throw new Error('must not run'); },
    onDecisionContext({ execOptions }) {
      contextToken = execOptions.env.KIS_HERMES_SCHEDULER_TOKEN;
      const dueKey = execOptions.env.KIS_HERMES_DUE_KEY;
      const file = path.join(
        value.paths.orderAttestationDir,
        `${crypto.createHash('sha256').update(dueKey).digest('hex')}.json`,
      );
      fs.unlinkSync(file);
    },
    execFile(command, args, options, callback) {
      executionToken = options.env.KIS_HERMES_SCHEDULER_TOKEN;
      assert.notEqual(executionToken, contextToken);
      assert.equal(options.env.KIS_LLM_VERDICT_PATH, undefined);
      callback(null, orderGood('no_op', { action_type: 'no_candidate_no_op' }));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  value.setClock('2026-07-21T00:10:00Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:10:00Z') });
  assert.equal(llmCalls, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'no_candidate_no_op');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.decision_context_candidate_count, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.llm_invoked, false);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.llm_verdict_status, 'skipped_no_candidates');
});

test('decision context state drift blocks before issuing an execution attestation', async () => {
  const mutations = [
    { stateInvalid: false, apply(task) { task.activation_artifact_hash = 'b'.repeat(64); } },
    { stateInvalid: true, apply(task) { task.intraday_policy_hash = 'b'.repeat(64); } },
    { stateInvalid: true, apply(task) { task.daily_entry_cap_approval_hash = 'c'.repeat(64); } },
  ];
  for (const mutation of mutations) {
    let orderRuns = 0;
    const value = await active({
      onDecisionContext() {
        const state = value.task.status();
        mutation.apply(state.tasks[mod.TASKS[4].id]);
        fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
      },
      execFile(command, args, options, callback) {
        orderRuns += 1;
        callback(null, orderGood());
      },
    });
    await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
    value.setClock('2026-07-21T00:10:00Z');
    const run = value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:10:00Z') });
    if (mutation.stateInvalid) {
      await assert.rejects(run, /state_unavailable/);
      assert.equal(orderRuns, 0);
      continue;
    }
    const state = await run;
    assert.equal(orderRuns, 0);
    assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
    assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'scheduler_attestation_state_changed');
  }
});

test('mismatched AI verdict blocks before KIS execution without fallback', async () => {
  let calls = 0;
  const value = await active({
    llmExecutor: async ({ packet }) => ({ ...aiVerdict(packet), prompt_hash: '0'.repeat(64) }),
    execFile(command, args, options, callback) { calls += 1; callback(null, orderGood()); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  value.setClock('2026-07-21T00:10:00Z');
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:10:00Z') });
  assert.equal(calls, 0);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'invalid_ai_verdict');
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.deepEqual(fs.readdirSync(value.paths.orderAttestationDir), []);
  assert.equal(fs.existsSync(value.paths.verdictDir), false);
});

test('one-minute safety monitor keeps supervision active and pauses only orders on a non-global block', async () => {
  let llmCalls = 0;
  const value = await active({
    schedulerRegistered: true,
    llmExecutor: async () => { llmCalls += 1; throw new Error('must not run'); },
    safetyOutput: safetyOutput('blocked', { process_lock: 'active' }),
  });
  markOrderActive(value);
  value.setClock('2026-07-21T00:01:00Z');
  const state = await value.task.tick();
  assert.equal(llmCalls, 0);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'safe_block');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);
});

test('official non-trading days do not query account risk or pause an active order task', async () => {
  let safetyCalls = 0;
  let tradingDay = true;
  const value = await active({
    schedulerRegistered: true,
    calendarProofResolver: () => calendarProof(tradingDay),
    safetyOutput() {
      safetyCalls += 1;
      return safetyOutput('blocked', { error_class: 'account_risk_evidence_missing' });
    },
  });
  markOrderActive(value);
  tradingDay = false;
  value.setClock('2026-09-05T00:29:00Z');

  const state = await value.task.tick();

  assert.equal(safetyCalls, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(Object.values(state.incidents).length, 0);
});

test('VPS account-risk state pauses new orders while supervision remains active', async () => {
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'vps', account_risk_status: 'active',
      error_class: 'account_risk_status_active',
    }),
  };
  const value = await active(options);
  markOrderActive(value);
  value.setClock('2026-07-21T00:01:00Z');

  const state = await value.task.tick();

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'account_risk_status_active');
  assert.equal(mod.TASKS.slice(0, 4).every((task) => state.tasks[task.id].state === 'ACTIVE'), true);

  options.safetyOutput = safetyOutput();
  value.setClock('2026-07-21T00:02:00Z');
  const recovered = await value.task.tick();
  assert.equal(recovered.state, 'ACTIVE');
  assert.equal(recovered.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(recovered.tasks[mod.TASKS[4].id].pause_reason, undefined);
  assert.equal(recovered.retry, false);
  assert.equal(recovered.catch_up, false);
});

test('clear account risk resolves its recovery incident and reactivates orders', async () => {
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'vps', account_risk_status: 'unknown',
      open_order_status: 'unknown', error_class: 'account_risk_evidence_missing',
    }),
  };
  const value = await active(options);
  markOrderActive(value);
  value.setClock('2026-07-21T00:01:00Z');
  await value.task.tick();
  value.setClock('2026-07-21T00:02:00Z');
  const paused = await value.task.tick();
  const incident = Object.values(paused.incidents)
    .find((entry) => entry.error_class === 'account_risk_evidence_missing');
  assert.equal(paused.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(incident.status, 'awaiting_approval');

  options.safetyOutput = safetyOutput();
  value.setClock('2026-07-21T00:03:00Z');
  const recovered = await value.task.tick();

  assert.equal(recovered.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(recovered.incidents[incident.incident_id].status, 'resolved');
  assert.equal(recovered.incidents[incident.incident_id].result.order_reactivated, true);
  assert.equal(recovered.incidents[incident.incident_id].result.broker_order_api_calls, 0);
});

test('prod account-risk state remains paused after a clear monitor', async () => {
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'prod', account_risk_status: 'active',
      error_class: 'account_risk_status_active',
    }),
  };
  const value = await active(options);
  markOrderActive(value);
  value.setClock('2026-07-21T00:01:00Z');
  const paused = await value.task.tick();
  assert.equal(paused.tasks[mod.TASKS[4].id].state, 'PAUSED');

  options.safetyOutput = safetyOutput();
  value.setClock('2026-07-21T00:02:00Z');
  const held = await value.task.tick();
  assert.equal(held.state, 'ACTIVE');
  assert.equal(held.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(held.tasks[mod.TASKS[4].id].pause_reason, 'account_risk_status_active');
});

test('active reconciliation pauses for button approval without automatic recovery', async () => {
  let recoveryCalls = 0;
  let safetyCalls = 0;
  let orderCalls = 0;
  const value = await active({
    schedulerRegistered: true,
    safetyOutput() {
      safetyCalls += 1;
      return safetyOutput('blocked', {
        reconciliation_status: 'active', error_class: 'reconciliation_status_active',
      });
    },
    execFile(command, args, execOptions, callback) {
      if (args.includes('reconcile-paused')) {
        recoveryCalls += 1;
        assert.ok(args.includes('--read-only-broker'));
        callback(null, orderGood('success', {
          action_type: 'reconciliation_recovered', reconciliations: 1,
        }));
        return;
      }
      if (args.includes('vps-autonomous-order') && args.includes('run-once')) {
        orderCalls += 1;
        callback(null, orderGood());
        return;
      }
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  markOrderActive(value);
  value.setClock('2026-07-21T00:10:00Z');

  const state = await value.task.tick();

  assert.equal(recoveryCalls, 0);
  assert.equal(safetyCalls, 1);
  assert.equal(orderCalls, 0);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'reconciliation_status_active');
  const incident = Object.values(state.incidents)
    .find((entry) => entry.error_class === 'reconciliation_status_active');
  assert.equal(incident.status, 'awaiting_approval');
  assert.equal(incident.scope, 'reconcile_paused_once');
});

test('repeated transient safety failure pauses only new orders', async () => {
  let taskRuns = 0;
  let repairs = 0;
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      open_order_status: 'unknown', error_class: 'safety_monitor_failed',
    }),
    execFile(command, args, execOptions, callback) {
      taskRuns += 1;
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
    repairTaskSender: async () => { repairs += 1; return { task_id: 'repair' }; },
  };
  const value = await active(options);
  markOrderActive(value);

  value.setClock('2026-07-21T00:01:00Z');
  const held = await value.task.tick();
  assert.equal(held.state, 'ACTIVE');
  assert.equal(held.last_safety_monitor.status, 'blocked');
  assert.equal(held.last_safety_monitor.error_class, 'safety_monitor_failed');
  assert.equal(held.consecutive_safety_monitor_failures, 1);
  assert.equal(held.last_self_heal, undefined);
  assert.equal(repairs, 0);
  assert.equal(taskRuns, 0);

  options.safetyOutput = safetyOutput('blocked', {
    open_order_status: 'unknown', error_class: 'process_error',
  });
  value.setClock('2026-07-21T00:02:00Z');
  const paused = await value.task.tick();
  assert.equal(paused.state, 'ACTIVE');
  assert.equal(paused.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(paused.tasks[mod.TASKS[4].id].pause_reason, 'process_error');
  assert.equal(paused.consecutive_safety_monitor_failures, 2);
  assert.equal(mod.TASKS.slice(0, 4).every((task) => paused.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(repairs, 1);
  assert.equal(taskRuns, 0);
});

test('a clear monitor after one transient failure resumes future scheduling without catch-up', async () => {
  let taskRuns = 0;
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      open_order_status: 'unknown', error_class: 'safety_monitor_failed',
    }),
    execFile(command, args, execOptions, callback) {
      taskRuns += 1;
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  };
  const value = await active(options);
  markOrderActive(value);

  value.setClock('2026-07-21T00:01:00Z');
  const held = await value.task.tick();
  assert.equal(held.state, 'ACTIVE');
  assert.equal(taskRuns, 0);

  options.safetyOutput = safetyOutput();
  value.setClock('2026-07-21T00:02:00Z');
  const recovered = await value.task.tick();
  assert.equal(recovered.state, 'ACTIVE');
  assert.equal(recovered.last_safety_monitor.status, 'success');
  assert.equal(recovered.consecutive_safety_monitor_failures, 0);
  assert.equal(recovered.retry, false);
  assert.equal(recovered.catch_up, false);
  assert.equal(recovered.backfill, false);
});

test('a paused transient safety failure auto-resumes all previously activated tasks after a clear monitor', async () => {
  const value = await active({ schedulerRegistered: true, safetyOutput: safetyOutput() });
  const current = value.task.status();
  const tasks = Object.fromEntries(Object.entries(current.tasks).map(([id, item]) => [id, {
    ...item,
    state: 'PAUSED',
    next_run_at: null,
    pause_reason: 'account_risk_evidence_missing',
  }]));
  fs.writeFileSync(value.paths.statePath, JSON.stringify({
    ...current,
    state: 'PAUSED',
    pause_reason: 'account_risk_evidence_missing',
    order_activated_at: '2026-07-21T00:00:00.000Z',
    tasks,
    last_safety_monitor: {
      checked_at: '2026-07-20T23:59:00.000Z',
      status: 'blocked',
      error_class: 'account_risk_evidence_missing',
    },
  }));
  value.setClock('2026-07-21T00:01:00Z');

  const recovered = await value.task.tick();

  assert.equal(recovered.state, 'ACTIVE');
  assert.equal(recovered.pause_reason, undefined);
  assert.equal(recovered.resume_reason, 'safety_monitor_auto_recovered');
  assert.equal(recovered.resumed_by, 'hermes_safety_monitor');
  assert.equal(Object.values(recovered.tasks).every((item) => item.state === 'ACTIVE'), true);
  assert.equal(recovered.last_safety_monitor.status, 'success');
  assert.equal(recovered.retry, false);
  assert.equal(recovered.catch_up, false);
});

for (const pauseReason of [
  'open_order_status_unavailable',
  'open_order_status_active',
  'unknown_runtime_io_failed',
  'order_submission_unknown',
]) test(`a paused ${pauseReason} auto-resumes only after a clear safety monitor`, async () => {
  const value = await active({ schedulerRegistered: true, safetyOutput: safetyOutput() });
  const current = value.task.status();
  const tasks = Object.fromEntries(Object.entries(current.tasks).map(([id, item]) => [id, {
    ...item,
    state: 'PAUSED',
    next_run_at: null,
    pause_reason: pauseReason,
  }]));
  fs.writeFileSync(value.paths.statePath, JSON.stringify({
    ...current,
    state: 'PAUSED',
    pause_reason: pauseReason,
    order_activated_at: '2026-07-21T00:00:00.000Z',
    tasks,
  }));
  value.setClock('2026-07-21T00:01:00Z');

  const recovered = await value.task.tick();

  assert.equal(recovered.state, 'ACTIVE');
  assert.equal(recovered.resume_reason, 'safety_monitor_auto_recovered');
  assert.equal(Object.values(recovered.tasks).every((item) => item.state === 'ACTIVE'), true);
  assert.equal(recovered.last_safety_monitor.status, 'success');
});

test('an active broker order stays paused until a later safety monitor reports clear', async () => {
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      open_order_status: 'active', error_class: 'open_order_status_active',
    }),
  };
  const value = await active(options);
  markOrderActive(value);
  const current = value.task.status();
  const tasks = Object.fromEntries(Object.entries(current.tasks).map(([id, item]) => [id, {
    ...item, state: 'PAUSED', next_run_at: null, pause_reason: 'open_order_status_active',
  }]));
  fs.writeFileSync(value.paths.statePath, JSON.stringify({
    ...current,
    state: 'PAUSED',
    pause_reason: 'open_order_status_active',
    order_activated_at: '2026-07-21T00:00:00.000Z',
    tasks,
  }));

  value.setClock('2026-07-21T00:01:00Z');
  const held = await value.task.tick();
  assert.equal(held.state, 'PAUSED');
  assert.equal(held.last_safety_monitor.error_class, 'open_order_status_active');

  options.safetyOutput = safetyOutput();
  value.setClock('2026-07-21T00:02:00Z');
  const recovered = await value.task.tick();
  assert.equal(recovered.state, 'ACTIVE');
  assert.equal(recovered.resume_reason, 'safety_monitor_auto_recovered');
  assert.equal(recovered.retry, false);
  assert.equal(recovered.catch_up, false);
});

test('provider timeout stays fail-closed without pausing or running tasks', async () => {
  let taskRuns = 0;
  const value = await active({
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', { error_class: 'timeout' }),
    execFile(command, args, execOptions, callback) {
      taskRuns += 1;
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });

  for (let minute = 1; minute <= 6; minute += 1) {
    value.setClock(`2026-07-21T00:0${minute}:00Z`);
    const held = await value.task.tick();
    assert.equal(held.state, 'ACTIVE');
    assert.equal(held.consecutive_safety_monitor_failures, minute);
  }
  assert.equal(taskRuns, 0);
});

test('open-order read outage holds tasks for four minutes and then pauses only new orders', async () => {
  let taskRuns = 0;
  let notifications = 0;
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      open_order_status: 'unknown', error_class: 'open_order_status_unavailable',
    }),
    execFile(command, args, execOptions, callback) {
      taskRuns += 1;
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
    reportSender: async () => {
      notifications += 1;
      return { discord_sent: true };
    },
  };
  const value = await active(options);
  markOrderActive(value);

  for (let minute = 1; minute <= 4; minute += 1) {
    value.setClock(`2026-07-21T00:0${minute}:00Z`);
    const held = await value.task.tick();
    assert.equal(held.state, 'ACTIVE');
    assert.equal(held.last_safety_monitor.status, 'blocked');
    assert.equal(held.consecutive_safety_monitor_failures, minute);
    assert.equal(taskRuns, 0);
  }

  value.setClock('2026-07-21T00:05:00Z');
  const paused = await value.task.tick();
  assert.equal(paused.state, 'ACTIVE');
  assert.equal(paused.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(paused.tasks[mod.TASKS[4].id].pause_reason, 'open_order_status_unavailable');
  assert.equal(paused.consecutive_safety_monitor_failures, 5);
  assert.equal(mod.TASKS.slice(0, 4).every((task) => paused.tasks[task.id].state === 'ACTIVE'), true);
  assert.equal(notifications, 1);
  assert.equal(taskRuns, 0);
});

test('open-order read outage recovers automatically before its bounded limit', async () => {
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      open_order_status: 'unknown', error_class: 'open_order_status_unavailable',
    }),
  };
  const value = await active(options);
  markOrderActive(value);

  value.setClock('2026-07-21T00:01:00Z');
  await value.task.tick();
  value.setClock('2026-07-21T00:02:00Z');
  const held = await value.task.tick();
  assert.equal(held.state, 'ACTIVE');
  assert.equal(held.consecutive_safety_monitor_failures, 2);

  options.safetyOutput = safetyOutput();
  value.setClock('2026-07-21T00:03:00Z');
  const recovered = await value.task.tick();
  assert.equal(recovered.state, 'ACTIVE');
  assert.equal(recovered.last_safety_monitor.status, 'success');
  assert.equal(recovered.consecutive_safety_monitor_failures, 0);
});

test('mixed safety failures retain the threshold but pause only new orders', async () => {
  let notifications = 0;
  const options = {
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      open_order_status: 'unknown', error_class: 'safety_monitor_failed',
    }),
    reportSender: async () => {
      notifications += 1;
      return { discord_sent: true };
    },
  };
  const value = await active(options);
  markOrderActive(value);

  value.setClock('2026-07-21T00:01:00Z');
  const first = await value.task.tick();
  assert.equal(first.state, 'ACTIVE');

  options.safetyOutput = safetyOutput('blocked', {
    open_order_status: 'unknown', error_class: 'open_order_status_unavailable',
  });
  value.setClock('2026-07-21T00:02:00Z');
  const paused = await value.task.tick();
  assert.equal(paused.state, 'ACTIVE');
  assert.equal(paused.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(paused.tasks[mod.TASKS[4].id].pause_reason, 'open_order_status_unavailable');
  assert.equal(paused.consecutive_safety_monitor_failures, 2);
  assert.equal(notifications, 1);
});

test('safety monitor preserves a sanitized blocker returned with fail-closed exit code 2', async () => {
  const error = Object.assign(new Error('Command failed'), { code: 2, killed: false });
  const value = await active({
    schedulerRegistered: true,
    safetyError: error,
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'prod', account_risk_status: 'active',
      error_class: 'account_risk_status_active',
    }),
  });
  markOrderActive(value);
  value.setClock('2026-07-21T00:01:00Z');
  const state = await value.task.tick();
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason, 'account_risk_status_active');
  assert.equal(state.tasks[mod.TASKS[4].id].pause_reason === 'process_error', false);
});

test('VPS daily loss blocks entries without pausing supervision or position management', async () => {
  let notifications = 0;
  let orderRuns = 0;
  const error = Object.assign(new Error('Command failed'), { code: 2, killed: false });
  const value = await active({
    schedulerRegistered: true,
    reportSender: async () => { notifications += 1; return { discord_sent: true }; },
    safetyError: error,
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'vps', account_risk_status: 'active',
      error_class: 'daily_loss_entry_blocked',
    }),
    decisionContextOutput(dueKey) {
      const held = JSON.parse(decisionContext(dueKey, ['005930']));
      Object.assign(held.candidates[0], { role: 'held_position', review_tier: 'position' });
      held.holdings = [{ symbol: '005930', quantity: 2 }];
      held.risk_aggregate.open_positions = 1;
      return JSON.stringify(held);
    },
    llmExecutor: async ({ packet }) => aiVerdict(packet, [{
      symbol: '005930', action: 'HOLD', target_weight_pct: 0,
      confidence_bucket: 'medium', reason_codes: ['NO_EDGE'],
    }]),
    execFile(command, args, options, callback) {
      orderRuns += 1;
      callback(null, orderGood('no_op', { action_type: 'ai_position_held', open_positions: 1 }));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = '2026-07-21T00:10:00.000Z';
  const scheduled = value.task.status();
  for (const task of mod.TASKS) scheduled.tasks[task.id].next_run_at = '2026-07-21T23:59:00.000Z';
  scheduled.tasks[mod.TASKS[4].id].next_run_at = dueAt;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(scheduled));
  value.setClock(dueAt);

  const state = await value.task.tick();

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.last_safety_monitor.error_class, 'daily_loss_entry_blocked');
  assert.equal(state.last_safety_monitor.fail_closed, true);
  assert.equal(state.consecutive_safety_monitor_failures, 0);
  assert.equal(notifications, 0);
  assert.equal(orderRuns, 1);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'ai_position_held');
});

for (const entryBlock of ['daily_loss_limit_reached', 'daily_risk_budget_insufficient']) test(`VPS ${entryBlock} rejects a mixed-slot entry without pausing later position management`, async () => {
  let orderRuns = 0;
  const error = Object.assign(new Error('Command failed'), { code: 2, killed: false });
  const value = await active({
    safetyError: error,
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'vps', account_risk_status: 'active',
      error_class: 'daily_loss_entry_blocked',
    }),
    decisionContextOutput(dueKey) {
      const mixed = JSON.parse(decisionContext(dueKey, ['005930', '000660']));
      Object.assign(mixed.candidates[0], { role: 'held_position', review_tier: 'position' });
      mixed.holdings = [{ symbol: '005930', quantity: 2 }];
      mixed.risk_aggregate.open_positions = 1;
      return JSON.stringify(mixed);
    },
    llmExecutor: async ({ packet }) => aiVerdict(packet, [
      {
        symbol: '005930', action: 'HOLD', target_weight_pct: 0,
        confidence_bucket: 'medium', reason_codes: ['NO_EDGE'],
      },
      {
        symbol: '000660', action: 'ENTER', target_weight_pct: 20,
        confidence_bucket: 'high', reason_codes: ['MOMENTUM_CONFIRMATION'],
      },
    ]),
    execFile(command, args, options, callback) {
      orderRuns += 1;
      callback(error, orderGood('blocked', { error_class: entryBlock, open_positions: 1 }));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = '2026-07-21T00:10:00.000Z';
  const scheduled = value.task.status();
  for (const task of mod.TASKS) scheduled.tasks[task.id].next_run_at = '2026-07-21T23:59:00.000Z';
  scheduled.tasks[mod.TASKS[4].id].next_run_at = dueAt;
  scheduled.tasks[mod.TASKS[4].id].consecutive_transport_failures = 1;
  fs.writeFileSync(value.paths.statePath, JSON.stringify(scheduled));
  value.setClock(dueAt);

  const state = await value.task.tick();

  assert.equal(orderRuns, 1);
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.error_class, entryBlock);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.order_api_calls, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].consecutive_transport_failures, 0);
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.match(state.tasks[mod.TASKS[4].id].next_run_at, /T00:20:00\.000Z$/);
});

test('MDD safety block performs one automatic risk-off reconciliation before persistent pause', async () => {
  let emergencyCalls = 0;
  const value = await active({
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      execution_owner: 'prod', account_risk_status: 'active', error_class: 'mdd_liquidation_required',
    }),
    emergencyStopExecutor: async ({ automaticRiskOff }) => {
      emergencyCalls += 1;
      assert.equal(automaticRiskOff, true);
      return {
        status: 'success', execution_owner: 'prod', positions_liquidated: 2,
        reconciliation_passed: true, error_class: 'persistent_stop_active',
      };
    },
  });
  value.setClock('2026-07-21T00:01:00Z');
  const state = await value.task.tick();
  assert.equal(emergencyCalls, 1);
  assert.equal(state.state, 'PAUSED');
  assert.equal(state.pause_reason, 'mdd_liquidation_required');
  assert.equal(state.last_safety_monitor.error_class, 'mdd_liquidation_required');
  assert.equal(state.tasks[mod.TASKS[0].id].last_run.emergency_reconciliation_passed, true);
});

test('failed automatic risk-off is not retried and records sanitized blocker', async () => {
  let emergencyCalls = 0;
  const value = await active({
    schedulerRegistered: true,
    safetyOutput: safetyOutput('blocked', {
      kill_state: 'active', error_class: 'kill_switch_liquidation_required',
    }),
    emergencyStopExecutor: async () => {
      emergencyCalls += 1;
      return {
        status: 'blocked', execution_owner: 'vps', positions_liquidated: 0,
        reconciliation_passed: false, error_class: 'open_buy_cancel_unconfirmed',
      };
    },
  });
  value.setClock('2026-07-21T00:01:00Z');
  const state = await value.task.tick();
  assert.equal(emergencyCalls, 1);
  assert.equal(state.state, 'PAUSED');
  assert.equal(state.pause_reason, 'emergency_open_buy_cancel_unconfirmed');
});

test('runtime contract is required for production construction and governs slot, quote, and position limits', () => {
  assert.throws(() => mod.loadRuntimeContract('/missing/runtime-contract.json'), /runtime_contract_unavailable/);
  assert.equal(mod.REQUIRED_RUNTIME_CONTRACT.slot_review_limit, 20);
  assert.equal(mod.REQUIRED_RUNTIME_CONTRACT.quote_api_calls_per_slot, 20);
  assert.equal(mod.REQUIRED_RUNTIME_CONTRACT.max_open_positions, 5);
  assert.equal(mod.REQUIRED_RUNTIME_CONTRACT.daily_entry_cap, null);
  const sourcePath = process.env.KIS_RUNTIME_CONTRACT_MANIFEST_PATH;
  assert.ok(sourcePath);
  const sourceManifest = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-runtime-contract-'));
  const manifestPath = path.join(root, 'adaptive_ai_dry_run_strategy_v1.json');
  fs.writeFileSync(manifestPath, JSON.stringify(sourceManifest));
  assert.deepEqual(mod.loadRuntimeContract(manifestPath), mod.REQUIRED_RUNTIME_CONTRACT);
  delete sourceManifest.manifest_hash;
  fs.writeFileSync(manifestPath, JSON.stringify(sourceManifest));
  assert.throws(() => mod.loadRuntimeContract(manifestPath), /runtime_contract_manifest_hash_mismatch/);
  sourceManifest.manifest_hash = '0'.repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(sourceManifest));
  assert.throws(() => mod.loadRuntimeContract(manifestPath), /runtime_contract_manifest_hash_mismatch/);
});

test('error policy preserves unknown safe classes without recovery and sanitizes secret-like detail', () => {
  assert.equal(mod.sanitizeErrorClass('future_safe_error'), 'future_safe_error');
  assert.equal(mod.ERROR_POLICY.future_safe_error, undefined);
  for (const errorClass of [
    'tls_failed',
    'quote_api_failed',
    'local_file_io_failed',
    'unknown_runtime_io_failed',
  ]) {
    assert.equal(mod.sanitizeErrorClass(errorClass), errorClass);
    assert.ok(mod.ERROR_POLICY[errorClass]);
  }
  assert.equal(mod.ERROR_POLICY.tls_failed.autoRepair, false);
  assert.equal(mod.ERROR_POLICY.quote_api_failed.autoResume, false);
  assert.equal(mod.ERROR_POLICY.local_file_io_failed.autoRepair, true);
  assert.equal(mod.ERROR_POLICY.local_file_io_failed.resumable, true);
  assert.equal(mod.ERROR_POLICY.unknown_runtime_io_failed.autoRepair, false);
  assert.equal(mod.ERROR_POLICY.unknown_runtime_io_failed.autoResume, true);
  assert.equal(mod.ERROR_POLICY.unknown_runtime_io_failed.resumable, true);
  assert.equal(mod.ERROR_POLICY.unknown_runtime_io_failed.scope, 'order');
  assert.equal(mod.ERROR_POLICY.order_submission_unknown.persistent, true);
  assert.equal(mod.ERROR_POLICY.order_submission_unknown.autoResume, true);
  assert.equal(mod.ERROR_POLICY.order_submission_unknown.scope, 'order');
  for (const errorClass of [
    'model_v3_post_close_promotion_forbidden',
    'hermes_scheduler_attestation_unavailable',
    'order_action_not_allowed_for_schedule_slot',
    'order_submission_unknown',
    'reconciliation_status_active',
    'account_risk_status_active',
    'scheduler_lock_active',
  ]) {
    assert.equal(mod.sanitizeErrorClass(errorClass), errorClass);
    assert.equal(mod.ERROR_POLICY[errorClass].persistent, true);
    assert.equal(mod.ERROR_POLICY[errorClass].autoRepair, false);
  }
  assert.equal(mod.ERROR_POLICY.reconciliation_status_active.autoResume, true);
  assert.equal(mod.ERROR_POLICY.account_risk_status_active.autoResume, true);
  assert.equal(mod.ERROR_POLICY.scheduler_lock_active.autoResume, false);
  assert.equal(mod.ERROR_POLICY.scheduler_lock_active.scope, 'global');
  assert.equal(mod.ERROR_POLICY.scheduler_state_fault.persistent, true);
  assert.equal(mod.ERROR_POLICY.scheduler_lock_failed.scope, 'global');
  assert.equal(mod.ERROR_POLICY.model_v1_must_be_paused.scope, 'global');
  assert.equal(mod.ERROR_POLICY.model_v2_must_be_paused.scope, 'global');
  assert.equal(mod.ERROR_POLICY.open_order_status_active.scope, 'order');
  assert.equal(mod.ERROR_POLICY.llm_response_timeout.slotDegradeOnly, true);
  assert.equal(mod.ERROR_POLICY.llm_position_decision_missing.slotDegradeOnly, true);
  assert.equal(mod.ERROR_POLICY.llm_position_decision_missing.orderRecovery, true);
  assert.equal(mod.ERROR_POLICY.intraday_decision_stale_or_missing.slotDegradeOnly, true);
  assert.equal(mod.ERROR_POLICY.intraday_decision_stale_or_missing.resumable, true);
  assert.equal(mod.ERROR_POLICY.model_v3_backfill_transport_unavailable.slotDegradeOnly, true);
  assert.equal(mod.ERROR_POLICY.llm_response_timeout.transient, false);
  assert.equal(mod.ERROR_POLICY.llm_response_timeout.autoRepair, false);
  assert.equal(mod.sanitizeErrorClass('Bearer private-token'), 'sanitized_runtime_error');
});

test('active order task drops a stale root order pause reason', async () => {
  const value = await active();
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const state = JSON.parse(fs.readFileSync(value.paths.statePath, 'utf8'));
  state.order_pause_reason = 'unsafe_order_count';
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(value.task.status().order_pause_reason, undefined);
  value.setClock('2026-07-21T00:01:00Z');
  await value.task.tick();
  const persisted = JSON.parse(fs.readFileSync(value.paths.statePath, 'utf8'));
  assert.equal(persisted.order_pause_reason, undefined);
});

test('local file failure reports its exact class and queues one bounded repair', async () => {
  const repairs = []; const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    repairTaskSender: async (incident) => {
      repairs.push(incident);
      return { queued: true, task_id: 't_local_file_repair' };
    },
    execFile(command, args, options, callback) {
      callback(Object.assign(new Error('blocked'), { code: 2 }), good(
        args[args.indexOf('--task-id') + 1],
        'blocked',
        { error_class: 'local_file_io_failed' },
      ));
    },
  });
  const due = value.task.status().tasks[mod.TASKS[0].id].next_run_at;
  const state = await value.task.runOnce({ taskId: mod.TASKS[0].id, dueAt: new Date(due) });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[0].id].pause_reason, 'local_file_io_failed');
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].errorClass, 'local_file_io_failed');
  assert.match(sent[0].content, /원인: local_file_io_failed/);
  assert.equal(state.last_error_notification.retry, false);
});

test('LLM timeout degrades one order slot without a same-slot order invocation', async () => {
  let orderRuns = 0;
  const value = await active({
    llmExecutor: async () => { throw new Error('llm_response_timeout'); },
    execFile(command, args, options, callback) { orderRuns += 1; callback(null, orderGood()); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);
  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'transport_degraded_no_op');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.error_class, 'llm_response_timeout');
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.no_same_slot_retry, true);
  const nextDueAt = new Date('2026-07-21T00:20:00Z');
  value.setClock(nextDueAt);
  const nextState = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: nextDueAt });
  assert.equal(nextState.state, 'ACTIVE');
  assert.equal(nextState.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(nextState.tasks[mod.TASKS[4].id].consecutive_transport_failures, 0);
  assert.equal(orderRuns, 0);
});

test('missing intraday decision degrades one slot without pausing the order task', async () => {
  let orderRuns = 0;
  const value = await active({
    llmExecutor: async () => { throw new Error('intraday_decision_stale_or_missing'); },
    execFile(command, args, options, callback) { orderRuns += 1; callback(null, orderGood()); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.action_type, 'transport_degraded_no_op');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.error_class, 'intraday_decision_stale_or_missing');
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(orderRuns, 0);
});

test('missing held-position decision degrades one slot without invoking KIS orders', async () => {
  let orderRuns = 0;
  const slotId = `${mod.TASKS[4].id}:2026-07-21:09:10`;
  const held = JSON.parse(decisionContext(slotId, ['005930', '000660']));
  Object.assign(held.candidates[0], { role: 'held_position', review_tier: 'position' });
  held.holdings = [{ symbol: '005930', quantity: 2 }];
  held.risk_aggregate.open_positions = 1;
  const value = await active({
    decisionContextOutput: JSON.stringify(held),
    llmExecutor: async ({ packet }) => aiVerdict(packet),
    execFile(command, args, options, callback) { orderRuns += 1; callback(null, orderGood()); },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);

  const state = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });

  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.error_class, 'llm_position_decision_missing');
  assert.equal(state.tasks[mod.TASKS[4].id].last_run.no_same_slot_retry, true);
  assert.equal(state.tasks[mod.TASKS[4].id].pending_invocation, null);
  assert.equal(orderRuns, 0);
});

test('approved reconciliation incident runs once and reactivates orders only after safety clears', async () => {
  const sent = [];
  let recoveryCalls = 0;
  let orderRuns = 0;
  const value = await active({
    safetyOutput: safetyOutput(),
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(command, args, options, callback) {
      if (args.includes('safety-monitor')) {
        callback(null, safetyOutput());
        return;
      }
      if (args.includes('reconcile-paused')) {
        recoveryCalls += 1;
        callback(null, orderGood('success', {
          action_type: 'reconciliation_recovered', reconciliations: 1,
        }));
        return;
      }
      if (args.includes('vps-autonomous-order') && args.includes('run-once')) {
        orderRuns += 1;
        callback(Object.assign(new Error('blocked'), { code: 2 }), orderGood('blocked', {
          error_class: 'preflight_or_reconciliation_invalid',
        }));
        return;
      }
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const before = value.task.status();
  before.last_safety_monitor = JSON.parse(safetyOutput('blocked', {
    reconciliation_status: 'active', error_class: 'reconciliation_status_active',
  }));
  fs.writeFileSync(value.paths.statePath, JSON.stringify(before));
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);

  const paused = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });
  const incident = Object.values(paused.incidents)
    .find((entry) => entry.error_class === 'preflight_or_reconciliation_invalid');
  assert.ok(incident, JSON.stringify(Object.values(paused.incidents)));
  assert.equal(incident.scope, 'reconcile_paused_once');
  assert.equal(incident.status, 'awaiting_approval');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].components[0].components.length, 2);
  assert.match(sent[0].components[0].components[0].custom_id, /^kis-recovery:approve:[a-f0-9]{64}$/);

  value.setClock('2026-07-21T00:11:00Z');
  const held = await value.task.tick();
  assert.equal(held.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.equal(held.incidents[incident.incident_id].status, 'awaiting_approval');
  assert.equal(recoveryCalls, 0);

  const resolved = await value.task.approveIncident({
    incidentId: incident.incident_id,
    approval: `복구 승인 ${incident.incident_id}`,
    invokedBy: 'discord:test-user',
  });

  assert.equal(recoveryCalls, 1);
  assert.equal(orderRuns, 1, 'the blocked market slot is not retried');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.result.broker_order_api_calls, 0);
  assert.equal(resolved.result.order_reactivated, true);
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'ACTIVE');
  await assert.rejects(value.task.approveIncident({
    incidentId: incident.incident_id,
    approval: `복구 승인 ${incident.incident_id}`,
    invokedBy: 'discord:test-user',
  }), /incident_not_awaiting_approval/);
  assert.equal(recoveryCalls, 1);
});

test('order not fully filled uses the existing reconciliation recovery buttons', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(command, args, options, callback) {
      if (args.includes('run-once')) {
        callback({ code: 2 }, orderGood('blocked', { error_class: 'order_not_fully_filled' }));
        return;
      }
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);

  const paused = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });
  const incident = Object.values(paused.incidents)
    .find((entry) => entry.error_class === 'order_not_fully_filled');

  assert.equal(incident.scope, 'reconcile_paused_once');
  assert.equal(incident.status, 'awaiting_approval');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].components[0].components[0].label, '복구');
});

test('scheduler tick adds recovery buttons to an already-notified reconciliation pause', async () => {
  const sent = [];
  const value = await active({
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
  });
  markOrderActive(value);
  const state = value.task.status();
  const order = state.tasks[mod.TASKS[4].id];
  const completedAt = '2026-09-04T03:10:01.000Z';
  Object.assign(order, {
    state: 'PAUSED', pause_reason: 'order_not_fully_filled', next_run_at: null,
    last_due_at: '2026-09-04T03:10:00.000Z',
    last_run: { status: 'blocked', action_type: 'paused', error_class: 'order_not_fully_filled', completed_at: completedAt },
  });
  state.order_pause_reason = 'order_not_fully_filled';
  state.incidents = {};
  state.last_error_notification = {
    key: crypto.createHash('sha256').update([
      mod.TASKS[4].id, order.last_due_at, completedAt, 'order_not_fully_filled',
    ].join(':')).digest('hex'),
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock('2026-09-04T03:11:00.000Z');

  const repaired = await value.task.tick();
  const incident = Object.values(repaired.incidents)
    .find((entry) => entry.error_class === 'order_not_fully_filled');

  assert.equal(incident.scope, 'reconcile_paused_once');
  assert.equal(incident.status, 'awaiting_approval');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].components[0].components[0].label, '복구');
});

test('incident recovery stays paused when reconciliation attempts an order submission', async () => {
  const value = await active({
    reportSender: async () => ({ discord_sent: true }),
    execFile(command, args, options, callback) {
      if (args.includes('reconcile-paused')) {
        callback(null, orderGood('success', {
          action_type: 'reconciliation_recovered', reconciliations: 1,
          order_api_calls: 1, vps_live_orders: 1,
        }));
        return;
      }
      if (args.includes('vps-autonomous-order') && args.includes('run-once')) {
        callback(Object.assign(new Error('blocked'), { code: 2 }), orderGood('blocked', {
          error_class: 'preflight_or_reconciliation_invalid',
        }));
        return;
      }
      callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  const before = value.task.status();
  before.last_safety_monitor = JSON.parse(safetyOutput('blocked', {
    reconciliation_status: 'active', error_class: 'reconciliation_status_active',
  }));
  fs.writeFileSync(value.paths.statePath, JSON.stringify(before));
  const dueAt = new Date('2026-07-21T00:10:00Z');
  value.setClock(dueAt);
  const paused = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt });
  const incident = Object.values(paused.incidents)
    .find((entry) => entry.error_class === 'preflight_or_reconciliation_invalid');
  assert.ok(incident, JSON.stringify(Object.values(paused.incidents)));

  await assert.rejects(value.task.approveIncident({
    incidentId: incident.incident_id,
    approval: `복구 승인 ${incident.incident_id}`,
  }), /invalid_order_execution_contract|invalid_reconciliation_recovery_contract/);
  assert.equal(value.task.status().incidents[incident.incident_id].status, 'escalated');
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
});

async function pendingRecoveryFixture(options = {}) {
  let recoveryCalls = 0;
  let orderRuns = 0;
  const sent = [];
  const value = await active({
    ...options,
    reportSender: async (message) => { sent.push(message); return { discord_sent: true }; },
    execFile(command, args, execOptions, callback) {
      if (args.includes('reconcile-paused')) {
        recoveryCalls += 1;
        assert.ok(args.includes('--read-only-broker'));
        if (options.recoveryCallback) return options.recoveryCallback(callback, recoveryCalls);
        const reason = options.recoveryReason || 'reconciliation_order_unfilled';
        callback({ code: 2 }, orderGood('blocked', { error_class: reason }));
      } else if (args.includes('run-once')) {
        orderRuns += 1;
        callback({ code: 2 }, orderGood('blocked', { error_class: 'preflight_or_reconciliation_invalid' }));
      } else callback(null, good(args[args.indexOf('--task-id') + 1]));
    },
  });
  await value.task.enableOrderTask({ confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL });
  value.setClock('2026-07-21T00:10:00Z');
  const paused = await value.task.runOnce({ taskId: mod.TASKS[4].id, dueAt: new Date('2026-07-21T00:10:00Z') });
  const incident = Object.values(paused.incidents).find((entry) => entry.error_class === 'preflight_or_reconciliation_invalid');
  assert.ok(incident);
  return { ...value, sent, incident, calls: () => ({ recoveryCalls, orderRuns }), approve: () => value.task.approveIncident({
    incidentId: incident.incident_id, approval: `복구 승인 ${incident.incident_id}`, invokedBy: 'discord:operator',
  }) };
}

test('approved read-only recovery waits for later ticks and is bounded to three attempts', async () => {
  const value = await pendingRecoveryFixture();
  assert.equal((await value.approve()).status, 'waiting_recheck');
  assert.deepEqual(value.calls(), { recoveryCalls: 1, orderRuns: 1 });
  await value.task.tick();
  assert.equal(value.calls().recoveryCalls, 1);
  value.setClock('2026-07-21T00:11:00Z');
  await value.task.tick();
  assert.equal(value.calls().recoveryCalls, 2);
  value.setClock('2026-07-21T00:12:00Z');
  const state = await value.task.tick();
  assert.equal(state.incidents[value.incident.incident_id].status, 'escalated');
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  value.setClock('2026-07-21T00:13:00Z');
  await value.task.tick();
  assert.deepEqual(value.calls(), { recoveryCalls: 3, orderRuns: 1 });
  assert.equal(value.sent.filter((message) => message.content.includes('[KIS 복구]')).length, 1);
});

test('successful reconciliation is checkpointed before a transient safety failure', async () => {
  let safetyBlocked = false;
  const value = await pendingRecoveryFixture({
    safetyOutput: () => safetyBlocked ? safetyOutput('blocked', { error_class: 'timeout', open_order_status: 'unknown' }) : safetyOutput(),
    recoveryCallback(callback) {
      safetyBlocked = true;
      callback(null, orderGood('success', { action_type: 'reconciliation_recovered', reconciliations: 1 }));
    },
  });
  const waiting = await value.approve();
  assert.equal(waiting.status, 'waiting_recheck');
  assert.equal(waiting.reconciliation_verified, true);
  safetyBlocked = false;
  value.setClock('2026-07-21T00:11:00Z');
  const resumed = await value.task.tick();
  assert.equal(resumed.incidents[value.incident.incident_id].status, 'resolved');
  assert.equal(resumed.tasks[mod.TASKS[4].id].state, 'ACTIVE');
  assert.deepEqual(value.calls(), { recoveryCalls: 1, orderRuns: 1 });
  assert.equal(value.sent.filter((message) => message.content.includes('[KIS 복구]')).length, 1);
});

test('post-close checkpoint completion uses refresh-only activation without broker recovery', async () => {
  let safetyCalls = 0;
  let activationCheckOutput = orderGood('success', { action_type: 'activation_check' });
  const value = await pendingRecoveryFixture({
    safetyOutput: () => { safetyCalls += 1; return safetyOutput(); },
    activationCheckOutput: () => activationCheckOutput,
  });
  activationCheckOutput = orderGood('blocked', {
      action_type: 'paused', error_class: 'model_v3_prediction_batch_incomplete',
  });
  const checkpointed = value.task.status();
  checkpointed.incidents[value.incident.incident_id] = {
    ...checkpointed.incidents[value.incident.incident_id],
    status: 'escalated', attempts: 3, reconciliation_verified: true,
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(checkpointed));
  value.setClock('2026-07-21T07:06:00Z');

  const completed = await value.approve();

  assert.equal(completed.status, 'resolved');
  assert.equal(completed.attempts, 4);
  assert.equal(completed.completion_reapproval_used, true);
  assert.equal(value.calls().recoveryCalls, 0);
  assert.equal(safetyCalls, 2);
  const orderTask = value.task.status().tasks[mod.TASKS[4].id];
  assert.equal(orderTask.state, 'ACTIVE');
  assert.equal(orderTask.refresh_only_pending, true);
  assert.equal(orderTask.last_run.order_api_calls, 0);
});

test('verified checkpoint completion activates after 16:20 when the batch is ready', async () => {
  const value = await pendingRecoveryFixture();
  const checkpointed = value.task.status();
  checkpointed.incidents[value.incident.incident_id] = {
    ...checkpointed.incidents[value.incident.incident_id],
    status: 'escalated', attempts: 3, reconciliation_verified: true,
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(checkpointed));
  value.setClock('2026-07-21T07:25:00Z');

  const completed = await value.approve();

  assert.equal(completed.status, 'resolved');
  assert.equal(completed.attempts, 4);
  assert.equal(completed.completion_reapproval_used, true);
  assert.equal(value.calls().recoveryCalls, 0);
  const orderTask = value.task.status().tasks[mod.TASKS[4].id];
  assert.equal(orderTask.state, 'ACTIVE');
  assert.equal(orderTask.refresh_only_pending, false);
});

test('exhausted recovery completes when KIS reports no pending reconciliation and safety is clear', async () => {
  const value = await pendingRecoveryFixture({ recoveryReason: 'pending_reconciliation_not_found' });
  const state = value.task.status();
  state.incidents[value.incident.incident_id] = {
    ...state.incidents[value.incident.incident_id],
    status: 'escalated', attempts: 3, reconciliation_verified: false,
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));

  const completed = await value.approve();

  assert.equal(completed.status, 'resolved');
  assert.equal(completed.reconciliation_verified, true);
  assert.equal(completed.completion_reapproval_used, true);
  assert.deepEqual(value.calls(), { recoveryCalls: 1, orderRuns: 1 });
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'ACTIVE');
});

test('already-resolved recovery cannot reactivate orders after reported broker I/O', async () => {
  for (const unsafeCounts of [{ order_api_calls: 1 }, { vps_live_orders: 1 }]) {
    const value = await pendingRecoveryFixture({
      recoveryCallback(callback) {
        callback({ code: 2 }, orderGood('blocked', {
          error_class: 'pending_reconciliation_not_found', ...unsafeCounts,
        }));
      },
    });
    const state = value.task.status();
    state.incidents[value.incident.incident_id] = {
      ...state.incidents[value.incident.incident_id],
      status: 'escalated', attempts: 3, reconciliation_verified: false,
    };
    fs.writeFileSync(value.paths.statePath, JSON.stringify(state));

    await assert.rejects(value.approve(), /pending_reconciliation_not_found/);
    assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
  }
});

test('checkpoint completion rejects wrong incidents and unresolved broker evidence', async () => {
  const unverified = await pendingRecoveryFixture();
  const unverifiedState = unverified.task.status();
  unverifiedState.incidents[unverified.incident.incident_id] = {
    ...unverifiedState.incidents[unverified.incident.incident_id],
    status: 'escalated', attempts: 3, reconciliation_verified: false,
  };
  fs.writeFileSync(unverified.paths.statePath, JSON.stringify(unverifiedState));
  unverified.setClock('2026-07-21T07:06:00Z');
  await assert.rejects(unverified.approve(), /reconciliation_order_unfilled/);
  assert.deepEqual(unverified.calls(), { recoveryCalls: 1, orderRuns: 1 });

  const value = await pendingRecoveryFixture();
  const state = value.task.status();
  state.incidents[value.incident.incident_id] = {
    ...state.incidents[value.incident.incident_id],
    status: 'repairing', attempts: 3, reconciliation_verified: true,
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
  value.setClock('2026-07-21T07:06:00Z');
  await assert.rejects(value.task.enableOrderTask({
    confirm: true, approval: mod.ORDER_ACTIVATION_APPROVAL, invokedBy: 'incident:wrong',
  }), /incident_approval_required/);
  assert.deepEqual(value.calls(), { recoveryCalls: 0, orderRuns: 1 });
});

test('a fifth approval is denied after one checkpoint completion reapproval', async () => {
  let activationCheckOutput = orderGood('success', { action_type: 'activation_check' });
  const value = await pendingRecoveryFixture({
    activationCheckOutput: () => activationCheckOutput,
  });
  activationCheckOutput = orderGood('blocked', {
      action_type: 'paused', error_class: 'model_v3_prediction_batch_incomplete',
  });
  const checkpointed = value.task.status();
  checkpointed.incidents[value.incident.incident_id] = {
    ...checkpointed.incidents[value.incident.incident_id],
    status: 'escalated', attempts: 3, reconciliation_verified: true,
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(checkpointed));
  value.setClock('2026-07-21T07:06:00Z');
  await value.approve();

  await assert.rejects(value.approve(), /incident_not_awaiting_approval/);
  assert.deepEqual(value.calls(), { recoveryCalls: 0, orderRuns: 1 });
  const exhausted = value.task.status();
  exhausted.incidents[value.incident.incident_id] = {
    ...exhausted.incidents[value.incident.incident_id],
    status: 'escalated', completion_reapproval_used: false,
  };
  fs.writeFileSync(value.paths.statePath, JSON.stringify(exhausted));
  await assert.rejects(value.approve(), /incident_not_awaiting_approval/);
  assert.deepEqual(value.calls(), { recoveryCalls: 0, orderRuns: 1 });
});

test('unknown or inconsistent evidence never schedules an automatic recheck', async () => {
  for (const recoveryReason of ['reconciliation_evidence_invalid', 'reconciliation_quantity_mismatch', 'reconciliation_auth_failed']) {
    const value = await pendingRecoveryFixture({ recoveryReason });
    await assert.rejects(value.approve(), new RegExp(recoveryReason));
    value.setClock('2026-07-21T00:11:00Z');
    await value.task.tick();
    assert.deepEqual(value.calls(), { recoveryCalls: 1, orderRuns: 1 });
    assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
  }
});

test('recovery subprocess protocol failures are classified without retries or order resume', async () => {
  for (const { name, stdout, stderr, error, expected } of [
    {
      name: 'empty argparse usage', stdout: '', stderr: 'usage: reconcile-paused [-h]\n', error: { code: 2 },
      expected: 'reconciliation_cli_contract_invalid',
    },
    {
      name: 'empty output', stdout: '', stderr: 'worker stopped\n', error: { code: 2, signal: 'SIGTERM' },
      expected: 'reconciliation_output_missing',
    },
    {
      name: 'truncated JSON', stdout: '{broken', stderr: '', error: { code: 2, signal: 'unbounded' },
      expected: 'reconciliation_output_invalid',
    },
    {
      name: 'JSON with surrounding noise', stdout: `before\n${orderGood('success', { action_type: 'reconciliation_recovered', reconciliations: 1 })}\nafter`, stderr: '', error: { code: 2 },
      expected: 'reconciliation_output_invalid',
    },
    {
      name: 'whitespace-only output', stdout: ' \n\t ', stderr: '', error: { code: 2 },
      expected: 'reconciliation_output_invalid',
    },
  ]) {
    const value = await pendingRecoveryFixture({
      recoveryCallback(callback) { callback(error, stdout, stderr); },
    });
    await assert.rejects(value.approve(), new RegExp(expected), name);
    const incident = value.task.status().incidents[value.incident.incident_id];
    assert.equal(incident.status, 'escalated', name);
    assert.equal(incident.sanitized_error_class, expected, name);
    assert.deepEqual(incident.recovery_protocol, {
      exit_code: 2,
      signal: Object.hasOwn(os.constants.signals, error.signal) ? error.signal : null,
      stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
      stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
      stdout_empty: stdout.length === 0,
      stderr_usage: /(?:^|\n)usage:\s/im.test(stderr),
    }, name);
    for (const raw of [stdout, stderr]) if (raw) assert.equal(JSON.stringify(incident).includes(raw), false, name);
    value.setClock('2026-07-21T00:11:00Z');
    await value.task.tick();
    assert.deepEqual(value.calls(), { recoveryCalls: 1, orderRuns: 1 }, name);
    assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED', name);
  }
});

test('secret-like recovery stdout keeps the strict unsafe-output guard without protocol evidence', async () => {
  const stdout = '{"client_secret":"this-output-must-never-be-stored"}';
  const value = await pendingRecoveryFixture({
    recoveryCallback(callback) { callback({ code: 2 }, stdout, ''); },
  });
  await assert.rejects(value.approve(), /unsafe_order_output/);
  const incident = value.task.status().incidents[value.incident.incident_id];
  assert.equal(incident.sanitized_error_class, 'unsafe_order_output');
  assert.equal(incident.recovery_protocol, undefined);
  assert.equal(JSON.stringify(incident).includes(stdout), false);
  assert.deepEqual(value.calls(), { recoveryCalls: 1, orderRuns: 1 });
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
});

test('a new recovery approval clears stale protocol evidence before a non-protocol failure', async () => {
  let attempt = 0;
  const value = await pendingRecoveryFixture({
    recoveryCallback(callback) {
      attempt += 1;
      if (attempt === 1) callback({ code: 2 }, '', 'usage: reconcile-paused [-h]\n');
      else callback({ code: 2 }, orderGood('blocked', { error_class: 'reconciliation_auth_failed' }));
    },
  });
  await assert.rejects(value.approve(), /reconciliation_cli_contract_invalid/);
  assert.ok(value.task.status().incidents[value.incident.incident_id].recovery_protocol);
  await assert.rejects(value.approve(), /reconciliation_auth_failed/);
  assert.equal(value.task.status().incidents[value.incident.incident_id].recovery_protocol, undefined);
  assert.deepEqual(value.calls(), { recoveryCalls: 2, orderRuns: 1 });
});

test('actual child-process recovery boundary classifies empty argparse output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-recovery-child-'));
  const script = path.join(root, 'empty-recovery.js');
  fs.writeFileSync(script, "process.stderr.write('usage: reconcile-paused [-h]\\n'); process.exitCode = 2;");
  const value = await pendingRecoveryFixture({
    recoveryCallback(callback) { execFile(process.execPath, [script], callback); },
  });
  await assert.rejects(value.approve(), /reconciliation_cli_contract_invalid/);
  const incident = value.task.status().incidents[value.incident.incident_id];
  assert.deepEqual(incident.recovery_protocol, {
    exit_code: 2, signal: null, stdout_bytes: 0, stderr_bytes: 29, stdout_empty: true, stderr_usage: true,
  });
  assert.deepEqual(value.calls(), { recoveryCalls: 1, orderRuns: 1 });
  assert.equal(value.task.status().tasks[mod.TASKS[4].id].state, 'PAUSED');
});

test('reconciliation command uses the configured KIS worktree with fixed read-only approval', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-recovery-repo-'));
  const modulePath = path.join(__dirname, 'kis-ai-market-open-dry-run-task.js');
  const script = `const command = require(${JSON.stringify(modulePath)}).buildReconciliationRecoveryCommand(); process.stdout.write(JSON.stringify(command));`;
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], {
      env: { ...process.env, KIS_TRADING_LAB_REPO_DIR: repoDir },
    }, (error, value) => (error ? reject(error) : resolve(value)));
  });
  const command = JSON.parse(stdout);
  assert.equal(command.cwd, repoDir);
  assert.deepEqual(command.args, [
    '-m', 'kis_trading_lab', 'vps-autonomous-order', '--action', 'reconcile-paused',
    '--read-only-broker',
    '--confirm', '--approval', 'APPROVE_KIS_HERMES_VPS_RECONCILIATION_RECOVERY_V1',
  ]);
});

test('expired and changed approvals stop rechecking without executing recovery', async () => {
  for (const changed of [false, true]) {
    const value = await pendingRecoveryFixture();
    await value.approve();
    if (changed) {
      const state = value.task.status();
      state.tasks[mod.TASKS[4].id].pause_reason = 'order_submission_unknown';
      fs.writeFileSync(value.paths.statePath, JSON.stringify(state));
    }
    value.setClock(changed ? '2026-07-21T00:11:00Z' : '2026-07-21T00:21:00Z');
    const state = await value.task.tick();
    assert.equal(state.incidents[value.incident.incident_id].status, changed ? 'stale' : 'escalated');
    assert.equal(value.calls().recoveryCalls, 1);
  }
});

test('concurrent recovery clicks cannot execute twice and ticks wait for recovery', async () => {
  let finish;
  const value = await pendingRecoveryFixture({ recoveryCallback(callback) { finish = callback; } });
  const pending = value.approve();
  await assert.rejects(value.approve(), /incident_recovery_in_progress/);
  await value.task.tick();
  assert.equal(value.calls().recoveryCalls, 1);
  finish(null, orderGood('success', { action_type: 'reconciliation_recovered', reconciliations: 1 }));
  assert.equal((await pending).status, 'resolved');
});

test('denied incident prevents unattended order reactivation', async () => {
  const value = await pendingRecoveryFixture();
  value.task.denyIncident({ incidentId: value.incident.incident_id, denial: `복구 거절 ${value.incident.incident_id}` });
  value.setClock('2026-07-21T00:11:00Z');
  const state = await value.task.tick();
  assert.equal(state.tasks[mod.TASKS[4].id].state, 'PAUSED');
  assert.deepEqual(value.calls(), { recoveryCalls: 0, orderRuns: 1 });
});

test('checkpoint is restartable before safety begins and restart skips broker recovery', async () => {
  let recoveryFinished = false;
  let checkpoint;
  const value = await pendingRecoveryFixture({
    safetyOutput: () => {
      if (!recoveryFinished) return safetyOutput();
      checkpoint = JSON.parse(fs.readFileSync(value.paths.statePath, 'utf8')).incidents[value.incident.incident_id];
      return safetyOutput('blocked', { error_class: 'timeout', open_order_status: 'unknown' });
    },
    recoveryCallback(callback) {
      recoveryFinished = true;
      callback(null, orderGood('success', { action_type: 'reconciliation_recovered', reconciliations: 1 }));
    },
  });
  await value.approve();
  assert.equal(checkpoint.status, 'waiting_recheck');
  assert.equal(checkpoint.reconciliation_verified, true);
  assert.equal(checkpoint.attempts, 1);
  let repeatedRecovery = 0;
  const restarted = mod.createKisAiMarketOpenDryRunTask({
    ...value.paths,
    enforceSchedulerOwnership: false,
    now: () => new Date('2026-07-21T00:11:00Z'),
    runtimeContract: mod.REQUIRED_RUNTIME_CONTRACT,
    runtimeHealthCheck: async () => true,
    sourceParityCheck: () => true,
    calendarProofResolver: () => calendarProof(true),
    execFile(command, args, options, callback) {
      if (args.includes('reconcile-paused')) repeatedRecovery += 1;
      callback(null, args.includes('safety-monitor') ? safetyOutput()
        : orderGood('success', { action_type: 'activation_check' }));
    },
  });
  const state = await restarted.tick();
  assert.equal(state.incidents[value.incident.incident_id].status, 'resolved');
  assert.equal(state.incidents[value.incident.incident_id].attempts, 2);
  assert.equal(state.incidents[value.incident.incident_id].recheck_expires_at, checkpoint.recheck_expires_at);
  assert.equal(repeatedRecovery, 0);
});
