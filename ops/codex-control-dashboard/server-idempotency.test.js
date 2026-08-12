const assert = require('node:assert/strict');

process.env.CONTROL_SHARED_SECRET = 'test-secret';
process.env.SUPERVISOR_AUTO_START = '0';

delete require.cache[require.resolve('./server')];
const dashboard = require('./server');

function buildSpec(overrides = {}) {
  return {
    title: '  Ship   Feature!!! ',
    body: 'Implement thing',
    assignee: 'coder',
    priority: 20,
    workspace: 'scratch',
    maxRuntime: '30m',
    maxRetries: 2,
    skills: ['test-driven-development'],
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    source: 'api',
    title: ' Ship feature ',
    detail: 'Line one.\n\n\nLine TWO!!!',
    ...overrides,
  };
}

function testIdempotencyFingerprintNormalizesTextAndUsesRoutingFields() {
  assert.equal(typeof dashboard.__test.idempotencyKey, 'function');
  assert.equal(typeof dashboard.__test.duplicateReport, 'function');

  const spec = buildSpec();
  const first = dashboard.__test.idempotencyKey(baseInput(), spec, 'codex-control');
  const normalizedEquivalent = dashboard.__test.idempotencyKey(
    baseInput({ detail: ' line ONE\nline two ', title: 'ship feature' }),
    buildSpec({ title: 'ship feature' }),
    'codex-control',
  );
  const differentAssignee = dashboard.__test.idempotencyKey(baseInput(), buildSpec({ assignee: 'reviewer' }), 'codex-control');
  const differentBoard = dashboard.__test.idempotencyKey(baseInput(), spec, 'other-board');

  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(first, normalizedEquivalent, 'case/punctuation/whitespace-only changes should not alter the fingerprint');
  assert.notEqual(first, differentAssignee, 'assignee must be part of the fingerprint');
  assert.notEqual(first, differentBoard, 'board must be part of the fingerprint');

  assert.equal(dashboard.__test.idempotencyKey({ discordInteractionId: 'abc 123' }, spec, 'codex-control'), 'discord:abc 123');
  assert.equal(dashboard.__test.idempotencyKey({ source: 'discord', sourceId: 'message-1' }, spec, 'codex-control'), 'discord:message-1');

  const longIdA = `same-prefix-${'x'.repeat(90)}a`;
  const longIdB = `same-prefix-${'x'.repeat(90)}b`;
  assert.notEqual(
    dashboard.__test.idempotencyKey({ source: 'discord', sourceId: longIdA }, spec, 'codex-control'),
    dashboard.__test.idempotencyKey({ source: 'discord', sourceId: longIdB }, spec, 'codex-control'),
    'long source IDs should be hash-suffixed instead of truncated into collisions',
  );
}

function testSwarmFingerprintIncludesWorkerPlan() {
  const input = baseInput();
  const swarmA = dashboard.__test.planFingerprintSpec({
    mode: 'swarm',
    spec: buildSpec({ assignee: 'swarm' }),
    swarm: { workers: [{ profile: 'coder', title: 'implement' }], verifier: 'reviewer', synthesizer: 'editor', goal: 'generated at 1' },
  });
  const swarmAWithVolatileGoal = dashboard.__test.planFingerprintSpec({
    mode: 'swarm',
    spec: buildSpec({ assignee: 'swarm' }),
    swarm: { workers: [{ profile: 'coder', title: 'implement' }], verifier: 'reviewer', synthesizer: 'editor', goal: 'generated at 2' },
  });
  const swarmB = dashboard.__test.planFingerprintSpec({
    mode: 'swarm',
    spec: buildSpec({ assignee: 'swarm' }),
    swarm: { workers: [{ profile: 'researcher', title: 'investigate' }], verifier: 'reviewer', synthesizer: 'editor' },
  });

  assert.equal(
    dashboard.__test.idempotencyKey(input, swarmA, 'codex-control'),
    dashboard.__test.idempotencyKey(input, swarmAWithVolatileGoal, 'codex-control'),
    'volatile swarm goal text should not destabilize the fingerprint',
  );
  assert.notEqual(
    dashboard.__test.idempotencyKey(input, swarmA, 'codex-control'),
    dashboard.__test.idempotencyKey(input, swarmB, 'codex-control'),
    'swarm worker/verifier/synthesizer plan should affect the fingerprint',
  );
}

