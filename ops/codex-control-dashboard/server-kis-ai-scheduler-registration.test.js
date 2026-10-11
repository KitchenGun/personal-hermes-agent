'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

process.env.CONTROL_SHARED_SECRET = 'test-secret';
process.env.SUPERVISOR_AUTO_START = '0';

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('AI market-open dry-run registers an in-process status-only scheduler', () => {
  assert.match(serverSource, /require\('\.\/kis-ai-market-open-dry-run-task'\)/);
  assert.match(serverSource, /schedulerRegistered: true/);
  assert.match(serverSource, /serverRegistered: true/);
  assert.match(serverSource, /\/api\/kis\/ai-market-open-dry-run\/status/);
  assert.match(serverSource, /kisAiMarketOpenDryRunRuntime\.start\(\)/);
  assert.doesNotMatch(serverSource, /ai-market-open-dry-run\/activate/);
});

test('AI scheduler is registered without a KIS self-heal repair task sender', () => {
  assert.doesNotMatch(serverSource, /repairTaskSender/);
  assert.doesNotMatch(serverSource, /SelfHeal|self-heal|self_heal/);
  assert.doesNotMatch(serverSource, /runtime_source_uncommitted/);
  assert.doesNotMatch(serverSource, /execFileSync/);
});

test('server no longer wires the retired v1/v2 prediction validation tasks', () => {
  assert.doesNotMatch(serverSource, /kis-prediction-(?:v2-)?validation-task/);
  assert.doesNotMatch(serverSource, /\/api\/kis\/prediction-(?:v2-)?validation/);
  assert.doesNotMatch(serverSource, /kisPrediction(?:V2)?(?:Validation)?Task/);
  assert.doesNotMatch(serverSource, /enforceDormantOwnership/);
  assert.doesNotMatch(serverSource, /readDormantAdaptiveTaskState/);
  assert.doesNotMatch(serverSource, /sendKisPredictionProgressViaDiscordRelay/);
  assert.equal(fs.existsSync(path.join(__dirname, 'kis-prediction-validation-task.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'kis-prediction-v2-validation-task.js')), false);
});

test('retired prediction validation routes return 404 even with the control secret', async (t) => {
  const { server } = require('./server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const request = (method, pathname) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { 'x-control-secret': 'test-secret', 'content-type': 'application/json' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
  for (const [method, pathname] of [
    ['GET', '/api/kis/prediction-validation/status'],
    ['POST', '/api/kis/prediction-validation/run-once'],
    ['GET', '/api/kis/prediction-v2-validation/status'],
    ['POST', '/api/kis/prediction-v2-validation/activate'],
    ['POST', '/api/kis/prediction-v2-validation/run-once'],
  ]) {
    assert.equal(await request(method, pathname), 404, `${method} ${pathname}`);
  }
});
