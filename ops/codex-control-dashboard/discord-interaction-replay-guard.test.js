'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDiscordInteractionReplayGuard } = require('./discord-interaction-replay-guard');

test('accepts fresh timestamps and rejects stale or malformed timestamps', () => {
  const guard = createDiscordInteractionReplayGuard({
    statePath: path.join(os.tmpdir(), 'unused-discord-replay.json'),
    now: () => new Date('2026-07-27T00:05:00.000Z'),
  });
  assert.equal(guard.isFresh('1785110700'), true);
  assert.equal(guard.isFresh('1785100000'), false);
  assert.equal(guard.isFresh('invalid'), false);
});

test('persists a claim and rejects a replay across guard instances', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-replay-'));
  const statePath = path.join(directory, 'claims.json');
  const options = { statePath, now: () => new Date('2026-07-27T00:05:00.000Z') };
  assert.equal(createDiscordInteractionReplayGuard(options).claim('1512691418605420634'), true);
  assert.equal(createDiscordInteractionReplayGuard(options).claim('1512691418605420634'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  }
});

test('fails closed for malformed ids and corrupt state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-replay-'));
  const statePath = path.join(directory, 'claims.json');
  fs.writeFileSync(statePath, '{broken', 'utf8');
  const guard = createDiscordInteractionReplayGuard({ statePath });
  assert.equal(guard.claim('bad'), false);
  assert.equal(guard.claim('1512691418605420634'), false);
});
