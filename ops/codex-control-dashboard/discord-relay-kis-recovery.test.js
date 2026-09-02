'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DISCORD_RELAY_TEST_MODE = '1';
process.env.DISCORD_ALLOWED_USER_IDS = '123456789012345678';
process.env.KIS_DISCORD_CHANNEL_ID = '1512691418605420634';
process.env.DISCORD_SHARED_SECRET = 'test-secret';

delete require.cache[require.resolve('./discord-relay')];
const relay = require('./discord-relay');

function response(body = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function interaction(overrides = {}) {
  const incidentId = 'a'.repeat(64);
  return {
    id: '123456789012345679',
    token: 'interaction-token',
    application_id: '123456789012345680',
    type: 3,
    channel_id: '1512691418605420634',
    member: { user: { id: '123456789012345678' } },
    data: { custom_id: `kis-recovery:approve:${incidentId}` },
    message: {
      id: '123456789012345681',
      components: [{ type: 1, components: [
        { type: 2, style: 3, label: '복구', custom_id: `kis-recovery:approve:${incidentId}` },
        { type: 2, style: 4, label: '중단 유지', custom_id: `kis-recovery:deny:${incidentId}` },
      ] }],
    },
    ...overrides,
  };
}

test('allowed recovery button sends one exact incident approval', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) {
      return response({ incident: { status: 'resolved', result: { order_reactivated: true } } });
    }
    return response({});
  };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction());
  } finally {
    global.fetch = originalFetch;
  }
  const approvals = calls.filter((call) => call.url.includes('/incidents/'));
  assert.equal(approvals.length, 1);
  const body = JSON.parse(approvals[0].options.body);
  assert.equal(body.command, `복구 승인 ${'a'.repeat(64)}`);
  assert.equal(body.interaction_id, '123456789012345679');
  assert.equal(body.channel_id, '1512691418605420634');
});

test('wrong channel is denied before the incident endpoint', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return response({}); };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction({ channel_id: '999999999999999999' }));
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls.some((url) => url.includes('/incidents/')), false);
});
