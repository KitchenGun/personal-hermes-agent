const fs = require('node:fs');
const path = require('node:path');
const { sanitizeErrorClass } = require('./kis-ai-market-open-dry-run-task');

const API = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ENDPOINT = process.env.DISCORD_RELAY_ENDPOINT || 'http://127.0.0.1:17640/api/discord/task';
const RESUME_ENDPOINT = process.env.DISCORD_RESUME_ENDPOINT || 'http://127.0.0.1:17640/api/discord/resume';
const STATE_ENDPOINT = process.env.DISCORD_STATE_ENDPOINT || 'http://127.0.0.1:17640/api/summary?board=codex-control';
const KIS_INCIDENT_ENDPOINT = process.env.DISCORD_KIS_INCIDENT_ENDPOINT
  || 'http://127.0.0.1:17640/api/kis/ai-market-open-dry-run/incidents';
const STATE_FILE = process.env.DISCORD_RELAY_STATE || path.join(__dirname, 'discord-relay-state.json');
const SECRET = process.env.DISCORD_SHARED_SECRET || '';
const STATE_SECRET = process.env.CONTROL_SHARED_SECRET || SECRET;
const CHANNEL_IDS = csvSet(process.env.DISCORD_CHANNEL_IDS || '');
const USER_IDS = csvSet(process.env.DISCORD_ALLOWED_USER_IDS || '');
const GATEWAY_QUEUE_CHANNEL_IDS = csvSet(process.env.DISCORD_GATEWAY_QUEUE_CHANNEL_IDS || '');
const KIS_CHANNEL_ID = String(process.env.KIS_DISCORD_CHANNEL_ID || '1512691418605420634').trim();
const MAX_ATTACHMENT_BYTES = Number(process.env.DISCORD_MAX_ATTACHMENT_BYTES || 262144);
const DISCORD_FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.DISCORD_FETCH_TIMEOUT_MS || 15000) || 15000);
const STATE_FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.DISCORD_STATE_FETCH_TIMEOUT_MS || 10000) || 10000);
const NOTIFY_ACTIVE_INTERVAL_MS = Math.max(1000, Number(process.env.DISCORD_NOTIFY_INTERVAL_MS || 10000) || 10000);
const NOTIFY_IDLE_INTERVAL_MS = Math.max(NOTIFY_ACTIVE_INTERVAL_MS, Number(process.env.DISCORD_NOTIFY_IDLE_INTERVAL_MS || 60000) || 60000);
const NOTIFY_ERROR_INTERVAL_MS = Math.max(5000, Number(process.env.DISCORD_NOTIFY_ERROR_INTERVAL_MS || 30000) || 30000);
const RELAY_STATE_PRUNE_AFTER_MS = Number(process.env.DISCORD_RELAY_PRUNE_AFTER_MS || 3 * 24 * 60 * 60 * 1000);
const NOTIFY_STATUSES = new Set(['running', 'blocked', 'review', 'done']);
const ACTIVE_POLL_STATUSES = new Set(['queued', 'todo', 'triage', 'scheduled', 'ready', 'running', 'review', 'blocked']);
const PRUNE_STATUSES = new Set(['done', 'archived']);
const QUEUE_ONLY = process.env.DISCORD_QUEUE_ONLY !== '0';
const QUEUE_NOTICE_COOLDOWN_MS = Number(process.env.DISCORD_QUEUE_NOTICE_COOLDOWN_MS || 60000);
const QUEUE_PREFIX_RE = /^\s*(?:\[queue\]|\[codex\]|queue:|codex:|task:|codex-task:)\s*/i;
const RESUME_PREFIX_RE = /^\s*(?:\[resume\]|resume:|unblock:)\s*/i;
const SLASH_COMMAND_NAMES = new Set(['queue', 'codex', 'task']);
const TEST_MODE = process.env.DISCORD_RELAY_TEST_MODE === '1';
const IS_MAIN = require.main === module;
const HANDLE_INTERACTIONS = process.env.DISCORD_RELAY_HANDLE_INTERACTIONS !== '0';
const RELAY_IGNORED_SLASH_COMMANDS = csvSet(process.env.DISCORD_RELAY_IGNORED_SLASH_COMMANDS || 'queue');

let socket = null;
let heartbeat = null;
let notifyTimer = null;
let notifyBusy = false;
let sequence = null;
let botUserId = '';
let relayState = loadRelayState();
const queueNoticeAt = new Map();

if (IS_MAIN && !TEST_MODE && !TOKEN) {
  console.error('DISCORD_BOT_TOKEN is required.');
  process.exit(1);
}

if (IS_MAIN && !TEST_MODE && !SECRET) {
  console.error('DISCORD_SHARED_SECRET is required.');
  process.exit(1);
}

if (IS_MAIN && !TEST_MODE && !STATE_SECRET) {
  console.error('CONTROL_SHARED_SECRET or DISCORD_SHARED_SECRET is required for status polling.');
  process.exit(1);
}

function csvSet(value) {
  return new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean));
}

function log(message, detail = '') {
  console.log(`[${new Date().toISOString()}] ${message}${detail ? ` ${detail}` : ''}`);
}

function loadRelayState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { tasks: {} };
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function terminalTaskTimestamp(entry) {
  return Math.max(
    timestampMs(entry.lastNotifiedAt),
    timestampMs(entry.completedAt),
    timestampMs(entry.archivedAt),
    timestampMs(entry.updatedAt),
    timestampMs(entry.createdAt),
  );
}

