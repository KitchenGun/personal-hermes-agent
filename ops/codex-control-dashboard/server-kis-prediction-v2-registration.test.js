'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('server keeps legacy prediction schedulers dormant', () => {
  assert.match(serverSource, /require\('\.\/kis-prediction-v2-validation-task'\)/);
  assert.doesNotMatch(serverSource, /kisPredictionV2TaskRuntime\.start\(\)/);
  assert.doesNotMatch(serverSource, /kisPredictionTaskRuntime\.start\(\)/);
  assert.match(serverSource, /schedulerRegistered: false/);
  assert.match(serverSource, /serverRegistered: false/);
  assert.match(serverSource, /kisPredictionV2TaskRuntime\.enforceDormantOwnership\(\)/);
});

test('Model v2 API keeps legacy scheduler paused before manual execution', () => {
  assert.match(serverSource, /\/api\/kis\/prediction-v2-validation\/status/);
  assert.match(serverSource, /\/api\/kis\/prediction-v2-validation\/activate/);
  assert.match(serverSource, /kisPredictionV2TaskRuntime\.activate/);
  assert.match(serverSource, /\/api\/kis\/prediction-v2-validation\/run-once/);
  assert.match(serverSource, /legacyState !== 'PAUSED'/);
  assert.match(serverSource, /kisPredictionV2TaskRuntime\.runOnce/);
  assert.match(serverSource, /Model v2 prediction scheduler is active/);
  assert.match(serverSource, /readDormantAdaptiveTaskState/);
  assert.match(serverSource, /Adaptive KIS scheduler is not explicitly dormant/);
});

test('AI market-open dry-run registers an in-process status-only scheduler', () => {
  assert.match(serverSource, /require\('\.\/kis-ai-market-open-dry-run-task'\)/);
  assert.match(serverSource, /schedulerRegistered: true/);
  assert.match(serverSource, /serverRegistered: true/);
  assert.match(serverSource, /\/api\/kis\/ai-market-open-dry-run\/status/);
  assert.match(serverSource, /kisAiMarketOpenDryRunRuntime\.start\(\)/);
  assert.doesNotMatch(serverSource, /ai-market-open-dry-run\/activate/);
});
