const assert = require('node:assert/strict');

process.env.CONTROL_SHARED_SECRET = 'test-secret';
process.env.SUPERVISOR_AUTO_START = '0';
process.env.SUMMARY_CACHE_TTL_MS = '1000';
process.env.SUMMARY_CACHE_SWR_MS = '5000';
process.env.SUPERVISOR_IDLE_BACKOFF_MAX_MS = '60000';
process.env.SUPERVISOR_IDLE_BACKOFF_INITIAL_MS = '30000';

delete require.cache[require.resolve('./server')];
const dashboard = require('./server');

function state(board, total, counts = {}) {
  return {
    board,
    updatedAt: `2026-01-01T00:00:0${total}.000Z`,
    summary: {
      total,
      done: counts.done || 0,
      running: counts.running || 0,
      ready: counts.ready || 0,
      blocked: counts.blocked || 0,
    },
    tasks: [],
  };
}

async function testSummaryCacheUsesTtlAndInvalidates() {
  assert.equal(typeof dashboard.__test.loadCachedSummary, 'function');
  assert.equal(typeof dashboard.__test.invalidateSummaryCache, 'function');
  assert.equal(typeof dashboard.__test.setLoadBoardStateForTest, 'function');

  let calls = 0;
  let current = state('codex-control', 1);
  dashboard.__test.clearSummaryCache();
  dashboard.__test.setLoadBoardStateForTest(async (board) => {
    calls += 1;
    return { ...current, board };
  });

  const first = await dashboard.__test.loadCachedSummary('codex-control');
  current = state('codex-control', 2);
  const second = await dashboard.__test.loadCachedSummary('codex-control');
  assert.equal(first.summary.total, 1);
  assert.equal(second.summary.total, 1, 'fresh TTL hit should return the cached summary');
  assert.equal(calls, 1, 'fresh TTL hit should not reload board state');

  dashboard.__test.invalidateSummaryCache('codex-control');
  const third = await dashboard.__test.loadCachedSummary('codex-control');
  assert.equal(third.summary.total, 2, 'explicit invalidation should force a reload');
  assert.equal(calls, 2);
}

function testSupervisorIdleBackoffAndReset() {
  assert.equal(typeof dashboard.__test.updateSupervisorBackoff, 'function');
  assert.equal(typeof dashboard.__test.resetSupervisorBackoff, 'function');

  const supervisor = dashboard.__test.supervisor;
  supervisor.intervalMs = 5000;
  dashboard.__test.resetSupervisorBackoff();

  dashboard.__test.updateSupervisorBackoff(state('codex-control', 0));
  assert.equal(supervisor.currentIntervalMs, 30000);
  assert.equal(supervisor.idleBackoffStreak, 1);

  dashboard.__test.updateSupervisorBackoff(state('codex-control', 0));
  assert.equal(supervisor.currentIntervalMs, 60000);
  assert.equal(supervisor.idleBackoffStreak, 2);

  dashboard.__test.updateSupervisorBackoff(state('codex-control', 1, { ready: 1 }));
  assert.equal(supervisor.currentIntervalMs, 5000);
  assert.equal(supervisor.idleBackoffStreak, 0);
}

(async () => {
  await testSummaryCacheUsesTtlAndInvalidates();
  testSupervisorIdleBackoffAndReset();
  dashboard.__test.restoreLoadBoardState();
  console.log('server cache/backoff tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