function pruneRelayState(state, options = {}) {
  const tasks = state.tasks || {};
  const now = Number(options.now || Date.now());
  const maxAgeMs = Number(options.maxAgeMs ?? RELAY_STATE_PRUNE_AFTER_MS);
  const before = Object.keys(tasks).length;
  const prunedTaskIds = [];
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return {
      before,
      after: before,
      pruned: 0,
      prunedTaskIds,
      maxAgeMs,
      reason: 'pruning disabled',
    };
  }
  for (const [taskId, entry] of Object.entries(tasks)) {
    const status = String(entry.lastStatus || entry.status || '').toLowerCase();
    if (!PRUNE_STATUSES.has(status)) continue;
    const terminalAt = terminalTaskTimestamp(entry);
    if (!terminalAt || now - terminalAt <= maxAgeMs) continue;
    delete tasks[taskId];
    prunedTaskIds.push(taskId);
  }
  return {
    before,
    after: Object.keys(tasks).length,
    pruned: prunedTaskIds.length,
    prunedTaskIds,
    maxAgeMs,
    reason: `done/archived older than ${maxAgeMs}ms`,
  };
}

function saveRelayStateToFile(state, filePath, options = {}) {
  const pruneResult = pruneRelayState(state, options);
  if (pruneResult.pruned) {
    const logger = options.log || log;
    logger(
      'pruned relay state tasks',
      `pruned=${pruneResult.pruned} before=${pruneResult.before} after=${pruneResult.after} maxAgeMs=${pruneResult.maxAgeMs} statuses=done,archived`,
    );
  }
  if (!pruneResult.pruned && options.writeWhenUnchanged === false) return pruneResult;
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, filePath);
  return pruneResult;
}

function saveRelayState() {
  return saveRelayStateToFile(relayState, STATE_FILE);
}

function truncate(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DISCORD_FETCH_TIMEOUT_MS) {
  const ms = Number(timeoutMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`fetch timed out after ${ms}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function discordFetch(path, options = {}) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bot ${TOKEN}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  }, DISCORD_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Discord API ${path} failed: ${response.status}`);
  }
  return response.json();
}

function recoveryComponents(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.type !== 1
    || !Array.isArray(value[0].components) || value[0].components.length !== 2) {
    throw new Error('invalid recovery components');
  }
  const buttons = value[0].components;
  const ids = buttons.map((button) => String(button?.custom_id || ''));
  const parsed = ids.map((id) => id.match(/^(kis-recovery|kis-order-review):(approve|confirm|deny):([a-f0-9]{64})$/));
  if (parsed.some((match) => !match) || parsed[0][3] !== parsed[1][3] || parsed[0][1] !== parsed[1][1]
    || parsed[0][2] !== (parsed[0][1] === 'kis-recovery' ? 'approve' : 'confirm') || parsed[1][2] !== 'deny') {
    throw new Error('invalid recovery components');
  }
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: parsed[0][1] === 'kis-recovery' ? '복구' : '주문안 확인', emoji: { name: '✅' }, custom_id: ids[0] },
      { type: 2, style: 4, label: parsed[0][1] === 'kis-recovery' ? '중단 유지' : '거절', emoji: { name: '✖️' }, custom_id: ids[1] },
    ],
  }];
}

async function sendDiscordMessage(channelId, content, referenceMessageId = '', components) {
  const payload = {
    content: truncate(content, 1900),
    allowed_mentions: { parse: [] },
    ...(components ? { components: recoveryComponents(components) } : {}),
  };
  if (referenceMessageId) {
    payload.message_reference = {
      channel_id: channelId,
      message_id: referenceMessageId,
      fail_if_not_exists: false,
    };
  }
  return discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function sendDiscordRelayMessage(message = {}) {
  const targetChannelId = String(message.targetChannelId || '').trim();
  if (!targetChannelId) throw new Error('target channel id is required');
  if (!TOKEN) throw new Error('DISCORD_BOT_TOKEN is required');
  const claim = claimDeliveryKey(message.idempotencyKey);
  if (claim.duplicate) {
    return {
      discord_sent: true,
      duplicate_suppressed: true,
      target_channel_id: targetChannelId,
      delivery_layer: message.deliveryLayer || 'discord_relay',
    };
  }
  const sent = await sendDiscordMessage(targetChannelId, message.content, '', message.components);
  return {
    discord_sent: true,
    message_id: sent?.id || null,
    target_channel_id: targetChannelId,
    delivery_layer: message.deliveryLayer || 'discord_relay',
  };
}

function claimDeliveryKey(idempotencyKey, stateFile = STATE_FILE) {
  const value = String(idempotencyKey || '').trim();
  if (!value) return { claimed: false, duplicate: false };
  const digest = require('node:crypto').createHash('sha256').update(value).digest('hex');
  const directory = `${stateFile}.delivery-claims`;
  const claimPath = path.join(directory, `${digest}.json`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(claimPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ key_hash: digest, claimed_at: new Date().toISOString() })}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return { claimed: true, duplicate: false, keyHash: digest };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error.code === 'EEXIST') return { claimed: false, duplicate: true, keyHash: digest };
    throw error;
  }
}

function send(op, d = null) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ op, d }));
  }
}

function identify() {
  send(2, {
    token: TOKEN,
    intents: 1 | 512 | 4096 | 32768,
    properties: {
      os: 'windows',
      browser: 'codex-discord-relay',
      device: 'codex-discord-relay',
    },
  });
}

function shouldHandle(message) {
  if (!message || message.author?.bot) return false;
  if (isDiscordCommandGeneratedMessage(message)) return false;
  if (USER_IDS.size && !USER_IDS.has(message.author?.id)) return false;
  const content = String(message.content || '');
  const queuePrefixed = QUEUE_PREFIX_RE.test(content);
  const attachmentOnly = !content.trim() && hasTextAttachment(message);
  if (GATEWAY_QUEUE_CHANNEL_IDS.has(message.channel_id)) return queuePrefixed || attachmentOnly;
  if (CHANNEL_IDS.size && !CHANNEL_IDS.has(message.channel_id)) return false;
  if (QUEUE_ONLY) {
    if (mentionsBot(message)) return false;
    if (queuePrefixed) return true;
    return attachmentOnly;
  }
  if (CHANNEL_IDS.size) return true;
  return mentionsBot(message);
}

