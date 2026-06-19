'use strict';

const TARGET_CHANNEL_ID = '1512691418605420634';
const ADAPTER_NAME = 'kis_report_delivery';
const DELIVERY_LAYER = 'discord_relay';
const MESSAGE_LIMIT = 1900;

const REQUIRED_FIELDS = new Set([
  'report_type',
  'project',
  'decision',
  'decision_reason',
  'candidate_count',
  'allowed_count',
  'risk_blocked_count',
  'data_blocked_count',
  'rule_blocked_count',
  'paper_entries_created_count',
  'paper_orders_created_count',
  'cron_status',
  'recommendation_output',
  'target_channel_id',
]);

const ALLOWED_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  'transport',
  'transport_target',
  'send_mode',
  'dedupe_key',
  'direct_discord_client_used',
  'direct_discord_send_status',
  'preferred_path',
  'discord_sent',
  'payload_text',
]);

const COUNT_FIELDS = [
  'candidate_count',
  'allowed_count',
  'risk_blocked_count',
  'data_blocked_count',
  'rule_blocked_count',
  'paper_entries_created_count',
  'paper_orders_created_count',
];

const SECRET_LIKE_RE = /(Bearer\s+[A-Za-z0-9._-]+|[A-Za-z0-9+/]{48,}={0,2}|webhook|client_secret|app_secret|access_token)/i;
const RAW_RESPONSE_RE = /raw_response|full_body|response_headers|request_headers|stck_prpr|output1|output2/i;
const ROW_VALUE_RE = /(?<!\d)\d{6}(?!\d)|theme_[a-z0-9_]+|account_no/i;
const NUMERIC_SCORE_RE = /\b(?:theme_score|stock_leadership_score|external_risk_score|entry_score)\b\s*[:=]\s*[-+]?\d/i;
const PNL_RE = /\b(?:pnl|p&l|profit|loss|return_pct|equity_curve)\b\s*[:=]\s*[-+]?\d/i;
const RECOMMENDATION_WORDS = ['buy', 'sell', 'hold', '\ub9e4\uc218', '\ub9e4\ub3c4', '\ucd94\ucc9c', '\uc218\uc775'];
const URL_RE = /https?:\/\//i;
const SAFE_TOKEN_RE = /^[a-z0-9_:. -]+$/i;

function cleanScalar(value, maxLength = 120) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function countValue(payload, field) {
  const value = Number(payload[field]);
  if (!Number.isInteger(value) || value < 0 || value > 999999) return null;
  return value;
}

function pushIssue(issues, code, field = '') {
  issues.push(field ? `${code}:${field}` : code);
}

function payloadText(payload) {
  return String(payload.payload_text || '');
}

function valueStrings(payload) {
  return Object.entries(payload)
    .filter(([key]) => key !== 'recommendation_output')
    .map(([key, value]) => `${key}=${String(value ?? '')}`)
    .join('\n');
}

function validateKisReportPayload(payload) {
  const issues = [];
  const checks = {
    payload_validated: false,
    secret_like_detected: false,
    row_value_detected: false,
    numeric_score_detected: false,
    pnl_detected: false,
    recommendation_output: false,
    raw_response_detected: false,
    unknown_sensitive_field: false,
  };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    pushIssue(issues, 'invalid_payload_type');
    return { ok: false, issues, checks };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      pushIssue(issues, 'missing_required_field', field);
    }
  }

  for (const field of Object.keys(payload)) {
    if (!ALLOWED_FIELDS.has(field)) {
      checks.unknown_sensitive_field = true;
      pushIssue(issues, 'unknown_field', field);
    }
  }

  if (payload.report_type !== 'daily_learning_report') pushIssue(issues, 'invalid_report_type');
  if (payload.project !== 'KIS Trading Lab') pushIssue(issues, 'invalid_project');
  if (String(payload.target_channel_id || '') !== TARGET_CHANNEL_ID) pushIssue(issues, 'invalid_target_channel_id');
  if (payload.recommendation_output !== false) {
    checks.recommendation_output = true;
    pushIssue(issues, 'recommendation_output_not_false');
  }
  if (String(payload.cron_status || '') !== 'blocked') pushIssue(issues, 'cron_status_not_blocked');

  for (const field of COUNT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && countValue(payload, field) === null) {
      pushIssue(issues, 'invalid_count', field);
    }
  }

  for (const field of ['decision', 'decision_reason', 'cron_status', 'send_mode', 'transport', 'transport_target']) {
    if (payload[field] !== undefined && !SAFE_TOKEN_RE.test(String(payload[field]))) {
      pushIssue(issues, 'unsafe_text_field', field);
    }
  }

  const text = `${payloadText(payload)}\n${valueStrings(payload)}`;
  checks.secret_like_detected = SECRET_LIKE_RE.test(text);
  checks.raw_response_detected = RAW_RESPONSE_RE.test(text);
  checks.row_value_detected = ROW_VALUE_RE.test(text);
  checks.numeric_score_detected = NUMERIC_SCORE_RE.test(text);
  checks.pnl_detected = PNL_RE.test(text);
  checks.recommendation_output = checks.recommendation_output || RECOMMENDATION_WORDS.some((word) => payloadText(payload).toLowerCase().includes(word));
  if (URL_RE.test(payloadText(payload))) pushIssue(issues, 'url_in_payload_text');

  for (const [flag, code] of [
    ['secret_like_detected', 'secret_like_detected'],
    ['raw_response_detected', 'raw_response_detected'],
    ['row_value_detected', 'row_value_detected'],
    ['numeric_score_detected', 'numeric_score_detected'],
    ['pnl_detected', 'pnl_detected'],
    ['recommendation_output', 'recommendation_output_detected'],
  ]) {
    if (checks[flag]) pushIssue(issues, code);
  }

  checks.payload_validated = issues.length === 0;
  return { ok: issues.length === 0, issues, checks };
}

