'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('server registers only the Model v2 prediction scheduler loop', () => {
  assert.match(serverSource, /require\('\.\/kis-prediction-v2-validation-task'\)/);
  assert.match(serverSource, /kisPredictionV2TaskRuntime\.start\(\)/);
  assert.doesNotMatch(serverSource, /kisPredictionTaskRuntime\.start\(\)/);
});

test('Model v2 API keeps legacy scheduler paused before manual execution', () => {
  assert.match(serverSource, /\/api\/kis\/prediction-v2-validation\/status/);
  assert.match(serverSource, /\/api\/kis\/prediction-v2-validation\/activate/);
  assert.match(serverSource, /kisPredictionV2TaskRuntime\.activate/);
  assert.match(serverSource, /\/api\/kis\/prediction-v2-validation\/run-once/);
  assert.match(serverSource, /legacyState !== 'PAUSED'/);
  assert.match(serverSource, /kisPredictionV2TaskRuntime\.runOnce/);
  assert.match(serverSource, /Model v2 prediction scheduler is active/);
});