function shouldHandleResume(message) {
  if (!message || message.author?.bot) return false;
  if (isDiscordCommandGeneratedMessage(message)) return false;
  if (GATEWAY_QUEUE_CHANNEL_IDS.has(message.channel_id)) return false;
  if (USER_IDS.size && !USER_IDS.has(message.author?.id)) return false;
  if (CHANNEL_IDS.size && !CHANNEL_IDS.has(message.channel_id)) return false;
  return RESUME_PREFIX_RE.test(String(message.content || ''));
}

function mentionsBot(message) {
  return message.mentions?.some((user) => user.id === botUserId)
    || String(message.content || '').includes(`<@${botUserId}>`)
    || String(message.content || '').includes(`<@!${botUserId}>`);
}

function removeMention(content) {
  return String(content || '')
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(QUEUE_PREFIX_RE, '')
    .trim();
}

function parseTask(content, attachmentText) {
  const text = removeMention(content);
  const titleMatch = text.match(/(?:^|\n)\s*(?:제목|title)\s*[:：]?\s*(.+)/i);
  const detailMatch = text.match(/(?:^|\n)\s*(?:세부내용|상세지시|detail|body)\s*[:：]?\s*([\s\S]+)/i);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const title = titleMatch?.[1]?.trim() || lines[0] || 'Discord task';
  const detail = [
    detailMatch?.[1]?.trim() || lines.slice(1).join('\n') || title,
    attachmentText,
  ].filter(Boolean).join('\n\n');
  return { title, detail };
}

function parseTaskForQueue(content, attachmentText) {
  const attachmentBody = String(attachmentText || '').replace(/(?:^|\n)Attachment: [^\n]+\n/g, '\n');
  const text = [removeMention(content), attachmentBody].filter(Boolean).join('\n\n').trim();
  const titleMatch = text.match(/(?:^|\n)\s*(?:제목|title)\s*[:：]?\s*(.+)/i);
  const detailMatch = text.match(/(?:^|\n)\s*(?:세부내용|상세지시|detail|body)\s*[:：]?\s*([\s\S]+)/i);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !QUEUE_PREFIX_RE.test(line));
  const title = titleMatch?.[1]?.trim() || lines[0] || 'Discord task';
  const detail = detailMatch?.[1]?.trim() || lines.slice(1).join('\n') || title;
  return { title, detail };
}

function parseResume(content) {
  const text = String(content || '').replace(RESUME_PREFIX_RE, '').trim();
  const taskId = text.match(/\btask\s*[:=]\s*(t_[A-Za-z0-9_-]+)/i)?.[1]
    || text.match(/\b(t_[A-Za-z0-9_-]+)\b/)?.[1]
    || '';
  return { taskId, content: text };
}

function isTextAttachment(attachment) {
  const name = String(attachment.filename || '').toLowerCase();
  const type = String(attachment.content_type || '').toLowerCase();
  return type.startsWith('text/')
    || name.endsWith('.txt')
    || name.endsWith('.md')
    || name.endsWith('.markdown');
}

function hasTextAttachment(message) {
  return (message.attachments || []).some(isTextAttachment);
}

function isDiscordCommandGeneratedMessage(message) {
  return Boolean(
    message?.interaction
      || message?.interaction_metadata
      || message?.application_id
      || Number(message?.type || 0) === 20
  );
}

async function readAttachments(message) {
  const chunks = [];
  for (const attachment of message.attachments || []) {
    if (!isTextAttachment(attachment)) continue;
    if (Number(attachment.size || 0) > MAX_ATTACHMENT_BYTES) {
      chunks.push(`[Attachment skipped: ${attachment.filename} exceeds ${MAX_ATTACHMENT_BYTES} bytes]`);
      continue;
    }
    const response = await fetchWithTimeout(attachment.url, {}, DISCORD_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      chunks.push(`[Attachment read failed: ${attachment.filename}]`);
      continue;
    }
    chunks.push(`Attachment: ${attachment.filename}\n${await response.text()}`);
  }
  return chunks.join('\n\n');
}

function interactionUser(interaction) {
  return interaction?.member?.user || interaction?.user || {};
}

function interactionOption(options, names) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  for (const option of options || []) {
    if (wanted.has(String(option.name || '').toLowerCase())) return option.value;
    const nested = interactionOption(option.options || [], names);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function splitInteractionContent(content) {
  const text = String(content || '').trim();
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    title: lines[0] || '',
    detail: lines.slice(1).join('\n') || lines[0] || text,
  };
}