function buildKisReportDiscordMessage(payload) {
  const validation = validateKisReportPayload(payload);
  if (!validation.ok) {
    const error = new Error('invalid KIS report payload');
    error.validation = validation;
    throw error;
  }

  const lines = [
    '[KIS Trading Lab] Daily Learning Report',
    '',
    `Decision: ${cleanScalar(payload.decision, 60)}`,
    `Reason: ${cleanScalar(payload.decision_reason, 80)}`,
    '',
    'Candidate summary:',
    `- total candidates: ${countValue(payload, 'candidate_count')}`,
    `- allowed candidates: ${countValue(payload, 'allowed_count')}`,
    `- risk blocked: ${countValue(payload, 'risk_blocked_count')}`,
    `- data blocked: ${countValue(payload, 'data_blocked_count')}`,
    `- rule blocked: ${countValue(payload, 'rule_blocked_count')}`,
    '',
    'Paper summary:',
    `- entries created: ${countValue(payload, 'paper_entries_created_count')}`,
    `- orders created: ${countValue(payload, 'paper_orders_created_count')}`,
    '',
    'Safety:',
    '- actual orders: none',
    '- raw/secret/row values: not shown',
    '- recommendation output: false',
    `- cron: ${cleanScalar(payload.cron_status, 40)}`,
    '',
    'Delivery:',
    `- target channel: ${TARGET_CHANNEL_ID}`,
    '- route: Hermes/Gateway -> Discord relay',
    '- actual send: pending separate approval',
  ];
  return lines.join('\n').slice(0, MESSAGE_LIMIT);
}

function incidentSummary(errorClass = 'none') {
  return {
    incident_type: 'hermes_kis_report_route_missing',
    severity: errorClass === 'none' ? 'ready' : 'blocked',
    source_component: 'hermes_gateway',
    protected_action: 'discord_report_delivery',
    retry_allowed: false,
    operator_action_required: true,
    recovery: 'add_small_adapter_then_separate_send_once_approval',
    secret_exposed: false,
    prod_db_touched: false,
    order_attempted: false,
    cron_changed: false,
    error_class: errorClass,
  };
}

function baseSummary(mode, validation, overrides = {}) {
  return {
    executed: true,
    adapter: ADAPTER_NAME,
    delivery_layer: DELIVERY_LAYER,
    send_mode: mode,
    payload_validated: validation.ok,
    message_built: false,
    discord_sent: false,
    send_attempt_count: 0,
    target_channel_id: TARGET_CHANNEL_ID,
    direct_discord_retry: false,
    service_restart: false,
    secret_like_detected: Boolean(validation.checks.secret_like_detected),
    row_value_detected: Boolean(validation.checks.row_value_detected),
    numeric_score_detected: Boolean(validation.checks.numeric_score_detected),
    recommendation_output: Boolean(validation.checks.recommendation_output),
    route_status: validation.ok ? 'adapter_ready_dry_run_only' : 'payload_rejected',
    retry_allowed: false,
    actual_send_pending_approval: validation.ok,
    status: validation.ok ? 'success' : 'blocked',
    error_class: validation.ok ? 'none' : 'payload_validation_failed',
    incident: incidentSummary(validation.ok ? 'none' : 'payload_validation_failed'),
    blocked_issues: validation.issues,
    ...overrides,
  };
}

function runKisReportDeliveryDryRun(payload) {
  const validation = validateKisReportPayload(payload);
  const summary = baseSummary('dry_run', validation);
  if (!validation.ok) return summary;
  buildKisReportDiscordMessage(payload);
  summary.message_built = true;
  return summary;
}

async function runKisReportDeliverySendOnce(payload, options = {}) {
  const validation = validateKisReportPayload(payload);
  const summary = baseSummary('send_once', validation, {
    status: validation.ok ? 'hold' : 'blocked',
    error_class: validation.ok ? 'actual_send_disabled' : 'payload_validation_failed',
  });
  if (!validation.ok) return summary;

  const message = buildKisReportDiscordMessage(payload);
  summary.message_built = true;

  const sender = options.sender;
  if (typeof sender !== 'function') {
    return summary;
  }

  summary.send_attempt_count = 1;
  try {
    const result = await sender({
      targetChannelId: TARGET_CHANNEL_ID,
      content: message,
      deliveryLayer: DELIVERY_LAYER,
    });
    summary.discord_sent = Boolean(result && result.discord_sent);
    summary.status = summary.discord_sent ? 'success' : 'fail';
    summary.error_class = summary.discord_sent ? 'none' : 'fake_sender_failed';
    summary.route_status = summary.discord_sent ? 'adapter_fake_send_verified' : 'adapter_fake_send_failed';
    summary.actual_send_pending_approval = !summary.discord_sent;
    summary.incident = incidentSummary(summary.error_class);
    return summary;
  } catch (error) {
    summary.discord_sent = false;
    summary.status = 'fail';
    summary.error_class = 'fake_sender_failed';
    summary.route_status = 'adapter_fake_send_failed';
    summary.actual_send_pending_approval = true;
    summary.incident = incidentSummary(summary.error_class);
    return summary;
  }
}

module.exports = {
  TARGET_CHANNEL_ID,
  validateKisReportPayload,
  buildKisReportDiscordMessage,
  runKisReportDeliveryDryRun,
  runKisReportDeliverySendOnce,
};