function testCapabilityPlanFingerprintIgnoresVolatilePlannerMetadata() {
  const input = baseInput();
  const plan = {
    id: 'run-a',
    generatedAt: '2026-01-01T00:00:00.000Z',
    tags: ['Dashboard', 'code-change'],
    requestedAssignee: 'coder',
    currentAssignee: 'coder',
    recommendedAssignee: 'devops_fast',
    swarmRecommended: true,
    workers: [{ profile: 'coder', title: 'Implement' }],
    routingWeights: { selectedProfile: 'coder', sample: Math.random() },
    inventorySummary: { profiles: 10, skills: 20 },
  };
  const volatileEquivalent = {
    ...plan,
    id: 'run-b',
    generatedAt: '2026-01-01T00:00:05.000Z',
    routingWeights: { selectedProfile: 'coder', sample: Math.random() },
    inventorySummary: { profiles: 11, skills: 21 },
  };
  const differentWorkers = {
    ...volatileEquivalent,
    workers: [{ profile: 'researcher', title: 'Investigate' }],
  };

  assert.equal(
    dashboard.__test.idempotencyKey(input, buildSpec({ capabilityPlan: plan }), 'codex-control'),
    dashboard.__test.idempotencyKey(input, buildSpec({ capabilityPlan: volatileEquivalent }), 'codex-control'),
    'volatile capability planner id/timestamp/routing inventory should not alter duplicate fingerprints',
  );
  assert.notEqual(
    dashboard.__test.idempotencyKey(input, buildSpec({ capabilityPlan: plan }), 'codex-control'),
    dashboard.__test.idempotencyKey(input, buildSpec({ capabilityPlan: differentWorkers }), 'codex-control'),
    'stable capability worker routing should still affect duplicate fingerprints',
  );
}

function testDuplicateReportDocumentsDryRunFingerprint() {
  const spec = buildSpec();
  const report = dashboard.__test.duplicateReport(baseInput(), spec, 'codex-control', { dryRun: true, mode: 'task' });

  assert.deepEqual(report, {
    possible_duplicate: true,
    duplicate_reused: false,
    idempotency_key: dashboard.__test.idempotencyKey(baseInput(), spec, 'codex-control'),
    fingerprint: dashboard.__test.idempotencyKey(baseInput(), spec, 'codex-control'),
    mode: 'task',
    dry_run: true,
    reason: 'idempotency-key-preview',
    source: 'api',
    key_components: {
      source: 'api',
      board: 'codex-control',
      assignee: 'coder',
      priority: 20,
      title: 'ship feature',
      detail: 'line one line two',
      capability_plan: '',
      workers: '',
    },
  });
}

function testDuplicateReportParsesReusedCreateResult() {
  const report = dashboard.__test.duplicateReport(baseInput(), buildSpec(), 'codex-control', {
    mode: 'task',
    task: { id: 't_1234', duplicate_reused: true },
  });
  assert.equal(report.duplicate_reused, true);
  assert.equal(report.reused_task_id, 't_1234');
  assert.equal(report.reason, 'idempotency-key-reused');
}