async function interactionCallback(interaction, payload) {
  const response = await fetchWithTimeout(`${API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, DISCORD_FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error(`interaction callback failed: ${response.status}`);
}

async function interactionFollowup(interaction, content) {
  const response = await fetchWithTimeout(`${API}/webhooks/${interaction.application_id}/${interaction.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: truncate(content, 1900),
      flags: 64,
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) throw new Error(`interaction followup failed: ${response.status}`);
}

function interactionCommandName(interaction) {
  return String(interaction?.data?.name || '').toLowerCase();
}

function queueAckLines(created, title, taskId) {
  const workerIds = created.swarmCreated?.worker_ids || [];
  return [
    `[대기열 등록] ${created.spec?.title || title}`,
    `작업 ID: ${taskId || '-'}`,
    `보드: ${created.board || 'codex-control'}`,
    `모드: ${created.mode || 'task'}`,
    `담당: ${created.spec?.assignee || '-'}`,
    ...(workerIds.length ? [`병렬 worker: ${workerIds.join(', ')}`] : []),
  ];
}

function relayTaskIds(created, taskId) {
  const swarm = created.swarmCreated || {};
  const ids = [];
  if (created.mode === 'swarm') {
    for (const id of swarm.worker_ids || []) ids.push(id);
    if (swarm.verifier_id) ids.push(swarm.verifier_id);
    if (swarm.synthesizer_id) ids.push(swarm.synthesizer_id);
  }
  if (!ids.length && taskId) ids.push(taskId);
  return [...new Set(ids.filter(Boolean))];
}

function registerRelayTasks(created, taskId, baseEntry) {
  const rootId = created.swarmCreated?.root_id || taskId || '';
  for (const id of relayTaskIds(created, taskId)) {
    relayState.tasks[id] = {
      ...baseEntry,
      taskId: id,
      parentTaskId: created.mode === 'swarm' && rootId && id !== rootId ? rootId : baseEntry.parentTaskId,
      relation: created.mode === 'swarm' && rootId && id !== rootId ? 'swarm' : baseEntry.relation,
      lastStatus: 'queued',
      lastProgress: 0,
      createdAt: new Date().toISOString(),
    };
  }
}

function isSlashQueueChannel(channelId) {
  if (GATEWAY_QUEUE_CHANNEL_IDS.size) return GATEWAY_QUEUE_CHANNEL_IDS.has(channelId);
  if (CHANNEL_IDS.size) return CHANNEL_IDS.has(channelId);
  return true;
}

function shouldHandleInteraction(interaction) {
  const user = interactionUser(interaction);
  if (!SLASH_COMMAND_NAMES.has(interactionCommandName(interaction))) return false;
  if (!isSlashQueueChannel(interaction.channel_id)) return false;
  if (USER_IDS.size && !USER_IDS.has(user.id)) return false;
  return true;
}

async function readInteractionAttachments(interaction) {
  const attachments = Object.values(interaction?.data?.resolved?.attachments || {});
  return readAttachments({ attachments });
}

async function createTaskFromInteraction(interaction) {
  const options = interaction?.data?.options || [];
  const content = interactionOption(options, ['content', 'prompt', 'message']);
  const split = splitInteractionContent(content);
  const title = interactionOption(options, ['title', '제목']) || split.title;
  const detail = interactionOption(options, ['detail', 'body', 'description', '세부내용']) || split.detail;
  const attachmentText = await readInteractionAttachments(interaction);
  if (!title || !detail) {
    throw new Error('title/detail 옵션이 필요합니다. slash command 대신 일반 메시지 [queue] 형식을 사용해도 됩니다.');
  }

  const user = interactionUser(interaction);
  const response = await fetchWithTimeout(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify({
      title,
      detail: [detail, attachmentText].filter(Boolean).join('\n\n'),
      content: [title, detail].filter(Boolean).join('\n'),
      userId: user.id,
      username: user.username,
      messageId: interaction.id,
      discordInteractionId: interaction.id,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
      board: interactionOption(options, ['board']) || 'codex-control',
      priority: interactionOption(options, ['priority', '우선순위']),
      assignee: interactionOption(options, ['assignee', 'profile', '담당']),
      orchestrate: false,
    }),
  }, STATE_FETCH_TIMEOUT_MS);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Task API failed: ${response.status} ${body}`);
  }

  const created = JSON.parse(body);
  const taskId = created.task?.id || created.task?.task_id || created.id;
  if (taskId) {
    registerRelayTasks(created, taskId, {
      board: created.board || 'codex-control',
      title: created.spec?.title || title,
      channelId: interaction.channel_id,
      messageId: '',
      interactionId: interaction.id,
      userId: user.id || '',
      username: user.username || '',
    });
    saveRelayState();
  }
  return { created, taskId, title };
}

function parseKisRecoveryCustomId(value) {
  const match = String(value || '').match(/^kis-recovery:(approve|deny):([a-f0-9]{64})$/);
  return match ? { action: match[1], incidentId: match[2] } : null;
}

function kisRecoveryErrorClass(payload, error) {
  return sanitizeErrorClass(payload?.error_class || payload?.sanitized_error_class || payload?.error
    || error?.message || 'kis_recovery_blocked');
}

async function disableKisRecoveryButtons(interaction) {
  const components = (interaction?.message?.components || []).map((row) => ({
    type: 1,
    components: (row.components || []).map((button) => ({
      type: 2,
      style: button.style,
      label: button.label,
      emoji: button.emoji,
      custom_id: button.custom_id,
      disabled: true,
    })),
  }));
  if (!components.length || !interaction?.message?.id) return;
  await discordFetch(`/channels/${interaction.channel_id}/messages/${interaction.message.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ components }),
  });
}

