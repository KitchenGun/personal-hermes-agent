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

try {
  testIdempotencyFingerprintNormalizesTextAndUsesRoutingFields();
  testSwarmFingerprintIncludesWorkerPlan();
  testCapabilityPlanFingerprintIgnoresVolatilePlannerMetadata();
  testDuplicateReportDocumentsDryRunFingerprint();
  testDuplicateReportParsesReusedCreateResult();
  console.log('server idempotency tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}
