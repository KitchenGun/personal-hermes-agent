'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.CONTROL_SHARED_SECRET = 'test-secret';
process.env.SUPERVISOR_AUTO_START = '0';

const { __test } = require('./server');

test('KIS emergency stop requires a nonempty explicit operator allowlist', () => {
  assert.throws(
    () => __test.assertKisEmergencyStopOperator('1512691418605420634', new Set()),
    /allowlist is required/,
  );
  assert.throws(
    () => __test.assertKisEmergencyStopOperator('1512691418605420634', new Set(['2000000000000000000'])),
    /not allowed/,
  );
  assert.doesNotThrow(
    () => __test.assertKisEmergencyStopOperator(
      '1512691418605420634',
      new Set(['1512691418605420634']),
    ),
  );
});