async function handleKisRecoveryInteraction(interaction) {
  const parsed = parseKisRecoveryCustomId(interaction?.data?.custom_id);
  const user = interactionUser(interaction);
  const allowed = parsed && KIS_CHANNEL_ID && interaction?.channel_id === KIS_CHANNEL_ID
    && USER_IDS.size > 0 && USER_IDS.has(user.id);
  if (!allowed) {
    await interactionCallback(interaction, {
      type: 4,
      data: { flags: 64, content: '이 복구 작업을 실행할 권한이 없습니다.', allowed_mentions: { parse: [] } },
    });
    return;
  }
  await interactionCallback(interaction, { type: 5, data: { flags: 64 } });
  const command = `복구 ${parsed.action === 'approve' ? '승인' : '거절'} ${parsed.incidentId}`;
  let payload;
  try {
    const response = await fetchWithTimeout(`${KIS_INCIDENT_ENDPOINT}/${parsed.incidentId}/${parsed.action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
      },
      body: JSON.stringify({
        user_id: user.id,
        channel_id: interaction.channel_id,
        interaction_id: interaction.id,
        command,
      }),
    }, STATE_FETCH_TIMEOUT_MS);
    payload = await response.json();
    if (!response.ok || !payload?.incident) throw new Error(kisRecoveryErrorClass(payload));
    const incident = payload.incident;
    await disableKisRecoveryButtons(interaction).catch(() => {});
    const status = parsed.action === 'approve'
      ? (incident.status === 'waiting_recheck' && incident.result?.order_reactivated === false
        ? '승인 접수, 체결/잔고 자동 재확인 중'
        : incident.result?.order_reactivated === true ? '복구 및 정상 재개 완료' : '복구 검증 완료')
      : '중단 유지';
    await interactionFollowup(interaction, `[KIS 복구] ${status}`);
  } catch (error) {
    const errorClass = kisRecoveryErrorClass(payload, error);
    await interactionFollowup(
      interaction,
      `[KIS 복구] 복구 요청 처리 실패\n오류 코드: ${errorClass}\n중단 상태를 유지하고 원인을 확인하세요.\n주문 재전송 없음`,
    ).catch(() => {});
  }
}

async function handleKisOrderReviewInteraction(interaction) {
  const parsed = String(interaction?.data?.custom_id || '').match(/^kis-order-review:(confirm|deny):([a-f0-9]{64})$/);
  const user = interactionUser(interaction);
  if (!parsed || interaction.channel_id !== KIS_CHANNEL_ID || !USER_IDS.has(user.id)) {
    await interactionCallback(interaction, { type: 4, data: {
      flags: 64, content: '이 주문안을 확인할 권한이 없습니다.', allowed_mentions: { parse: [] },
    } });
    return;
  }
  await interactionCallback(interaction, { type: 5, data: { flags: 64 } });
  let rejection = null;
  try {
    const endpoint = KIS_INCIDENT_ENDPOINT.replace(/\/incidents\/?$/, '/order-reviews');
    const response = await fetchWithTimeout(`${endpoint}/${parsed[2]}/${parsed[1]}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}) },
      body: JSON.stringify({ user_id: user.id, channel_id: interaction.channel_id,
        interaction_id: interaction.id, message_id: interaction.message?.id }),
    }, STATE_FETCH_TIMEOUT_MS);
    const payload = await response.json();
    const expected = parsed[1] === 'confirm' ? 'confirmed' : 'denied';
    if (!response.ok) {
      const errorClass = sanitizeErrorClass(payload?.error_class || payload?.error || 'order_review_rejected');
      if (response.status >= 400 && response.status < 500) rejection = errorClass;
      throw new Error(errorClass);
    }
    if (payload?.review?.id !== parsed[2] || payload.review.status !== expected
      || payload.review.order_submitted !== false || payload.review.execution_authorized !== false) {
      throw new Error('order_review_invalid_receipt');
    }
    await disableKisRecoveryButtons(interaction).catch(() => {});
    await interactionFollowup(interaction, `[KIS 주문안] ${expected === 'confirmed' ? '확인 기록 저장 완료' : '거절 완료'}\n주문 제출 없음. 자동매매 활성화 없음.`).catch(() => {});
    return payload.review;
  } catch (error) {
    const status = rejection ? `요청이 거절되었습니다: ${rejection}` : `처리 결과 미확인: ${sanitizeErrorClass(error.message)}`;
    await interactionFollowup(interaction, `[KIS 주문안] ${status}\n주문 제출 및 자동 재시도 없음.`).catch(() => {});
  }
}

async function handleInteraction(interaction) {
  if (interaction?.type === 3) {
    if (String(interaction?.data?.custom_id || '').startsWith('kis-order-review:')) {
      await handleKisOrderReviewInteraction(interaction);
      return;
    }
    await handleKisRecoveryInteraction(interaction);
    return;
  }
  if (interaction?.type !== 2) return;
  if (!SLASH_COMMAND_NAMES.has(interactionCommandName(interaction))) return;
  if (!shouldHandleInteraction(interaction)) {
    const user = interactionUser(interaction);
    const reason = !isSlashQueueChannel(interaction.channel_id)
      ? `이 slash command는 지정된 큐 채널에서만 사용할 수 있습니다. channel=${[...GATEWAY_QUEUE_CHANNEL_IDS].join(',') || 'configured queue channel'}`
      : USER_IDS.size && !USER_IDS.has(user.id)
        ? '이 slash command를 사용할 권한이 없습니다.'
        : '이 slash command는 현재 codex-control queue 대상이 아닙니다.';
    await interactionCallback(interaction, {
      type: 4,
      data: {
        flags: 64,
        content: reason,
        allowed_mentions: { parse: [] },
      },
    });
    return;
  }

  await interactionCallback(interaction, { type: 5, data: { flags: 64 } });
  try {
    const result = await createTaskFromInteraction(interaction);
    await interactionFollowup(
      interaction,
      queueAckLines(result.created, result.title, result.taskId).join('\n'),
    );
    log('queued slash task', result.taskId || result.title);
  } catch (error) {
    await interactionFollowup(interaction, `[대기열 등록 실패] ${error.message || String(error)}`).catch(() => {});
    log('interaction handling failed', error.message || String(error));
  }
}

async function createTask(message) {
  const attachmentText = await readAttachments(message);
  const parsed = parseTaskForQueue(message.content, attachmentText);
  const response = await fetchWithTimeout(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify({
      title: parsed.title,
      detail: parsed.detail,
      content: removeMention(message.content),
      userId: message.author?.id,
      username: message.author?.username,
      messageId: message.id,
      channelId: message.channel_id,
      guildId: message.guild_id,
      board: 'codex-control',
      orchestrate: false,
    }),
  }, STATE_FETCH_TIMEOUT_MS);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Task API failed: ${response.status} ${body}`);
  }
  const created = JSON.parse(body);
  const taskId = created.task?.id || created.task?.task_id || created.id;
  if (taskId) {
    registerRelayTasks(created, taskId, {
      board: created.board || 'codex-control',
      title: created.spec?.title || parsed.title,
      channelId: message.channel_id,
      messageId: message.id,
      userId: message.author?.id || '',
      username: message.author?.username || '',
    });
    saveRelayState();
    await sendDiscordMessage(
      message.channel_id,
      queueAckLines(created, parsed.title, taskId).join('\n'),
      message.id,
    ).catch((error) => log('queue ack failed', error.message || String(error)));
  }
  log('queued task', body.slice(0, 240));
}

async function resumeTask(message) {
  const parsed = parseResume(message.content);
  if (!parsed.taskId) {
    await sendDiscordMessage(
      message.channel_id,
      '[재개 실패] 작업 ID가 필요합니다. 예: [resume] task: t_xxxxxxxx',
      message.id,
    );
    return;
  }
  const response = await fetchWithTimeout(RESUME_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify({
      taskId: parsed.taskId,
      content: parsed.content,
      userId: message.author?.id,
      username: message.author?.username,
      messageId: message.id,
      channelId: message.channel_id,
      board: 'codex-control',
      unblock: true,
    }),
  }, STATE_FETCH_TIMEOUT_MS);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Resume API failed: ${response.status} ${body}`);
  }
  const result = JSON.parse(body);
  await sendDiscordMessage(
    message.channel_id,
    [
      `[재개 요청 접수] 작업 ID: ${result.taskId || parsed.taskId}`,
      `보드: ${result.board || 'codex-control'}`,
      `차단 해제: ${result.unblocked ? '예' : '아니오'}`,
    ].join('\n'),
    message.id,
  );
}

