const assert = require('node:assert/strict');

const adapter = require('./kis-report-delivery-adapter');

function validPayload(overrides = {}) {
  return {
    report_type: 'daily_learning_report',
    project: 'KIS Trading Lab',
    decision: 'no_entry',
    decision_reason: 'risk_blocked',
    candidate_count: 3,
    allowed_count: 0,
    risk_blocked_count: 3,
    data_blocked_count: 0,
    rule_blocked_count: 0,
    paper_entries_created_count: 0,
    paper_orders_created_count: 0,
    cron_status: 'blocked',
    recommendation_output: false,
    target_channel_id: adapter.TARGET_CHANNEL_ID,
    payload_text: 'sanitized report ready; raw values are omitted',
    ...overrides,
  };
}

function assertNoSensitiveSummary(summary) {
  const text = JSON.stringify(summary);
  assert.equal(text.includes('synthetic-secret-value'), false);
  assert.equal(text.includes('webhook.example'), false);
  assert.equal(text.includes('raw_response_body'), false);
}

function testValidPayloadValidationPasses() {
  const result = adapter.validateKisReportPayload(validPayload());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.checks.payload_validated, true);
}

function testMissingRequiredFieldRejects() {
  const payload = validPayload();
  delete payload.decision;
  const result = adapter.validateKisReportPayload(payload);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('missing_required_field:decision'));
}

function testUnknownRowLikeFieldRejects() {
  const result = adapter.validateKisReportPayload(validPayload({ price: 'redacted' }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('unknown_field:price'));
}

function testNumericScoreAndPnlReject() {
  const score = adapter.validateKisReportPayload(validPayload({ payload_text: 'theme_score=1' }));
  assert.equal(score.ok, false);
  assert.equal(score.checks.numeric_score_detected, true);

  const pnl = adapter.validateKisReportPayload(validPayload({ payload_text: 'pnl=1' }));
  assert.equal(pnl.ok, false);
  assert.equal(pnl.checks.pnl_detected, true);
}

function testSecretLikePayloadRejectsWithoutEcho() {
  const summary = adapter.runKisReportDeliveryDryRun(validPayload({
    payload_text: 'Bearer synthetic-secret-value',
  }));
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.secret_like_detected, true);
  assertNoSensitiveSummary(summary);
}

function testRecommendationWordingRejects() {
  const summary = adapter.runKisReportDeliveryDryRun(validPayload({
    payload_text: 'buy candidate now',
  }));
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.recommendation_output, true);
}

function testDryRunDoesNotCallSender() {
  let calls = 0;
  const summary = adapter.runKisReportDeliveryDryRun(validPayload());
  assert.equal(calls, 0);
  assert.equal(summary.discord_sent, false);
  assert.equal(summary.send_attempt_count, 0);
  assert.equal(summary.message_built, true);
}

async function testFakeSendOnceCallsSenderExactlyOnce() {
  let calls = 0;
  let routedChannel = '';
  const summary = await adapter.runKisReportDeliverySendOnce(validPayload(), {
    sender: async (message) => {
      calls += 1;
      routedChannel = message.targetChannelId;
      assert.equal(message.deliveryLayer, 'discord_relay');
      assert.match(message.content, /KIS Trading Lab/);
      return { discord_sent: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(routedChannel, adapter.TARGET_CHANNEL_ID);
  assert.equal(summary.discord_sent, true);
  assert.equal(summary.send_attempt_count, 1);
  assert.equal(summary.route_status, 'adapter_discord_send_verified');
}

async function testSendFailureDoesNotRetry() {
  let calls = 0;
  const summary = await adapter.runKisReportDeliverySendOnce(validPayload(), {
    sender: async () => {
      calls += 1;
      throw new Error('synthetic failure');
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.discord_sent, false);
  assert.equal(summary.send_attempt_count, 1);
  assert.equal(summary.status, 'fail');
  assert.equal(summary.retry_allowed, false);
}

function testChannelRoutingPreserved() {
  const summary = adapter.runKisReportDeliveryDryRun(validPayload());
  assert.equal(summary.target_channel_id, adapter.TARGET_CHANNEL_ID);
  const message = adapter.buildKisReportDiscordMessage(validPayload());
  assert.match(message, new RegExp(adapter.TARGET_CHANNEL_ID));
}

function testIncidentAndStatusSummaryGenerated() {
  const summary = adapter.runKisReportDeliveryDryRun(validPayload());
  assert.equal(summary.adapter, 'kis_report_delivery');
  assert.equal(summary.delivery_layer, 'discord_relay');
  assert.equal(summary.route_status, 'adapter_ready_dry_run_only');
  assert.equal(summary.actual_send_pending_approval, true);
  assert.equal(summary.incident.protected_action, 'discord_report_delivery');
  assert.equal(summary.incident.retry_allowed, false);
  assert.equal(summary.service_restart, false);
  assert.equal(summary.direct_discord_retry, false);
}

function testNoSenderLeavesRuntimeSendDisabled() {
  return adapter.runKisReportDeliverySendOnce(validPayload()).then((summary) => {
    assert.equal(summary.discord_sent, false);
    assert.equal(summary.send_attempt_count, 0);
    assert.equal(summary.status, 'hold');
    assert.equal(summary.error_class, 'actual_send_disabled');
  });
}

async function run() {
  testValidPayloadValidationPasses();
  testMissingRequiredFieldRejects();
  testUnknownRowLikeFieldRejects();
  testNumericScoreAndPnlReject();
  testSecretLikePayloadRejectsWithoutEcho();
  testRecommendationWordingRejects();
  testDryRunDoesNotCallSender();
  await testFakeSendOnceCallsSenderExactlyOnce();
  await testSendFailureDoesNotRetry();
  testChannelRoutingPreserved();
  testIncidentAndStatusSummaryGenerated();
  await testNoSenderLeavesRuntimeSendDisabled();
  console.log('KIS report delivery adapter tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