function testKisSelfHealTaskIsIsolatedAndStopsAtPrReview() {
  const key = 'a'.repeat(64);
  const args = dashboard.__test.buildKisSelfHealTaskCreateArgs({
    notificationKey: key,
    taskId: 'kis-ai-intraday-shadow-validation-v1',
    errorClass: 'sanitized_runtime_error',
    repairOwner: 'hermes',
  });
  const body = args[args.indexOf('--body') + 1];
  assert.equal(args[args.indexOf('--workspace') + 1], 'worktree:/home/ubuntu/work/personal-hermes-agent');
  assert.equal(args[args.indexOf('--max-retries') + 1], '1');
  assert.equal(args[args.indexOf('--idempotency-key') + 1], `kis-self-heal:${key}`);
  assert.match(body, /Ponytail skill in full mode/);
  assert.match(body, /open a PR for operator review/);
  assert.match(body, /Never merge or deploy/);
  assert.doesNotMatch(body, /merge and deploy only related runtime files/);

  const processArgs = dashboard.__test.buildKisSelfHealTaskCreateArgs({
    notificationKey: 'b'.repeat(64),
    taskId: 'kis-ai-post-close-learning-v1',
    errorClass: 'process_error',
    repairOwner: 'kis',
    failurePhase: 'child_process',
    failureExceptionType: 'RuntimeError',
    failureExitCode: 1,
    failureSignal: 'none',
    failureFingerprint: 'c'.repeat(64),
  });
  const processBody = processArgs[processArgs.indexOf('--body') + 1];
  assert.equal(
    processArgs[processArgs.indexOf('--workspace') + 1],
    'worktree:/home/ubuntu/.hermes/jobs/repos/kis-trading-lab',
  );
  assert.match(processBody, /Repair owner: kis-trading-lab/);
  assert.match(processBody, /Failure exception: RuntimeError/);
  assert.match(processBody, /runtime_source_uncommitted/);
  assert.doesNotMatch(processBody, /bounded failure detail/);

  assert.throws(
    () => dashboard.__test.buildKisSelfHealTaskCreateArgs({
      notificationKey: 'bad', taskId: 'kis-task', errorClass: 'process_error',
      repairOwner: 'kis',
    }),
    /invalid_kis_self_heal_incident/,
  );
  assert.throws(
    () => dashboard.__test.buildKisSelfHealTaskCreateArgs({
      notificationKey: 'd'.repeat(64),
      taskId: 'kis-ai-post-close-learning-v1',
      errorClass: 'process_error',
      repairOwner: 'kis',
      failurePhase: 'child_process',
      failureExceptionType: 'RuntimeError',
      failureFingerprint: 'not-a-fingerprint',
    }),
    /invalid_kis_self_heal_incident/,
  );
  assert.doesNotThrow(() => dashboard.__test.assertKisSelfHealSourceClean('kis', () => ''));
  assert.throws(
    () => dashboard.__test.assertKisSelfHealSourceClean('kis', () => ' M kis_trading_lab/runtime.py'),
    /runtime_source_uncommitted/,
  );
  let sourceCheckCalls = 0;
  assert.throws(
    () => dashboard.__test.assertKisSelfHealSourceClean('kis', () => {
      sourceCheckCalls += 1;
      return sourceCheckCalls === 2 ? 'kis_trading_lab/untracked_runtime.py' : '';
    }),
    /runtime_source_uncommitted/,
  );
  const gitCalls = [];
  dashboard.__test.prepareKisSelfHealBranch('kis', 'codex/kis-self-heal-test', (root, gitArgs) => {
    gitCalls.push({ root, gitArgs });
    if (gitArgs[0] === 'rev-parse' && gitArgs[1].startsWith('refs/heads/')) throw new Error('missing');
    if (gitArgs[0] === 'rev-parse') return 'e'.repeat(40);
    return '';
  });
  assert.deepEqual(gitCalls.at(-1), {
    root: '/home/ubuntu/.hermes/jobs/repos/kis-trading-lab',
    gitArgs: ['branch', 'codex/kis-self-heal-test', 'origin/master'],
  });
}

try {
  testIdempotencyFingerprintNormalizesTextAndUsesRoutingFields();
  testSwarmFingerprintIncludesWorkerPlan();
  testCapabilityPlanFingerprintIgnoresVolatilePlannerMetadata();
  testDuplicateReportDocumentsDryRunFingerprint();
  testDuplicateReportParsesReusedCreateResult();
  testKisSelfHealTaskIsIsolatedAndStopsAtPrReview();
  console.log('server idempotency tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