function statusLabel(status) {
  switch (status) {
    case 'done':
      return 'DONE';
    case 'blocked':
      return 'BLOCKED';
    case 'review':
      return 'REVIEW';
    case 'running':
      return 'RUNNING';
    default:
      return String(status || 'UNKNOWN').toUpperCase();
  }
}

function recoveryParentId(task) {
  const match = String(task.body || '').match(/CODEX_BLOCK_RECOVERY\s+task=([A-Za-z0-9_-]+)/);
  return match?.[1] || '';
}

function parentIdsForTask(task) {
  const ids = new Set();
  if (recoveryParentId(task)) ids.add(recoveryParentId(task));
  for (const key of ['parents', 'parent_ids', 'parentIds']) {
    if (Array.isArray(task[key])) {
      for (const id of task[key]) ids.add(String(id));
    }
  }
  const body = String(task.body || '');
  for (const match of body.matchAll(/\bParent:\s*(t_[A-Za-z0-9_-]+)/gi)) ids.add(match[1]);
  for (const match of body.matchAll(/\/workspaces\/(t_[A-Za-z0-9_-]+)/gi)) ids.add(match[1]);
  ids.delete(task.id);
  return [...ids].filter(Boolean);
}

function syncRelatedMappings(tasksById) {
  for (const task of tasksById.values()) {
    const parentId = parentIdsForTask(task).find((id) => relayState.tasks[id]);
    if (!parentId || relayState.tasks[task.id] || !relayState.tasks[parentId]) continue;
    const parent = relayState.tasks[parentId];
    relayState.tasks[task.id] = {
      ...parent,
      taskId: task.id,
      title: task.title,
      parentTaskId: parentId,
      relation: recoveryParentId(task) ? 'recovery' : 'child',
      lastStatus: 'queued',
      lastProgress: 0,
      createdAt: new Date().toISOString(),
    };
  }
}

function statusLabelKo(status) {
  switch (status) {
    case 'done':
      return '완료';
    case 'blocked':
      return '차단됨';
    case 'review':
      return '검토';
    case 'running':
      return '진행 중';
    case 'ready':
    case 'todo':
      return '대기 중';
    default:
      return String(status || '알 수 없음');
  }
}

function relationLabelKo(entry) {
  if (!entry.parentTaskId) return '';
  const type = entry.relation === 'recovery' ? '복구 작업' : '하위 작업';
  return ` (${entry.parentTaskId}의 ${type})`;
}

function koreanBlockSummary(reason) {
  const text = String(reason || '').trim();
  if (/^review-required/i.test(text)) {
    return '구현은 완료됐지만 검토가 필요해서 일시 차단되었습니다.';
  }
  if (/NEEDS_USER_INPUT|USER_INPUT_REQUIRED|REQUIRED_INPUTS/i.test(text)) {
    return '작업을 계속하려면 사용자가 제공해야 하는 정보가 있습니다.';
  }
  if (/permission|credential|auth/i.test(text)) {
    return '권한 또는 인증 정보가 부족해서 작업이 차단되었습니다.';
  }
  if (/test|failed|error/i.test(text)) {
    return '검증 또는 실행 오류가 있어 작업이 차단되었습니다.';
  }
  return '작업자가 차단 상태로 보고했습니다.';
}

function buildStatusMessageKo(task, entry) {
  const lines = [
    `[${statusLabelKo(task.status)}] ${task.title || entry.title || task.id}`,
    `작업 ID: ${task.id}${relationLabelKo(entry)}`,
    `담당: ${task.assignee || '-'}`,
    `진행률: ${task.progress ?? 0}%`,
  ];
  if (task.progressStage) lines.push(`단계: ${task.progressStage}`);
  if (task.status === 'blocked' && task.needsUserInput) {
    lines.push('');
    lines.push('사용자 입력 필요');
    if (task.blockedReason) {
      lines.push(`요약: ${koreanBlockSummary(task.blockedReason)}`);
      lines.push(`원문 사유: ${truncate(task.blockedReason, 500)}`);
    }
    if (Array.isArray(task.requiredInputs) && task.requiredInputs.length) {
      lines.push('필요한 값:');
      for (const item of task.requiredInputs.slice(0, 10)) {
        lines.push(`- ${item.name}${item.secret ? ' (secret: Discord 밖에서 등록)' : ''}`);
      }
    }
    lines.push('');
    lines.push('API key, token, webhook URL 같은 secret 값은 Discord에 직접 붙이지 마세요.');
    lines.push(`값을 등록/제공한 뒤 이렇게 답장하세요: [resume] task: ${task.id}`);
  }
  if (task.status === 'blocked' && !task.needsUserInput) {
    if (task.blockedReason) {
      lines.push(`요약: ${koreanBlockSummary(task.blockedReason)}`);
      lines.push(`원문 사유: ${truncate(task.blockedReason, 700)}`);
    }
    lines.push('참고: Codex 복구 루프가 켜져 있어 복구 작업이 자동 생성될 수 있습니다.');
  }
  if (task.status === 'done' && task.result) {
    lines.push(`결과: ${truncate(task.result, 700)}`);
  }
  return lines.join('\n');
}

