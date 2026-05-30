const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DISCORD_RELAY_TEST_MODE = '1';
process.env.DISCORD_RELAY_PRUNE_AFTER_MS = String(24 * 60 * 60 * 1000);
process.env.DISCORD_NOTIFY_INTERVAL_MS = '10000';
process.env.DISCORD_NOTIFY_IDLE_INTERVAL_MS = '60000';
process.env.DISCORD_NOTIFY_ERROR_INTERVAL_MS = '30000';

delete require.cache[require.resolve('./discord-relay')];
const relay = require('./discord-relay');

function iso(ms) {
  return new Date(ms).toISOString();
}

function testPrunesOnlyOldTerminalTasks() {
  assert.equal(typeof relay.__test.pruneRelayState, 'function');
  const now = Date.parse('2026-05-28T00:00:00.000Z');
  const state = {
    tasks: {
      oldDone: { lastStatus: 'done', lastNotifiedAt: iso(now - (3 * 24 * 60 * 60 * 1000)), channelId: 'c' },
      oldArchived: { lastStatus: 'archived', lastNotifiedAt: iso(now - (2 * 24 * 60 * 60 * 1000)), channelId: 'c' },
      recentDone: { lastStatus: 'done', lastNotifiedAt: iso(now - (60 * 60 * 1000)), channelId: 'c' },
      blocked: { lastStatus: 'blocked', lastNotifiedAt: iso(now - (10 * 24 * 60 * 60 * 1000)), channelId: 'c' },
      running: { lastStatus: 'running', lastNotifiedAt: iso(now - (10 * 24 * 60 * 60 * 1000)), channelId: 'c' },
      ready: { lastStatus: 'ready', lastNotifiedAt: iso(now - (10 * 24 * 60 * 60 * 1000)), channelId: 'c' },
    },
  };

  const result = relay.__test.pruneRelayState(state, { now, maxAgeMs: 24 * 60 * 60 * 1000 });

  assert.deepEqual(Object.keys(state.tasks).sort(), ['blocked', 'ready', 'recentDone', 'running'].sort());
  assert.equal(result.pruned, 2);
  assert.equal(result.before, 6);
  assert.equal(result.after, 4);
  assert.deepEqual(result.prunedTaskIds.sort(), ['oldArchived', 'oldDone'].sort());
  assert.match(result.reason, /done\/archived/);
}

function testSavePrunesBeforeAtomicWrite() {
  assert.equal(typeof relay.__test.saveRelayStateToFile, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-relay-prune-'));
  const file = path.join(dir, 'state.json');
  const now = Date.parse('2026-05-28T00:00:00.000Z');
  const logs = [];
  const state = {
    tasks: {
      oldDone: { lastStatus: 'done', lastNotifiedAt: iso(now - 1000), channelId: 'c' },
      running: { lastStatus: 'running', lastNotifiedAt: iso(now - 1000), channelId: 'c' },
    },
  };

  const result = relay.__test.saveRelayStateToFile(state, file, {
    now,
    maxAgeMs: 10,
    log: (message, detail) => logs.push(`${message} ${detail}`.trim()),
  });

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.tasks), ['running']);
  assert.equal(result.pruned, 1);
  assert.ok(!fs.existsSync(`${file}.tmp`), 'atomic temp file should be renamed away');
  assert.ok(logs.some((line) => line.includes('pruned relay state tasks') && line.includes('pruned=1')));
  assert.ok(logs.some((line) => line.includes('maxAgeMs=10')));
}

function testAdaptivePollingState() {
  assert.equal(typeof relay.__test.isActiveState, 'function');
  assert.equal(relay.__test.isActiveState({ summary: { running: 1 }, tasks: [] }, { tasks: {} }), true);
  assert.equal(relay.__test.isActiveState({ summary: { ready: 1 }, tasks: [] }, { tasks: {} }), true);
  assert.equal(relay.__test.isActiveState({ summary: { blocked: 1 }, tasks: [] }, { tasks: {} }), true);
  assert.equal(relay.__test.isActiveState({ summary: { running: 0, ready: 0, blocked: 0 }, tasks: [] }, { tasks: {} }), false);
  assert.equal(relay.__test.isActiveState({ summary: {} }, { tasks: { t1: { lastStatus: 'running' } } }), true);
  assert.equal(relay.__test.isActiveState({ summary: {} }, { tasks: { t1: { lastStatus: 'done' } } }), false);

  assert.equal(relay.__test.statusPollDelayMs({ status: 'active' }), relay.__test.intervals.active);
  assert.equal(relay.__test.statusPollDelayMs({ status: 'idle' }), relay.__test.intervals.idle);
  assert.equal(relay.__test.statusPollDelayMs({ status: 'error' }), relay.__test.intervals.error);
}

testPrunesOnlyOldTerminalTasks();
testSavePrunesBeforeAtomicWrite();
testAdaptivePollingState();
console.log('discord relay prune tests passed');
