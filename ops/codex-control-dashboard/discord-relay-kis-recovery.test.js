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

function followupContent(calls) {
  const followup = calls.find((call) => call.url.includes('/webhooks/'));
  return JSON.parse(followup.options.body).content;
}

function recoveryButtonPatch(calls) {
  const patch = calls.find((call) => call.url.includes('/messages/') && call.options.method === 'PATCH');
  return JSON.parse(patch.options.body).components;
}

function statusSnapshot(status = 'resolved', taskState = 'ACTIVE', reason = null, state = 'ACTIVE') {
  return {
    state,
    incidents: { ['a'.repeat(64)]: { status, task_id: 'order-task', result: { order_reactivated: true } } },
    tasks: { 'order-task': { state: taskState, pause_reason: reason } },
  };
}

function recoveryRequests(calls) {
  return calls.filter((call) => call.url.includes('/api/kis/ai-market-open-dry-run/'));
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
  assert.match(followupContent(calls), /복구 및 정상 재개 완료/);
});

test('unavailable incident status does not claim a current pause or resend recovery', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) return response({ error: 'incident_not_awaiting_approval' }, 409);
    return response({});
  };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction());
  } finally {
    global.fetch = originalFetch;
  }
  const content = followupContent(calls);
  assert.match(content, /오류 코드: incident_not_awaiting_approval/);
  assert.match(content, /주문 재전송 없음/);
  assert.match(content, /현재 상태를 확인하지 못했습니다/);
  assert.doesNotMatch(content, /중단 상태를 유지|정상 재개 완료/);
  assert.deepEqual(recoveryRequests(calls).map((call) => call.options.method), ['POST', 'GET']);
});

for (const action of ['approve', 'deny']) test(`old ${action} button reads an automatically resolved incident without repeating recovery`, async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) return response({ error: 'incident_not_awaiting_approval' }, 409);
    if (String(url).endsWith('/status')) return response(statusSnapshot());
    return response({});
  };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction({ data: { custom_id: `kis-recovery:${action}:${'a'.repeat(64)}` } }));
  } finally { global.fetch = originalFetch; }
  assert.match(followupContent(calls), /이미 해결되었습니다/);
  assert.match(followupContent(calls), /현재 대상 작업: ACTIVE/);
  assert.match(followupContent(calls), /현재 운영: ACTIVE/);
  assert.match(followupContent(calls), /복구 재실행 없음/);
  assert.doesNotMatch(followupContent(calls), /처리 실패|중단 유지|정상 재개 완료/);
  assert.deepEqual(recoveryRequests(calls).map((call) => call.options.method), ['POST', 'GET']);
  const read = recoveryRequests(calls)[1];
  assert.equal(read.url, 'http://127.0.0.1:17640/api/kis/ai-market-open-dry-run/status');
  assert.equal(read.options.headers.authorization, 'Bearer test-secret');
  assert.ok(read.options.signal instanceof AbortSignal);
  assert.equal(recoveryButtonPatch(calls)[0].components.every((button) => button.disabled), true);
});

test('resolved incident uses the current pause, not its historical successful recovery result', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) return response({ error: 'incident_not_awaiting_approval' }, 409);
    if (String(url).endsWith('/status')) return response(statusSnapshot('resolved', 'PAUSED', 'order_submission_unknown', 'PAUSED'));
    return response({});
  };
  try { await relay.__test.handleKisRecoveryInteraction(interaction()); }
  finally { global.fetch = originalFetch; }
  assert.match(followupContent(calls), /현재 대상 작업: PAUSED/);
  assert.match(followupContent(calls), /현재 운영: PAUSED/);
  assert.match(followupContent(calls), /현재 원인: order_submission_unknown/);
  assert.doesNotMatch(followupContent(calls), /정상 재개 완료|현재 대상 작업: ACTIVE/);
});

test('a second click during recovery shows in-progress status without a second execution', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) return response({ error: 'incident_recovery_in_progress' }, 409);
    if (String(url).endsWith('/status')) return response(statusSnapshot('waiting_recheck', 'PAUSED'));
    return response({});
  };
  try { await relay.__test.handleKisRecoveryInteraction(interaction()); }
  finally { global.fetch = originalFetch; }
  assert.match(followupContent(calls), /안전 재확인 중/);
  assert.doesNotMatch(followupContent(calls), /복구 검증 완료|정상 재개 완료/);
  assert.deepEqual(recoveryRequests(calls).map((call) => call.options.method), ['POST', 'GET']);
});

test('malformed or secret-like current status is not echoed', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) return response({ error: 'incident_not_awaiting_approval' }, 409);
    if (String(url).endsWith('/status')) return response(statusSnapshot('resolved', 'Bearer private-token', 'Bearer private-token'));
    return response({});
  };
  try { await relay.__test.handleKisRecoveryInteraction(interaction()); }
  finally { global.fetch = originalFetch; }
  assert.match(followupContent(calls), /현재 대상 작업: UNKNOWN/);
  assert.match(followupContent(calls), /sanitized_runtime_error/);
  assert.doesNotMatch(followupContent(calls), /Bearer|private-token|정상 재개 완료/);
});

test('interaction replay rejection does not perform a recovery status fallback', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return String(url).includes('/incidents/')
      ? response({ error: 'discord_interaction_already_handled' }, 409) : response({});
  };
  try { await relay.__test.handleKisRecoveryInteraction(interaction()); }
  finally { global.fetch = originalFetch; }
  assert.equal(recoveryRequests(calls).length, 1);
});

test('secret-like recovery error is masked', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) return response({ error: 'Bearer private-token' }, 500);
    return response({});
  };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction());
  } finally {
    global.fetch = originalFetch;
  }
  const content = followupContent(calls);
  assert.match(content, /오류 코드: sanitized_runtime_error/);
  assert.doesNotMatch(content, /private-token|Bearer/);
});

test('safe exception reports its exact error class without resending orders', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) throw new Error('network_unavailable');
    return response({});
  };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction());
  } finally {
    global.fetch = originalFetch;
  }
  const content = followupContent(calls);
  assert.match(content, /오류 코드: network_unavailable/);
  assert.match(content, /주문 재전송 없음/);
  assert.equal(calls.filter((call) => call.url.includes('/incidents/')).length, 1);
});

test('waiting recheck acknowledges approval and disables consumed buttons', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) {
      return response({ incident: { status: 'waiting_recheck', result: { order_reactivated: false } } });
    }
    return response({});
  };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction());
  } finally {
    global.fetch = originalFetch;
  }
  assert.match(followupContent(calls), /승인 접수, 체결\/잔고 자동 재확인 중/);
  assert.equal(recoveryButtonPatch(calls)[0].components.every((button) => button.disabled === true), true);
});

test('denial keeps the pause and disables consumed buttons', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/incidents/')) return response({ incident: { status: 'denied', result: {} } });
    return response({});
  };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction({
      data: { custom_id: `kis-recovery:deny:${'a'.repeat(64)}` },
    }));
  } finally {
    global.fetch = originalFetch;
  }
  assert.match(followupContent(calls), /중단 유지/);
  assert.equal(recoveryButtonPatch(calls)[0].components.every((button) => button.disabled === true), true);
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

test('wrong operator cannot read recovery status or execute recovery', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return response({}); };
  try {
    await relay.__test.handleKisRecoveryInteraction(interaction({ member: { user: { id: '999999999999999999' } } }));
  } finally { global.fetch = originalFetch; }
  assert.equal(recoveryRequests(calls).length, 0);
});