function buildStatusMessage(task, entry) {
  return buildStatusMessageKo(task, entry);
  const relation = entry.parentTaskId ? ` (${entry.relation || 'child'} for ${entry.parentTaskId})` : '';
  const lines = [
    `[${statusLabel(task.status)}] ${task.title || entry.title || task.id}`,
    `task: ${task.id}${relation}`,
    `assignee: ${task.assignee || '-'}`,
    `progress: ${task.progress ?? 0}%`,
  ];
  if (task.progressStage) lines.push(`stage: ${task.progressStage}`);
  if (task.status === 'blocked' && task.needsUserInput) {
    lines.push('');
    lines.push('USER INPUT REQUIRED');
    if (task.blockedReason) lines.push(`reason: ${truncate(task.blockedReason, 500)}`);
    if (Array.isArray(task.requiredInputs) && task.requiredInputs.length) {
      lines.push('required:');
      for (const item of task.requiredInputs.slice(0, 10)) {
        lines.push(`- ${item.name}${item.secret ? ' (secret: register outside Discord)' : ''}`);
      }
    }
    lines.push('');
    lines.push('Do not paste secret values into Discord.');
    lines.push(`After registering/providing the values, reply: [resume] task: ${task.id}`);
  }
  if (task.status === 'blocked' && !task.needsUserInput) {
    if (task.blockedReason) lines.push(`reason: ${truncate(task.blockedReason, 700)}`);
    lines.push('note: Codex recovery is enabled. A recovery task may be created automatically.');
    lines.push('note: blocked 감지됨. Codex recovery가 켜져 있으면 복구 task가 자동 생성됩니다.');
  }
  if (task.status === 'done' && task.result) {
    lines.push(`result: ${truncate(task.result, 700)}`);
  }
  return lines.join('\n');
}

function clampProgress(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function statusProgress(status) {
  if (status === 'done' || status === 'archived') return 100;
  if (status === 'review') return 80;
  if (status === 'running') return 15;
  return 0;
}

function taskProgress(task) {
  return task?.progress === undefined || task?.progress === null
    ? statusProgress(task?.status)
    : clampProgress(task.progress);
}

function progressBucket(value) {
  return Math.floor(clampProgress(value) / 10);
}

function publicNotifyTask(task, blockedReason = '') {
  const progress = taskProgress(task);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    progress,
    progressStage: task.progressStage || task.sanitized_error_class || '',
    blockedReason,
    needsUserInput: false,
  };
}

function isActiveState(state, persistedState = relayState) {
  const summary = state?.summary || {};
  if (Number(summary.running || 0) > 0) return true;
  if (Number(summary.ready || 0) > 0) return true;
  if (Number(summary.blocked || 0) > 0) return true;
  return Object.values(persistedState?.tasks || {}).some((entry) => ACTIVE_POLL_STATUSES.has(String(entry.lastStatus || '')));
}

function statusPollDelayMs(result) {
  if (result?.status === 'error') return NOTIFY_ERROR_INTERVAL_MS;
  if (result?.status === 'active' || result?.status === 'busy') return NOTIFY_ACTIVE_INTERVAL_MS;
  return NOTIFY_IDLE_INTERVAL_MS;
}

async function pollTaskStatus() {
  if (notifyBusy) return { status: 'busy', changed: false };
  notifyBusy = true;
  try {
    const response = await fetchWithTimeout(STATE_ENDPOINT, {
      headers: { authorization: `Bearer ${STATE_SECRET}` },
    }, STATE_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`state API failed: ${response.status}`);
    const state = await response.json();
    const tasksById = new Map((state.tasks || []).map((task) => [task.id, task]));
    syncRelatedMappings(tasksById);

    let changed = false;
    for (const [taskId, entry] of Object.entries(relayState.tasks || {})) {
      const task = tasksById.get(taskId);
      if (!task?.status || !entry.channelId) continue;
      const statusChanged = task.status !== entry.lastStatus;
      const currentProgress = taskProgress(task);
      const lastProgress = clampProgress(entry.lastProgress || 0);
      const progressChanged = progressBucket(currentProgress) !== progressBucket(lastProgress);
      const blockedReason = task.status === 'blocked' ? String(task.sanitized_error_class || '') : '';
      const blockedReasonChanged = Boolean(blockedReason && blockedReason !== String(entry.lastBlockedReason || ''));
      if (!statusChanged && !progressChanged && !blockedReasonChanged) continue;

      if ((statusChanged && NOTIFY_STATUSES.has(task.status)) || blockedReasonChanged || (task.status === 'running' && progressChanged)) {
        await sendDiscordMessage(entry.channelId, buildStatusMessage(publicNotifyTask({ ...task, progress: currentProgress }, blockedReason), entry), entry.messageId);
        log('notified task', `${taskId} status=${task.status} progress=${currentProgress}`);
      }
      entry.lastStatus = task.status;
      entry.lastProgress = currentProgress;
      entry.lastBlockedReason = blockedReason;
      entry.lastNotifiedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) {
      saveRelayState();
    } else {
      saveRelayStateToFile(relayState, STATE_FILE, { writeWhenUnchanged: false });
    }
    return { status: isActiveState(state) ? 'active' : 'idle', changed };
  } catch (error) {
    log('status poll failed', error.message || String(error));
    return { status: 'error', changed: false, error };
  } finally {
    notifyBusy = false;
  }
}

function scheduleStatusPoll(delayMs) {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(async () => {
    notifyTimer = null;
    const result = await pollTaskStatus();
    scheduleStatusPoll(statusPollDelayMs(result));
  }, delayMs);
}

function startStatusPolling() {
  if (notifyTimer) return;
  pollTaskStatus()
    .then((result) => scheduleStatusPoll(statusPollDelayMs(result)))
    .catch((error) => {
      log('status poll failed', error.message || String(error));
      scheduleStatusPoll(NOTIFY_ERROR_INTERVAL_MS);
    });
}

function shouldSendQueueOnlyNotice(message) {
  if (!message || message.author?.bot) return false;
  if (isDiscordCommandGeneratedMessage(message)) return false;
  if (!GATEWAY_QUEUE_CHANNEL_IDS.has(message.channel_id)) return false;
  if (USER_IDS.size && !USER_IDS.has(message.author?.id)) return false;
  const content = String(message.content || '');
  if (QUEUE_PREFIX_RE.test(content) || (!content.trim() && hasTextAttachment(message))) return false;
  if (!content.trim()) return false;
  const key = `${message.channel_id}:${message.author?.id || 'unknown'}`;
  const now = Date.now();
  const prior = queueNoticeAt.get(key) || 0;
  if (now - prior < QUEUE_NOTICE_COOLDOWN_MS) return false;
  queueNoticeAt.set(key, now);
  return true;
}

async function sendQueueOnlyNotice(message) {
  await sendDiscordMessage(
    message.channel_id,
    '이 채널은 작업큐 전용입니다. `/queue`가 Discord 캐시로 실패하면 `[queue] 제목\n상세내용` 형식으로 등록할 수 있습니다.',
    message.id,
  );
}

async function handleMessage(event) {
  if (event.t === 'READY') {
    botUserId = event.d.user.id;
    log('ready', `bot=${event.d.user.username} id=${botUserId}`);
    return;
  }
  if (event.t === 'INTERACTION_CREATE') {
    const commandName = interactionCommandName(event.d);
    if (RELAY_IGNORED_SLASH_COMMANDS.has(commandName)) {
      log('ignored slash interaction', `command=${commandName || '-'} channel=${event.d?.channel_id || '-'}`);
      return;
    }
    if (!HANDLE_INTERACTIONS) {
      log('ignored interaction event', `command=${commandName || '-'} channel=${event.d?.channel_id || '-'}`);
      return;
    }
    try {
      await handleInteraction(event.d);
    } catch (error) {
      log('interaction callback failed', error.message || String(error));
    }
    return;
  }
  if (event.t !== 'MESSAGE_CREATE') return;
  if (isDiscordCommandGeneratedMessage(event.d)) {
    log('ignored command-generated message', `channel=${event.d.channel_id} type=${event.d.type ?? '-'} interaction=${event.d.interaction?.id || event.d.interaction_metadata?.id || '-'}`);
    return;
  }
  const mentioned = event.d.mentions?.some((user) => user.id === botUserId)
    || String(event.d.content || '').includes(`<@${botUserId}>`)
    || String(event.d.content || '').includes(`<@!${botUserId}>`);
  if (mentioned || CHANNEL_IDS.has(event.d.channel_id)) {
    log('message seen', `channel=${event.d.channel_id} author=${event.d.author?.id || '-'} attachments=${event.d.attachments?.length || 0}`);
  }
  if (shouldSendQueueOnlyNotice(event.d)) {
    try {
      await sendQueueOnlyNotice(event.d);
    } catch (error) {
      log('queue-only notice failed', error.message || String(error));
    }
    return;
  }
  if (shouldHandleResume(event.d)) {
    try {
      await resumeTask(event.d);
    } catch (error) {
      log('resume handling failed', error.message || String(error));
    }
    return;
  }
  if (!shouldHandle(event.d)) return;
  try {
    await createTask(event.d);
  } catch (error) {
    log('message handling failed', error.message || String(error));
  }
}

async function connect() {
  const gateway = await discordFetch('/gateway/bot');
  const url = `${gateway.url}/?v=10&encoding=json`;
  socket = new WebSocket(url);

  socket.addEventListener('open', () => log('gateway connected'));
  socket.addEventListener('close', () => {
    log('gateway closed, reconnecting');
    clearInterval(heartbeat);
    setTimeout(() => connect().catch((error) => log('reconnect failed', error.message)), 5000);
  });
  socket.addEventListener('message', async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.s !== null && payload.s !== undefined) sequence = payload.s;
    if (payload.op === 10) {
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send(1, sequence), payload.d.heartbeat_interval);
      identify();
      return;
    }
    if (payload.op === 11) return;
    if (payload.op === 0) await handleMessage(payload);
  });
}

if (IS_MAIN && !TEST_MODE) {
  saveRelayStateToFile(relayState, STATE_FILE, { writeWhenUnchanged: false });

  connect().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });

  startStatusPolling();
}

module.exports = {
  sendDiscordRelayMessage,
  __test: {
    pruneRelayState,
    saveRelayStateToFile,
    terminalTaskTimestamp,
    isActiveState,
    statusPollDelayMs,
    fetchWithTimeout,
    claimDeliveryKey,
    recoveryComponents,
    parseKisRecoveryCustomId,
    kisRecoveryErrorClass,
    handleKisRecoveryInteraction,
    handleKisOrderReviewInteraction,
    shouldHandle,
    shouldSendQueueOnlyNotice,
    intervals: {
      active: NOTIFY_ACTIVE_INTERVAL_MS,
      idle: NOTIFY_IDLE_INTERVAL_MS,
      error: NOTIFY_ERROR_INTERVAL_MS,
      discordFetchTimeout: DISCORD_FETCH_TIMEOUT_MS,
      stateFetchTimeout: STATE_FETCH_TIMEOUT_MS,
    },
    handleInteractions: HANDLE_INTERACTIONS,
    ignoredSlashCommands: [...RELAY_IGNORED_SLASH_COMMANDS].sort(),
  },
};
