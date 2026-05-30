const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { planCapabilities, renderCapabilitySection } = require('./capability-planner');

const PORT = Number(process.env.PORT || 17640);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const HERMES_EXEC_MODE = process.env.HERMES_EXEC_MODE || 'native';
const QUEUE_EXECUTION_PROFILE = cleanProfile(process.env.QUEUE_EXECUTION_PROFILE || 'default', 'default');
const QUEUE_SPAWNABLE_PROFILES = new Set(
  String(process.env.QUEUE_SPAWNABLE_PROFILES || `${QUEUE_EXECUTION_PROFILE},kk_job`)
    .split(',')
    .map((profile) => cleanProfile(profile, ''))
    .filter(Boolean),
);
const SUPERVISOR_AUTO_START = /^(1|true|yes|on)$/i.test(String(process.env.SUPERVISOR_AUTO_START || '1'));
const SUPERVISOR_DEFAULT_BOARD = process.env.SUPERVISOR_BOARD || 'codex-control';
const DASHBOARD_BOARDS = String(process.env.DASHBOARD_BOARDS || 'codex-control,default,kk-job,hermes-hybrid')
  .split(',')
  .map((slug) => cleanBoard(slug))
  .filter(Boolean);
const DASHBOARD_STATE_MODE = process.env.DASHBOARD_STATE_MODE || 'sqlite';
const DASHBOARD_FAST_STATE = !/^(0|false|no|off)$/i.test(String(process.env.DASHBOARD_FAST_STATE || '1'));
const DASHBOARD_INCLUDE_ARCHIVED = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_INCLUDE_ARCHIVED || '0'));
const MAX_SUPERVISOR_LOGS = 80;
const AUTO_SWARM_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.QUEUE_AUTO_SWARM || 'true'));
const AUTO_SWARM_MAX_WORKERS = Math.max(3, Math.min(5, Number(process.env.QUEUE_AUTO_SWARM_MAX_WORKERS || 4) || 4));
const SUPERVISOR_HEALTH_GATE_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.SUPERVISOR_HEALTH_GATE || '1'));
const SUPERVISOR_CRASH_STORM_THRESHOLD = Math.max(2, Math.min(8, Number(process.env.SUPERVISOR_CRASH_STORM_THRESHOLD || 3) || 3));
const SUPERVISOR_CRASH_STORM_WINDOW_SECONDS = Math.max(300, Math.min(86400, Number(process.env.SUPERVISOR_CRASH_STORM_WINDOW_SECONDS || 3600) || 3600));
const SUPERVISOR_CRASH_STORM_SCAN_LIMIT = Math.max(3, Math.min(20, Number(process.env.SUPERVISOR_CRASH_STORM_SCAN_LIMIT || 12) || 12));
const SUPERVISOR_HEALTH_GATE_PROBE_INTERVAL_SECONDS = Math.max(60, Math.min(3600, Number(process.env.SUPERVISOR_HEALTH_GATE_PROBE_INTERVAL_SECONDS || 300) || 300));
const SUMMARY_CACHE_TTL_MS = Math.max(500, Math.min(10_000, Number(process.env.SUMMARY_CACHE_TTL_MS || 2000) || 2000));
const SUMMARY_CACHE_SWR_MS = Math.max(SUMMARY_CACHE_TTL_MS, Math.min(60_000, Number(process.env.SUMMARY_CACHE_SWR_MS || 10_000) || 10_000));
const SUPERVISOR_IDLE_BACKOFF_MAX_MS = Math.max(15_000, Math.min(300_000, Number(process.env.SUPERVISOR_IDLE_BACKOFF_MAX_MS || 300_000) || 300_000));
const SUPERVISOR_IDLE_BACKOFF_INITIAL_MS = Math.max(15_000, Math.min(SUPERVISOR_IDLE_BACKOFF_MAX_MS, Number(process.env.SUPERVISOR_IDLE_BACKOFF_INITIAL_MS || 60_000) || 60_000));
const SYSTEMIC_WORKER_FAILURE_RE = /pid\s+\d+\s+not alive|'NoneType' object is not iterable|Non-streaming API call timed out|Non-retryable client error/i;
const CONTROL_SHARED_SECRET = process.env.CONTROL_SHARED_SECRET || '';
const CONTROL_CSRF_TOKEN = crypto.randomBytes(32).toString('hex');
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
const DISCORD_SHARED_SECRET = process.env.DISCORD_SHARED_SECRET || '';
const DISCORD_INTERACTIONS_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.DISCORD_INTERACTIONS_ENABLED || (DISCORD_PUBLIC_KEY ? '1' : '0')),
);
const DISCORD_ALLOWED_USER_IDS = new Set(
  String(process.env.DISCORD_ALLOWED_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SENSITIVE_TEXT_RE = /\/home\/|\/mnt\/|\.env|client_secret|refresh_token|authorization|OPENAI_|DISCORD_|GOOGLE_|GITHUB_|COOKIE|BEARER|TOKEN|SECRET|KEY|stdout|stderr|body|workspace|path/ig;
let kanbanListSupportsSort = true;

if (!CONTROL_SHARED_SECRET) {
  console.error('CONTROL_SHARED_SECRET is required for dashboard control endpoints.');
  process.exit(1);
}

if (DISCORD_INTERACTIONS_ENABLED && !DISCORD_PUBLIC_KEY) {
  console.error('DISCORD_PUBLIC_KEY is required when DISCORD_INTERACTIONS_ENABLED is true.');
  process.exit(1);
}

const supervisor = {
  enabled: false,
  board: 'codex-control',
  concurrency: Math.max(1, Math.min(8, Number(process.env.SUPERVISOR_CONCURRENCY || 4) || 4)),
  intervalMs: 15000,
  currentIntervalMs: 15000,
  idleBackoffStreak: 0,
  failureLimit: 2,
  startedAt: null,
  lastTickAt: null,
  nextTickAt: null,
  lastError: null,
  lastDispatch: null,
  lastSummary: null,
  runningTick: false,
  timer: null,
  logs: [],
  seenStatuses: new Map(),
  blockedRecovery: true,
  recoveryAssignee: 'fixer',
  healthGate: null,
  lastHealthGateKey: '',
  lastHealthGateProbeAt: null,
};

const summaryCache = new Map();
let loadBoardStateForTest = null;

function okJson(res, value) {
  const body = JSON.stringify(value);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function errJson(res, status, message) {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, maxBytes = 128_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

function parseJson(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('invalid json body');
  }
}

async function readJson(req) {
  return parseJson(await readBody(req));
}

function requestOriginMatches(req) {
  const host = req.headers.host;
  if (!host) return false;
  const expected = new Set([`http://${host}`, `https://${host}`]);
  const origin = String(req.headers.origin || '').trim();
  if (origin) return expected.has(origin);
  const referer = String(req.headers.referer || '').trim();
  if (!referer) return false;
  try {
    return expected.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

function assertControlAuth(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const shared = String(req.headers['x-control-secret'] || '').trim();
  if (bearer === CONTROL_SHARED_SECRET || shared === CONTROL_SHARED_SECRET) return;

  const csrf = String(req.headers['x-control-csrf'] || '').trim();
  if (csrf && csrf === CONTROL_CSRF_TOKEN && requestOriginMatches(req)) return;

  throw new HttpError(403, 'control authorization required');
}

function sanitizePublicText(raw, maxLength = 180) {
  return cleanText(raw, maxLength).replace(SENSITIVE_TEXT_RE, '[redacted]');
}

function sanitizeErrorClass(raw) {
  const text = String(raw || '').toLowerCase();
  if (!text) return null;
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/permission|denied|unauthorized|forbidden/.test(text)) return 'permission';
  if (/missing|required|not found|no such file/.test(text)) return 'missing_dependency';
  if (/rate.?limit|quota/.test(text)) return 'rate_limit';
  if (/network|fetch|econn|socket/.test(text)) return 'network';
  return 'error';
}

function taskUpdatedAt(task) {
  const raw = task.lastActivityAt || task.updated_at || task.completed_at || task.started_at || task.created_at;
  if (!raw) return null;
  if (typeof raw === 'number') return new Date(raw * 1000).toISOString();
  if (/^\d+$/.test(String(raw))) return new Date(Number(raw) * 1000).toISOString();
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function taskAgeSeconds(task) {
  const raw = task.created_at || task.started_at || taskUpdatedAt(task);
  if (!raw) return 0;
  const ms = typeof raw === 'number' ? raw * 1000 : new Date(raw).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

function publicTaskDto(task) {
  const errorSource = task.error || task.lastError || task.blocked_reason || (task.status === 'blocked' ? 'blocked' : '');
  return {
    id: sanitizePublicText(task.id, 64),
    title: sanitizePublicText(task.title || 'Untitled task', 180),
    status: sanitizePublicText(task.status || 'unknown', 32),
    assignee: sanitizePublicText(task.assignee || '-', 64),
    age_seconds: taskAgeSeconds(task),
    retry_count: Number(task.retry_count ?? task.retries ?? task.attempts ?? 0) || 0,
    sanitized_error_class: sanitizeErrorClass(errorSource),
    updated_at: taskUpdatedAt(task),
    progress: publicTaskProgress(task),
    progressStage: publicTaskProgressStage(task),
  };
}

function publicSummaryDto(state) {
  const summary = state.summary || {};
  const currentTask = summary.currentTask ? publicTaskDto(summary.currentTask) : null;
  return {
    board: sanitizePublicText(state.board, 64),
    updated_at: state.updatedAt || new Date().toISOString(),
    summary: {
      total: Number(summary.total || 0),
      done: Number(summary.done || 0),
      running: Number(summary.running || 0),
      ready: Number(summary.ready || 0),
      blocked: Number(summary.blocked || 0),
      overallProgress: clampProgress(summary.overallProgress ?? percent(Number(summary.done || 0), Number(summary.total || 0))),
      currentTask,
    },
    tasks: (state.tasks || []).map(publicTaskDto),
  };
}

function setSummaryCache(board, state) {
  const value = publicSummaryDto(state);
  summaryCache.set(board, {
    value,
    loadedAt: Date.now(),
    promise: null,
  });
  return value;
}

function invalidateSummaryCache(board) {
  if (board) {
    summaryCache.delete(board);
    return;
  }
  summaryCache.clear();
}

async function refreshSummaryCache(board) {
  const existing = summaryCache.get(board);
  if (existing?.promise) return existing.promise;
  const loadState = loadBoardStateForTest || loadBoardState;
  const promise = loadState(board)
    .then((state) => setSummaryCache(board, state))
    .catch((error) => {
      const current = summaryCache.get(board);
      if (current) summaryCache.set(board, { ...current, promise: null });
      throw error;
    });
  summaryCache.set(board, {
    value: existing?.value || null,
    loadedAt: existing?.loadedAt || 0,
    promise,
  });
  return promise;
}

async function loadCachedSummary(board) {
  const entry = summaryCache.get(board);
  const ageMs = entry ? Date.now() - entry.loadedAt : Infinity;
  if (entry?.value && ageMs < SUMMARY_CACHE_TTL_MS) return entry.value;
  if (entry?.value && ageMs < SUMMARY_CACHE_SWR_MS) {
    refreshSummaryCache(board).catch((error) => pushSupervisorLog('error', `summary cache refresh failed for ${board}: ${error.message || String(error)}`));
    return entry.value;
  }
  return refreshSummaryCache(board);
}

function publicSupervisorSnapshot() {
  const summary = supervisor.lastSummary ? {
    total: Number(supervisor.lastSummary.total || 0),
    done: Number(supervisor.lastSummary.done || 0),
    running: Number(supervisor.lastSummary.running || 0),
    ready: Number(supervisor.lastSummary.ready || 0),
    blocked: Number(supervisor.lastSummary.blocked || 0),
  } : null;
  return {
    enabled: supervisor.enabled,
    board: sanitizePublicText(supervisor.board, 64),
    concurrency: supervisor.concurrency,
    intervalMs: supervisor.intervalMs,
    currentIntervalMs: supervisor.currentIntervalMs,
    idleBackoffStreak: supervisor.idleBackoffStreak,
    idleBackoffInitialMs: SUPERVISOR_IDLE_BACKOFF_INITIAL_MS,
    idleBackoffMaxMs: SUPERVISOR_IDLE_BACKOFF_MAX_MS,
    failureLimit: supervisor.failureLimit,
    startedAt: supervisor.startedAt,
    lastTickAt: supervisor.lastTickAt,
    nextTickAt: supervisor.nextTickAt,
    runningTick: supervisor.runningTick,
    lastError: sanitizeErrorClass(supervisor.lastError),
    healthGate: supervisor.healthGate ? {
      active: Boolean(supervisor.healthGate.active),
      reason: sanitizePublicText(supervisor.healthGate.reason || '', 64),
      message: sanitizePublicText(supervisor.healthGate.message || '', 180),
      count: Number(supervisor.healthGate.count || 0),
      threshold: Number(supervisor.healthGate.threshold || SUPERVISOR_CRASH_STORM_THRESHOLD),
      windowSeconds: Number(supervisor.healthGate.windowSeconds || SUPERVISOR_CRASH_STORM_WINDOW_SECONDS),
      tasks: (supervisor.healthGate.tasks || []).slice(0, 6).map((task) => ({
        id: safeTaskId(task.id),
        assignee: sanitizePublicText(task.assignee || '', 64),
        profile: sanitizePublicText(task.profile || '', 64),
      })),
    } : { active: false },
    lastSummary: summary,
    blockedRecovery: supervisor.blockedRecovery,
    recoveryAssignee: sanitizePublicText(supervisor.recoveryAssignee, 64),
    lastHealthGateProbeAt: supervisor.lastHealthGateProbeAt,
    logs: supervisor.logs.slice(0, MAX_SUPERVISOR_LOGS).map((entry) => ({
      level: sanitizePublicText(entry.level || 'info', 16),
      message: sanitizePublicText(entry.message || '', 180),
      at: entry.at,
    })),
  };
}

function cleanBoard(raw) {
  const board = String(raw || 'default').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(board)) return null;
  return board;
}

function cleanProfile(raw, fallback = 'default') {
  const value = String(raw || fallback).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) return fallback;
  return value;
}

function cleanText(raw, maxLength) {
  return String(raw || '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function safeTaskId(raw) {
  const value = String(raw || '').trim();
  return /^t_[A-Za-z0-9_-]+$/.test(value) ? value : '';
}

function runtimeAssignee(profile) {
  const cleaned = cleanProfile(profile, QUEUE_EXECUTION_PROFILE);
  return QUEUE_SPAWNABLE_PROFILES.has(cleaned) ? cleaned : QUEUE_EXECUTION_PROFILE;
}

function hermesCommand(args) {
  const normalized = args.map(String);
  if (HERMES_EXEC_MODE === 'direct') {
    return { file: HERMES_BIN, args: normalized };
  }
  return { file: 'wsl.exe', args: ['--exec', HERMES_BIN, ...normalized] };
}

function runHermes(args) {
  return new Promise((resolve, reject) => {
    const command = hermesCommand(args);
    execFile(command.file, command.args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').trim();
        reject(new Error(message || `hermes exited with ${error.code ?? 'error'}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function runHermesLong(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const command = hermesCommand(args);
    execFile(command.file, command.args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').trim();
        reject(new Error(message || `hermes exited with ${error.code ?? 'error'}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function readDashboardSqlite(scriptName, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile('python3', [path.join(ROOT, scriptName), ...args], { timeout }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').trim();
        reject(new Error(message || `${scriptName} failed`));
        return;
      }
      resolve(stdout);
    });
  });
}

function readBoardSqlite(board) {
  return readDashboardSqlite('board-state.py', [board], 10000);
}

function readTaskDetailsSqlite(board, taskId) {
  return readDashboardSqlite('board-task-details.py', [board, taskId], 10000);
}

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function percent(done, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function clampProgress(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function statusProgress(task) {
  switch (task.status) {
    case 'done':
    case 'archived':
      return 100;
    case 'review':
      return 80;
    case 'running':
      return 15;
    case 'blocked':
      return 0;
    default:
      return 0;
  }
}

function taskProgress(task) {
  const explicit = task.progress;
  return explicit === undefined || explicit === null ? statusProgress(task) : clampProgress(explicit);
}

function publicTaskProgress(task) {
  return taskProgress(task);
}

function publicTaskProgressStage(task) {
  return sanitizePublicText(task.progressStage || taskStage(task), 120);
}

function taskStage(task) {
  switch (task.status) {
    case 'done':
    case 'archived':
      return 'completed';
    case 'review':
      return 'review';
    case 'running':
      return 'running';
    case 'blocked':
      return 'blocked';
    default:
      return task.status || 'queued';
  }
}

function unixIso(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(parsed < 10_000_000_000 ? parsed * 1000 : parsed).toISOString();
}

function latestUnix(...values) {
  let latest = 0;
  for (const value of values.flat()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return latest || null;
}

function latestRun(details) {
  const runs = Array.isArray(details?.runs) ? details.runs : [];
  return runs.reduce((best, run) => {
    if (!best) return run;
    return Number(run.id || 0) > Number(best.id || 0) ? run : best;
  }, null);
}

function textFromTaskDetails(details, logText) {
  const comments = Array.isArray(details?.comments) ? details.comments : [];
  const events = Array.isArray(details?.events) ? details.events : [];
  const eventText = events.map((event) => `${event.kind} ${JSON.stringify(event.payload || {})}`).join('\n');
  const commentText = comments.map((comment) => comment.body || '').join('\n');
  return `${logText || ''}\n${eventText}\n${commentText}`;
}

function stageTextFromTaskDetails(details, logText) {
  const events = Array.isArray(details?.events) ? details.events : [];
  const eventText = events.map((event) => `${event.kind} ${JSON.stringify(event.payload || {})}`).join('\n');
  return `${logText || ''}\n${eventText}`;
}

function explicitProgress(text) {
  let latest = null;
  const patterns = [
    /\[PROGRESS\]\s*[:=-]?\s*(\d{1,3})\s*%?/gi,
    /progress\s*[:=-]\s*(\d{1,3})\s*%/gi,
    /진행(?:률|도)\s*[:=-]?\s*(\d{1,3})\s*%/gi,
  ];
  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) latest = clampProgress(match[1]);
  }
  return latest;
}

function activityCount(text, details) {
  const logHits = String(text || '')
    .split(/\r?\n/)
    .filter((line) => /\b(plan|read|grep|find|kanban_he|kanban_co|skill)\b|\$|tools-dev|pnpm|curl/i.test(line))
    .length;
  const events = Array.isArray(details?.events) ? details.events.length : 0;
  const comments = Array.isArray(details?.comments) ? details.comments.length : 0;
  return logHits + events + comments;
}

function inferRunningProgress(task, details, logText) {
  const text = textFromTaskDetails(details, logText);
  const stageText = stageTextFromTaskDetails(details, logText);
  const explicit = explicitProgress(text);
  let progress = 15;
  let stage = 'started';

  const checkpoints = [
    [20, 'planning', /plan\s+\d+\s+task|EXECUTION_PLAN/i, text],
    [35, 'environment checked', /환경 점검 완료|workspace=|git=|node=|corepack=|hermes-acp-help/i, stageText],
    [45, 'docs and adapter review', /README\.md|QUICKSTART\.md|package\.json|apps\/daemon|runtimes\/defs\/hermes|agent-adapters/i, stageText],
    [60, 'install and tool check', /pnpm install|tools-dev check|corepack pnpm exec tools-dev check/i, stageText],
    [72, 'runtime validation', /tools-dev run web|tools-dev start web|foreground web|api\/health|localhost|hermes acp --check/i, stageText],
    [84, 'documentation', /(write|edit|created|updated|tee|Set-Content|New-Item|mkdir).*?(docs\/open-design|prompts\/open-design|open-design-(local-runbook|troubleshooting|sample-prompts))/i, stageText],
    [92, 'final report', /Open Design × Hermes 검증 결과|# Open Design/i, stageText],
  ];

  for (const [checkpointProgress, checkpointStage, pattern, source] of checkpoints) {
    if (pattern.test(source)) {
      progress = checkpointProgress;
      stage = checkpointStage;
    }
  }

  const run = latestRun(details);
  const startedAt = Number(run?.started_at || task.started_at || task.created_at || 0);
  const elapsedMinutes = startedAt ? Math.max(0, (Date.now() / 1000 - startedAt) / 60) : 0;
  const activityBump = Math.min(9, Math.floor(activityCount(text, details) / 4));
  const elapsedBump = Math.min(6, Math.floor(elapsedMinutes / 5));
  progress = Math.min(95, progress + Math.max(activityBump, elapsedBump));

  if (explicit !== null) {
    progress = explicit;
    stage = `reported ${explicit}%`;
  }

  return { progress: clampProgress(progress), progressStage: stage };
}

function blockedContextText(details, logText = '') {
  const comments = Array.isArray(details?.comments) ? details.comments : [];
  const events = Array.isArray(details?.events) ? details.events : [];
  return [
    details?.latest_summary || '',
    logText || '',
    ...comments.map((comment) => comment.body || ''),
    ...events.map((event) => `${event.kind} ${JSON.stringify(event.payload || {})}`),
  ].join('\n');
}

function isUserInputBlockText(text) {
  return /\b(NEEDS_USER_INPUT|USER_INPUT_REQUIRED|REQUIRED_INPUTS|MISSING_USER_INPUT)\b/i.test(text);
}

function extractRequiredInputs(text) {
  const found = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  let inRequiredBlock = false;
  for (const line of lines) {
    if (/\bREQUIRED_INPUTS\b/i.test(line)) {
      inRequiredBlock = true;
    } else if (inRequiredBlock && /^\S/.test(line) && !/^\s*[-*]/.test(line)) {
      inRequiredBlock = false;
    }
    if (!inRequiredBlock && !/\b(NEEDS_USER_INPUT|USER_INPUT_REQUIRED|MISSING_USER_INPUT)\b/i.test(line)) {
      continue;
    }
    const matches = [
      ...line.matchAll(/\b[A-Za-z0-9_.-]+_(?:ID|URL|TOKEN|KEY|SECRET|WEBHOOK|CHANNEL|ACCOUNT)\b/g),
    ];
    for (const match of matches) {
      const name = match[0].replace(/[.,:;]+$/, '');
      if (seen.has(name) || ['NEEDS_USER_INPUT', 'REQUIRED_INPUTS'].includes(name)) continue;
      seen.add(name);
      found.push({
        name,
        secret: /\b(TOKEN|SECRET|KEY|WEBHOOK|PASSWORD|COOKIE)\b/i.test(name),
      });
    }
  }
  return found.slice(0, 12);
}

function userInputBlockInfo(task, details, logText = '') {
  const text = blockedContextText(details, logText);
  const reason = cleanText(details?.latest_summary || text.replace(/\s+/g, ' '), 900);
  return {
    needsUserInput: isUserInputBlockText(text),
    requiredInputs: extractRequiredInputs(text),
    blockedReason: reason,
  };
}

function inferTaskActivity(task, details, logText) {
  const events = Array.isArray(details?.events) ? details.events : [];
  const comments = Array.isArray(details?.comments) ? details.comments : [];
  const runs = Array.isArray(details?.runs) ? details.runs : [];
  const latest = latestUnix(
    task.created_at,
    task.started_at,
    task.completed_at,
    events.map((event) => event.created_at),
    comments.map((comment) => comment.created_at),
    runs.flatMap((run) => [run.started_at, run.ended_at]),
  );
  const base = {
    progress: statusProgress(task),
    progressStage: taskStage(task),
    lastActivityAt: unixIso(latest),
  };

  if (task.status === 'running') {
    return { ...base, ...inferRunningProgress(task, details, logText) };
  }
  if (task.status === 'blocked') {
    const blockInfo = userInputBlockInfo(task, details, logText);
    return {
      ...base,
      progressStage: blockInfo.needsUserInput ? 'waiting for user input' : base.progressStage,
      ...blockInfo,
    };
  }
  return base;
}

function fastTaskActivity(task) {
  return {
    ...task,
    progress: taskProgress(task),
    progressStage: taskStage(task),
    lastActivityAt: unixIso(task.completed_at || task.started_at || task.created_at),
  };
}

async function enrichTaskProgress(board, task) {
  if (!['running', 'review', 'blocked'].includes(task.status)) {
    return { ...task, progress: statusProgress(task), progressStage: taskStage(task), lastActivityAt: unixIso(task.completed_at || task.started_at || task.created_at) };
  }
  try {
    const [showOutput, logOutput] = await Promise.all([
      runHermes(['kanban', '--board', board, 'show', '--json', task.id]),
      runHermes(['kanban', '--board', board, 'log', task.id]),
    ]);
    const details = JSON.parse(showOutput);
    const tail = String(logOutput || '').split(/\r?\n/).slice(-240).join('\n');
    return { ...task, ...inferTaskActivity(task, details, tail) };
  } catch (error) {
    return {
      ...task,
      progress: statusProgress(task),
      progressStage: `${taskStage(task)}: progress unavailable`,
      lastActivityAt: unixIso(task.completed_at || task.started_at || task.created_at),
      progressError: error.message || String(error),
    };
  }
}

function fallbackTaskSpec(input) {
  const detail = cleanText(input.detail || input.body || input.description, 8000);
  const title = cleanText(input.title || detail.split('\n')[0] || 'Untitled task', 160);
  const combined = `${title}\n${detail}`.toLowerCase();
  const assignee = cleanProfile(
    input.assignee
      || (/(test|qa|검증|테스트)/.test(combined) ? 'tester'
      : /(review|리뷰|검토)/.test(combined) ? 'reviewer'
      : /(research|조사|리서치|검색)/.test(combined) ? 'researcher'
      : /(debug|bug|버그|오류|장애)/.test(combined) ? 'debugger'
      : /(document|docs|문서)/.test(combined) ? 'documenter'
      : /(plan|설계|기획)/.test(combined) ? 'planner'
      : 'default'),
  );
  const priority = clampInt(
    input.priority,
    /(urgent|긴급|즉시|high|높음)/.test(combined) ? 80 : 30,
    0,
    100,
  );
  const body = [
    `Source: ${cleanText(input.source || 'api', 80)}`,
    '',
    'Original request:',
    detail || title,
    '',
    'Acceptance criteria:',
    '- Complete the requested work.',
    '- User-facing status, block reasons, and completion summaries must be written in Korean.',
    '- If this becomes a planning/decomposition task, create concrete follow-up implementation task(s) on the same Kanban board before completing. Do not finish with planning only.',
    '- During long work, add a kanban heartbeat or comment like `[PROGRESS] 40 - current stage` after meaningful milestones.',
    '- Report files changed, commands run, and verification result.',
    '- Block only when required user-provided information is truly missing. Use this exact format in the block reason: `NEEDS_USER_INPUT` then `REQUIRED_INPUTS:` with one bullet per env var/id/account/permission and say whether each value is secret.',
    '- Do not ask the user for secrets in Discord. Ask them to register secret values in env/Hermes secret store, then reply with `[resume] task: <id>`.',
    '',
    'Completion report:',
    '- Summary',
    '- Verification',
    '- Blockers or follow-up tasks',
  ].join('\n');
  return {
    title,
    body,
    assignee,
    priority,
    workspace: cleanText(input.workspace || 'scratch', 120) || 'scratch',
    maxRuntime: cleanText(input.maxRuntime || '30m', 32),
    maxRetries: clampInt(input.maxRetries, 2, 1, 10),
    skills: Array.isArray(input.skills) ? input.skills.map((skill) => cleanText(skill, 64)).filter(Boolean).slice(0, 4) : [],
    orchestrated: false,
  };
}

function ensureImplementationContinuity(spec, input) {
  const combined = `${spec.title || ''}\n${spec.body || ''}\n${input.title || ''}\n${input.detail || input.body || input.description || ''}`;
  const planningLike = spec.assignee === 'planner'
    || /\b(planning|decomposition|implementation plan|design plan)\b/i.test(combined)
    || /계획|기획|설계|구현 계획/.test(combined);
  if (!planningLike || /FOLLOW_UP_IMPLEMENTATION_REQUIRED/.test(spec.body || '')) return spec;

  const board = cleanBoard(input.board || supervisor.board || 'codex-control') || 'codex-control';
  const extra = [
    '',
    'FOLLOW_UP_IMPLEMENTATION_REQUIRED:',
    '- This card may plan or decompose, but it must not end at planning only.',
    `- Before completing, create concrete implementation child task(s) on board ${board}.`,
    '- Use the current Kanban task id as the parent, for example: hermes kanban --board <board> create "<implementation title>" --parent <current_task_id> --assignee coder --body "<concrete spec>".',
    '- Each child task must include acceptance criteria, verification steps, secret handling, and expected files or outputs.',
    '- If implementation is unsafe because required secrets/accounts are missing, create a setup/blocker child task with the exact missing manual input.',
    '- The completion report must list every created follow-up task id and why it was created.',
  ].join('\n');

  return { ...spec, body: cleanText(`${spec.body || ''}${extra}`, 12000) };
}

function requestedQueueMode(input) {
  const value = String(input.mode || input.queueMode || input.executionMode || '').trim().toLowerCase();
  if (/^(single|task|serial|sequential)$/i.test(value)) return 'single';
  if (/^(swarm|parallel|auto-swarm|autoswarm)$/i.test(value)) return 'swarm';
  if (input.parallel !== undefined) return boolValue(input.parallel, false) ? 'swarm' : 'single';
  return 'auto';
}

function broadRequestScore(input, spec) {
  const detail = cleanText(input.detail || input.body || input.description || '', 8000);
  const text = `${input.title || ''}\n${detail}\n${spec.title || ''}\n${spec.body || ''}`.toLowerCase();
  const lines = detail.split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^[-*0-9.)\]]/.test(line)).length;
  const categories = [
    /(implement|code|fix|refactor|build|add|modify|구현|수정|개선|추가|만들)/i,
    /(test|pytest|검증|테스트|빌드|compile|재현)/i,
    /(document|docs|readme|문서|보고|정리)/i,
    /(research|diagnose|inspect|조사|분석|진단|확인)/i,
    /(cron|scheduler|discord|webhook|api|env|config|운영|설정|자동화|대시보드)/i,
  ];
  const categoryHits = categories.filter((pattern) => pattern.test(text)).length;
  let score = 0;
  if (detail.length >= 700) score += 2;
  if (detail.length >= 1400) score += 1;
  if (lines.length >= 5) score += 1;
  if (lines.length >= 8) score += 1;
  if (bullets >= 4) score += 3;
  if (categoryHits >= 3) score += 2;
  if (/\b(parallel|swarm|decompose|split|fan[- ]?out)\b|병렬|분해|쪼개|나눠/.test(text)) score += 3;
  return score;
}

function shouldCreateSwarm(input, spec) {
  const mode = requestedQueueMode(input);
  if (mode === 'single') return false;
  if (mode === 'swarm') return true;
  if (!AUTO_SWARM_ENABLED) return false;
  if (input.assignee && !/^(default|planner)$/i.test(String(input.assignee))) return false;
  return broadRequestScore(input, spec) >= 4;
}

function swarmTitle(text, fallback) {
  return cleanText(String(text || fallback || '').replace(/[:\r\n]+/g, ' ').replace(/\s+/g, ' '), 100);
}

function buildSwarmWorkers(input, spec) {
  const text = `${input.title || ''}
${input.detail || input.body || input.description || ''}
${spec.title || ''}
${spec.body || ''}`.toLowerCase();
  const plannerWorkers = Array.isArray(spec.capabilityPlan?.workers)
    ? spec.capabilityPlan.workers
      .map((worker) => ({
        profile: cleanProfile(worker.profile, ''),
        title: swarmTitle(worker.title, 'Capability worker'),
      }))
      .filter((worker) => worker.profile && QUEUE_SPAWNABLE_PROFILES.has(worker.profile))
    : [];
  const workers = plannerWorkers.length ? plannerWorkers : [
    { profile: 'researcher', title: '현재 상태 조사 및 원인 분석' },
    { profile: 'coder', title: '핵심 코드 수정 및 설정 반영' },
    { profile: 'tester', title: '회귀 테스트와 실행 검증' },
  ];
  if (!plannerWorkers.length && /(cron|scheduler|discord|webhook|api|env|config|deploy|운영|설정|자동화|대시보드)/i.test(text)) {
    workers.splice(1, 0, { profile: 'devops', title: '운영 경로와 실행 환경 점검' });
  }
  if (!plannerWorkers.length && (workers.length < AUTO_SWARM_MAX_WORKERS || /(docs|readme|문서|보고|runbook|운영)/i.test(text))) {
    workers.push({ profile: 'documenter', title: '문서와 완료 보고 정리' });
  }
  return workers
    .slice(0, AUTO_SWARM_MAX_WORKERS)
    .map((worker) => ({
      profile: cleanProfile(worker.profile, 'coder'),
      title: swarmTitle(worker.title, 'Swarm worker'),
      skills: [],
    }));
}


function applyCapabilityPlan(spec, input, board) {
  let plan = null;
  try {
    plan = planCapabilities({
      input,
      spec,
      board,
      spawnableProfiles: [...QUEUE_SPAWNABLE_PROFILES],
      executionProfile: QUEUE_EXECUTION_PROFILE,
    });
  } catch (error) {
    pushSupervisorLog('error', `capability planner failed: ${error.message || String(error)}`);
    return spec;
  }

  const section = renderCapabilitySection(plan);
  const body = section && !String(spec.body || '').includes('Capability Planner:')
    ? cleanText(`${spec.body || ''}\n\n${section}`, 12000)
    : spec.body;
  const assignee = plan.shouldOverrideAssignee
    ? cleanProfile(plan.recommendedAssignee, spec.assignee || QUEUE_EXECUTION_PROFILE)
    : spec.assignee;
  return {
    ...spec,
    assignee,
    body,
    capabilityPlan: plan,
  };
}

function buildSwarmPlan(input, spec, board) {
  const detail = cleanText(input.detail || input.body || input.description || spec.body || '', 8000);
  const title = swarmTitle(spec.title || input.title, '병렬 작업');
  const capabilitySection = spec.capabilityPlan ? renderCapabilitySection(spec.capabilityPlan) : '';
  const goal = cleanText([
    `Source: ${cleanText(input.source || 'api', 80)}`,
    `Board: ${board}`,
    '',
    'Original request:',
    detail || title,
    ...(capabilitySection ? ['', capabilitySection] : []),
    '',
    'Parallel execution policy:',
    '- Work as a Kanban swarm: parallel workers produce focused handoffs, verifier gates, synthesizer integrates.',
    '- Avoid editing the same file concurrently. If ownership is unclear, leave a concrete handoff/diff and let the synthesizer integrate.',
    '- User-facing status, block reasons, and completion summaries must be written in Korean.',
    '- Do not reveal secret values. Request missing secrets by env/secret name only.',
    '- Completion must report files changed, commands run, verification result, and remaining blockers.',
    '- Each worker must emit Korean progress updates with exact markers: `[PROGRESS] 15%`, `[PROGRESS] 40%`, `[PROGRESS] 70%`, `[PROGRESS] 90%`.',
  ].join('\n'), 12000);
  return {
    mode: 'swarm',
    spec: {
      title: `병렬: ${title}`,
      body: goal,
      assignee: 'swarm',
      priority: clampInt(spec.priority, 70, 0, 100),
      workspace: 'scratch',
      maxRuntime: spec.maxRuntime || '30m',
      maxRetries: spec.maxRetries || 2,
      skills: [],
      orchestrated: Boolean(spec.orchestrated),
      capabilityPlan: spec.capabilityPlan || null,
    },
    swarm: {
      goal,
      workers: buildSwarmWorkers(input, spec),
      verifier: 'reviewer',
      synthesizer: 'editor',
      priority: clampInt(spec.priority, 70, 0, 100),
    },
  };
}

function swarmWorkerArg(worker) {
  const profile = cleanProfile(worker.profile, 'coder');
  const title = swarmTitle(worker.title, 'Swarm worker');
  const skills = Array.isArray(worker.skills)
    ? worker.skills.map((skill) => cleanText(skill, 64)).filter(Boolean).slice(0, 4)
    : [];
  return skills.length ? `${profile}:${title}:${skills.join(',')}` : `${profile}:${title}`;
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('empty orchestrator output');
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('orchestrator output did not contain JSON');
}

async function orchestrateTask(input) {
  const fallback = fallbackTaskSpec(input);
  if (input.orchestrate === false) return fallback;

  const prompt = [
    'You are the Hermes Orchestrator for a Codex-supervised Kanban queue.',
    'Turn the user request into one concrete Hermes Kanban task.',
    'Return ONLY valid JSON with these fields:',
    '{',
    '  "title": string,',
    '  "body": string,',
    '  "assignee": "default|coder|tester|reviewer|researcher|planner|debugger|documenter|devops|security|optimizer",',
    '  "priority": number from 0 to 100,',
    '  "workspace": "scratch",',
    '  "maxRuntime": "30m",',
    '  "maxRetries": 1 to 10,',
    '  "skills": string[]',
    '}',
    '',
    'Body must include acceptance criteria, execution notes, verification expectations, progress reporting, and completion report format.',
    'Workers must report meaningful progress in Korean at major milestones using exact markers like `[PROGRESS] 15%`, `[PROGRESS] 40%`, `[PROGRESS] 70%`, and `[PROGRESS] 90%` in logs or comments.',
    'All user-facing status messages, block reasons, and final summaries must be in Korean.',
    'When required user information is missing, tell the worker to block with `NEEDS_USER_INPUT` and `REQUIRED_INPUTS:`. Secrets must be requested by name only, not by value.',
    'If the request is too broad, make the first task a planning/decomposition task only when needed, and require it to create concrete implementation child tasks before completion. Never let planning be the final deliverable when the user asked to proceed or implement.',
    '',
    `Source: ${input.source || 'api'}`,
    `Requested title: ${input.title || ''}`,
    `Detailed instruction:\n${input.detail || input.body || input.description || ''}`,
  ].join('\n');

  try {
    const output = await runHermesLong(['-z', prompt], 120000);
    const spec = { ...fallback, ...extractJsonObject(output), orchestrated: true };
    return ensureImplementationContinuity({
      title: cleanText(spec.title, 160) || fallback.title,
      body: cleanText(spec.body, 12000) || fallback.body,
      assignee: cleanProfile(spec.assignee, fallback.assignee),
      priority: clampInt(spec.priority, fallback.priority, 0, 100),
      workspace: cleanText(spec.workspace || fallback.workspace, 120) || 'scratch',
      maxRuntime: cleanText(spec.maxRuntime || fallback.maxRuntime, 32),
      maxRetries: clampInt(spec.maxRetries, fallback.maxRetries, 1, 10),
      skills: Array.isArray(spec.skills) ? spec.skills.map((skill) => cleanText(skill, 64)).filter(Boolean).slice(0, 4) : [],
      orchestrated: true,
    }, input);
  } catch (error) {
    pushSupervisorLog('error', `orchestrator fallback: ${error.message || String(error)}`);
    return ensureImplementationContinuity({ ...fallback, orchestratorError: error.message || String(error) }, input);
  }
}

function normalizeFingerprintText(raw, maxLength = 4000) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, maxLength);
}

function stableJson(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compactFingerprintComponent(value, maxLength = 512) {
  const text = typeof value === 'string' ? normalizeFingerprintText(value, maxLength) : stableJson(value);
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength / 2))}:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function boundedSourceKey(prefix, raw, maxRawLength = 80) {
  const value = cleanText(raw, Math.max(maxRawLength + 1, 512));
  if (value.length <= maxRawLength) return `${prefix}:${value}`;
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${prefix}:${value.slice(0, 32)}:${digest}`.slice(0, 120);
}

function stableWorkerPlan(workers) {
  if (!Array.isArray(workers)) return workers || null;
  return workers.map((worker) => ({
    profile: cleanProfile(worker?.profile, ''),
    title: normalizeFingerprintText(worker?.title || worker?.role || '', 160),
  })).filter((worker) => worker.profile || worker.title);
}

function stableCapabilityPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    tags: Array.isArray(plan.tags) ? plan.tags.map((tag) => normalizeFingerprintText(tag, 80)).filter(Boolean).sort() : [],
    requested_assignee: cleanProfile(plan.requestedAssignee, ''),
    current_assignee: cleanProfile(plan.currentAssignee, ''),
    recommended_assignee: cleanProfile(plan.recommendedAssignee, ''),
    swarm_recommended: Boolean(plan.swarmRecommended),
    workers: stableWorkerPlan(plan.workers || plan.profiles || plan.recommendedProfiles),
    guardrails: Array.isArray(plan.guardrails) ? plan.guardrails.map((item) => normalizeFingerprintText(item, 240)).filter(Boolean).sort() : [],
    hints: Array.isArray(plan.hints) ? plan.hints.map((hint) => ({
      kind: normalizeFingerprintText(hint?.kind, 80),
      name: normalizeFingerprintText(hint?.name, 120),
      reason: normalizeFingerprintText(hint?.reason, 240),
    })).sort((a, b) => stableJson(a).localeCompare(stableJson(b))) : [],
  };
}

function stableSwarmPlan(swarm) {
  if (!swarm || typeof swarm !== 'object') return null;
  return {
    workers: stableWorkerPlan(swarm.workers),
    verifier: cleanProfile(swarm.verifier, ''),
    synthesizer: cleanProfile(swarm.synthesizer, ''),
    priority: clampInt(swarm.priority, 0, 0, 100),
  };
}

function fingerprintComponents(input, spec = {}, board = '') {
  const capabilityPlan = stableCapabilityPlan(spec.capabilityPlan);
  const workers = stableSwarmPlan(spec.workers) || stableWorkerPlan(spec.workers || capabilityPlan?.workers);
  return {
    source: normalizeFingerprintText(input.source || 'api', 80) || 'api',
    board: cleanBoard(board || input.board || supervisor.board || 'codex-control') || 'codex-control',
    assignee: cleanProfile(spec.assignee || input.assignee || QUEUE_EXECUTION_PROFILE, QUEUE_EXECUTION_PROFILE),
    priority: clampInt(spec.priority ?? input.priority, 0, 0, 100),
    title: normalizeFingerprintText(spec.title || input.title || '', 300),
    detail: normalizeFingerprintText(input.detail || input.body || input.description || spec.body || '', 1200),
    capability_plan: compactFingerprintComponent(capabilityPlan, 1200),
    workers: compactFingerprintComponent(workers, 800),
  };
}

function idempotencyKey(input, spec, board = '') {
  if (input.idempotencyKey) return cleanText(input.idempotencyKey, 120);
  if (input.discordInteractionId) return boundedSourceKey('discord', input.discordInteractionId, 80);
  if (input.sourceId) return boundedSourceKey(cleanText(input.source || 'source', 30), input.sourceId, 80);
  const components = fingerprintComponents(input, spec, board);
  return crypto
    .createHash('sha256')
    .update(stableJson(components))
    .digest('hex')
    .slice(0, 32);
}

function taskIdFromCreateResult(task) {
  return task?.id || task?.task_id || task?.task?.id || task?.task?.task_id || null;
}

function taskDuplicateReused(task) {
  return Boolean(task?.duplicate_reused || task?.duplicateReused || task?.reused || task?.existing || task?.task?.duplicate_reused);
}

// API response extension memo:
// createKanbanTask responses keep existing top-level fields and add
// duplicate_report: { possible_duplicate, duplicate_reused, idempotency_key,
// fingerprint, reason, source, key_components, reused_task_id? }.
// dryRun returns reason=idempotency-key-preview so callers can audit the
// duplicate-prevention fingerprint before running hermes kanban create.
function duplicateReport(input, spec, board, context = {}) {
  const key = idempotencyKey(input, spec, board);
  const reused = taskDuplicateReused(context.task);
  const report = {
    possible_duplicate: true,
    duplicate_reused: reused,
    idempotency_key: key,
    fingerprint: key,
    mode: context.mode || 'task',
    dry_run: Boolean(context.dryRun),
    reason: reused ? 'idempotency-key-reused' : (context.dryRun ? 'idempotency-key-preview' : 'idempotency-key-created'),
    source: cleanText(input.source || 'api', 80) || 'api',
    key_components: fingerprintComponents(input, spec, board),
  };
  const reusedTaskId = reused ? taskIdFromCreateResult(context.task) : null;
  if (reusedTaskId) report.reused_task_id = reusedTaskId;
  return report;
}

function safeDuplicateReport(report) {
  return {
    ...report,
    key_components: {
      ...report.key_components,
      title: sanitizePublicText(report.key_components.title, 120),
      detail: report.key_components.detail
        ? crypto.createHash('sha256').update(report.key_components.detail).digest('hex').slice(0, 16)
        : '',
      capability_plan: report.key_components.capability_plan
        ? crypto.createHash('sha256').update(report.key_components.capability_plan).digest('hex').slice(0, 16)
        : '',
      workers: report.key_components.workers
        ? crypto.createHash('sha256').update(report.key_components.workers).digest('hex').slice(0, 16)
        : '',
    },
  };
}

function planFingerprintSpec(plan) {
  if (plan.mode !== 'swarm') return plan.spec;
  return {
    ...plan.spec,
    workers: plan.swarm || plan.spec.workers,
  };
}

async function createKanbanSwarm(input, board, plan) {
  const createdBy = cleanText(input.createdBy || 'Codex Discord Orchestrator', 80);
  const fingerprintSpec = planFingerprintSpec(plan);
  const baseKey = idempotencyKey(input, fingerprintSpec, board);
  const priority = String(clampInt(plan.swarm.priority, plan.spec.priority, 0, 100));

  async function createTask(title, body, assignee, suffix, parents = []) {
    const args = [
      'kanban',
      '--board',
      board,
      'create',
      title,
      '--body',
      body,
      '--assignee',
      runtimeAssignee(assignee),
      '--priority',
      priority,
      '--workspace',
      'scratch',
      '--max-runtime',
      plan.spec.maxRuntime || '30m',
      '--max-retries',
      String(plan.spec.maxRetries || 2),
      '--created-by',
      createdBy,
      '--idempotency-key',
      `${baseKey}:${suffix}`,
      '--json',
    ];
    for (const parent of parents.filter(Boolean)) {
      args.push('--parent', parent);
    }
    const output = await runHermesLong(args, 60000);
    return JSON.parse(output);
  }

  const root = await createTask(
    plan.spec.title,
    [
      plan.spec.body,
      '',
      'Fan-out:',
      ...plan.swarm.workers.map((worker, index) => `- W${index + 1}: ${worker.profile} - ${worker.title}`),
      `- Verifier: ${plan.swarm.verifier}`,
      `- Synthesizer: ${plan.swarm.synthesizer}`,
    ].join('\n'),
    'planner',
    'root',
  );
  const rootId = root.id || root.task_id || root.task?.id;
  if (!rootId) throw new Error('failed to create swarm root task');

  const workerTasks = [];
  for (const [index, worker] of plan.swarm.workers.entries()) {
    const body = [
      `Parent coordination task: ${rootId}`,
      '',
      'Worker assignment:',
      worker.title,
      '',
      'Shared goal:',
      plan.swarm.goal,
      '',
      'Output requirements:',
      '- Comment progress and findings in Korean.',
      '- Include exact progress markers at major milestones: `[PROGRESS] 15%`, `[PROGRESS] 40%`, `[PROGRESS] 70%`, `[PROGRESS] 90%`.',
      '- Avoid editing files outside this worker scope unless necessary.',
      '- Leave concrete handoff notes for verifier/synthesizer.',
    ].join('\n');
    workerTasks.push(await createTask(
      `${worker.title}: ${swarmTitle(plan.spec.title, '작업')}`,
      body,
      cleanProfile(worker.profile, 'coder'),
      `worker-${index + 1}-${cleanProfile(worker.profile, 'coder')}`,
      [rootId],
    ));
  }

  const workerIds = workerTasks.map((task) => task.id || task.task_id || task.task?.id).filter(Boolean);
  const verifier = await createTask(
    `검증: ${swarmTitle(plan.spec.title, '병렬 작업')}`,
    [
      'Verify all worker outputs before synthesis.',
      '',
      'Worker tasks:',
      ...workerIds.map((id) => `- ${id}`),
      '',
      'Report in Korean: pass/fail, gaps, and required fixes.',
      'Include exact progress markers while verifying: `[PROGRESS] 40%`, `[PROGRESS] 70%`, `[PROGRESS] 90%`.',
    ].join('\n'),
    cleanProfile(plan.swarm.verifier, 'reviewer'),
    'verifier',
    workerIds,
  );
  const verifierId = verifier.id || verifier.task_id || verifier.task?.id;

  const synthesizer = await createTask(
    `통합: ${swarmTitle(plan.spec.title, '병렬 작업')}`,
    [
      'Integrate the verified worker outputs into the final result.',
      '',
      `Verifier task: ${verifierId || '-'}`,
      '',
      'Final report must be in Korean and include changed files, commands run, verification result, and remaining risks.',
      'Include exact progress markers during synthesis: `[PROGRESS] 40%`, `[PROGRESS] 70%`, `[PROGRESS] 90%`.',
    ].join('\n'),
    cleanProfile(plan.swarm.synthesizer, 'editor'),
    'synthesizer',
    [verifierId],
  );
  const synthesizerId = synthesizer.id || synthesizer.task_id || synthesizer.task?.id;

  await runHermesLong([
    'kanban',
    '--board',
    board,
    'complete',
    rootId,
    '--summary',
    `병렬 하위 작업 생성 완료: workers=${workerIds.join(', ')} verifier=${verifierId || '-'} synthesizer=${synthesizerId || '-'}`,
  ], 60000);

  const swarmCreated = {
    root_id: rootId,
    worker_ids: workerIds,
    verifier_id: verifierId,
    synthesizer_id: synthesizerId,
    strategy: 'fanout-kanban-create',
  };
  const task = {
    id: rootId,
    root_id: rootId,
    title: plan.spec.title,
    assignee: 'planner',
  };
  const report = duplicateReport(input, fingerprintSpec, board, { mode: 'swarm', task: root, dryRun: false });
  pushSupervisorLog('info', `swarm created: ${rootId || plan.spec.title}`, {
    board,
    title: plan.spec.title,
    workers: swarmCreated.worker_ids || [],
    verifier: swarmCreated.verifier_id,
    synthesizer: swarmCreated.synthesizer_id,
    source: input.source || 'api',
    duplicate_report: safeDuplicateReport(report),
  });
  invalidateSummaryCache(board);
  resetSupervisorBackoff();
  supervisorTick('task-create').catch(() => {});
  return { created: true, board, mode: 'swarm', spec: plan.spec, swarm: plan.swarm, task, swarmCreated, duplicate_report: report };
}

async function createKanbanTask(input) {
  const board = cleanBoard(input.board || supervisor.board || 'codex-control');
  if (!board) throw new Error('invalid board slug');
  const spec = applyCapabilityPlan(await orchestrateTask({ ...input, board }), input, board);
  const shouldSwarm = shouldCreateSwarm(input, spec) || Boolean(spec.capabilityPlan?.swarmRecommended && requestedQueueMode(input) !== 'single');
  const plan = shouldSwarm
    ? buildSwarmPlan(input, spec, board)
    : { mode: 'task', spec };
  const fingerprintSpec = planFingerprintSpec(plan);
  if (input.dryRun) {
    const report = duplicateReport(input, fingerprintSpec, board, { dryRun: true, mode: plan.mode });
    pushSupervisorLog('info', `task dry-run duplicate preview: ${report.idempotency_key}`, {
      board,
      title: plan.spec.title,
      source: input.source || 'api',
      duplicate_report: safeDuplicateReport(report),
    });
    return { created: false, board, mode: plan.mode, spec: plan.spec, swarm: plan.swarm, duplicate_report: report };
  }
  if (plan.mode === 'swarm') {
    return createKanbanSwarm(input, board, plan);
  }
  const createArgs = [
    'kanban',
    '--board',
    board,
    'create',
    spec.title,
    '--body',
    spec.body,
    '--assignee',
    runtimeAssignee(spec.assignee),
    '--priority',
    String(spec.priority),
    '--workspace',
    spec.workspace,
    '--max-runtime',
    spec.maxRuntime,
    '--max-retries',
    String(spec.maxRetries),
    '--created-by',
    cleanText(input.createdBy || 'Codex Discord Orchestrator', 80),
    '--idempotency-key',
    idempotencyKey(input, fingerprintSpec, board),
    '--json',
  ];
  for (const skill of spec.skills) {
    createArgs.push('--skill', skill);
  }
  const output = await runHermesLong(createArgs, 60000);
  const task = JSON.parse(output);
  const report = duplicateReport(input, fingerprintSpec, board, { dryRun: false, mode: 'task', task });
  pushSupervisorLog('info', `task created: ${task.id || spec.title}`, {
    board,
    title: spec.title,
    assignee: spec.assignee,
    priority: spec.priority,
    source: input.source || 'api',
    duplicate_report: safeDuplicateReport(report),
  });
  invalidateSummaryCache(board);
  resetSupervisorBackoff();
  supervisorTick('task-create').catch(() => {});
  return { created: true, board, mode: 'task', spec, task, duplicate_report: report };
}

function sanitizeResumeText(raw) {
  return cleanText(raw, 4000)
    .split('\n')
    .map((line) => {
      if (/\b(TOKEN|SECRET|KEY|WEBHOOK|PASSWORD|COOKIE|AUTH|BEARER)\b/i.test(line) && /[:=]/.test(line)) {
        return line.replace(/([:=]\s*).+$/, '$1[provided/redacted]');
      }
      return line;
    })
    .join('\n');
}

async function resumeBlockedTask(input) {
  const board = cleanBoard(input.board || supervisor.board || 'codex-control');
  const taskId = safeTaskId(input.taskId || input.task || input.id);
  if (!board) throw new Error('invalid board slug');
  if (!taskId) throw new Error('invalid or missing task id');
  const userId = cleanText(input.userId || input.user || 'relay', 80);
  assertDiscordAllowed(userId);

  const content = sanitizeResumeText(input.content || input.detail || input.body || '');
  const lines = [
    'CODEX_USER_INPUT_RESPONSE',
    `task=${taskId}`,
    `from=${cleanText(input.username || userId || 'discord', 80)}`,
    '',
    content || 'User confirmed required information is available.',
  ].join('\n');

  await runHermesLong([
    'kanban',
    '--board',
    board,
    'comment',
    '--author',
    'discord-relay',
    taskId,
    lines,
  ], 60000);

  const shouldUnblock = boolValue(input.unblock, true);
  if (shouldUnblock) {
    await runHermesLong(['kanban', '--board', board, 'unblock', taskId], 60000);
  }
  pushSupervisorLog('info', `user input received: ${taskId}`, { board, unblocked: shouldUnblock });
  invalidateSummaryCache(board);
  if (shouldUnblock) {
    resetSupervisorBackoff();
    supervisorTick('user-input-resume').catch(() => {});
  }
  return { ok: true, board, taskId, unblocked: shouldUnblock };
}

function verifyDiscordRequest(req, rawBody) {
  if (!DISCORD_PUBLIC_KEY) return true;
  const signature = String(req.headers['x-signature-ed25519'] || '');
  const timestamp = String(req.headers['x-signature-timestamp'] || '');
  if (!/^[0-9a-f]{128}$/i.test(signature) || !timestamp) return false;
  const rawKey = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
  if (rawKey.length !== 32) return false;
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(
    null,
    Buffer.from(`${timestamp}${rawBody}`, 'utf8'),
    publicKey,
    Buffer.from(signature, 'hex'),
  );
}

function discordUserId(interaction) {
  return interaction?.member?.user?.id || interaction?.user?.id || '';
}

function assertDiscordAllowed(userId) {
  if (DISCORD_ALLOWED_USER_IDS.size && !DISCORD_ALLOWED_USER_IDS.has(userId)) {
    throw new Error('discord user is not allowed to create tasks');
  }
}

function discordOption(options, name) {
  for (const option of options || []) {
    if (option.name === name) return option.value;
    const nested = discordOption(option.options || [], name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function splitDiscordContent(content) {
  const text = cleanText(content, 8000);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    title: lines[0] || 'Discord task',
    detail: lines.slice(1).join('\n') || lines[0] || text,
  };
}

function discordInteractionInput(interaction) {
  const options = interaction?.data?.options || [];
  const content = discordOption(options, 'content');
  const split = content ? splitDiscordContent(content) : null;
  const title = discordOption(options, 'title') || discordOption(options, '제목') || split?.title;
  const detail = discordOption(options, 'detail') || discordOption(options, 'body')
    || discordOption(options, '상세지시') || split?.detail;
  return {
    title,
    detail,
    priority: discordOption(options, 'priority') || discordOption(options, '우선순위'),
    assignee: discordOption(options, 'assignee') || discordOption(options, 'profile') || discordOption(options, '담당'),
    board: discordOption(options, 'board') || 'codex-control',
    source: 'discord',
    sourceId: interaction?.id,
    discordInteractionId: interaction?.id,
    createdBy: `Discord:${discordUserId(interaction) || 'unknown'}`,
  };
}

async function sendDiscordFollowup(interaction, content) {
  if (!interaction?.application_id || !interaction?.token || typeof fetch !== 'function') return;
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: cleanText(content, 1900),
        allowed_mentions: { parse: [] },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`discord followup failed: ${response.status}`);
  }
}

async function processDiscordInteraction(interaction) {
  try {
    assertDiscordAllowed(discordUserId(interaction));
    const result = await createKanbanTask(discordInteractionInput(interaction));
    const workerIds = result.swarmCreated?.worker_ids || [];
    await sendDiscordFollowup(
      interaction,
      [
        `Task queued: ${result.task.id || result.spec.title}`,
        `Board: ${result.board}`,
        `Mode: ${result.mode || 'task'}`,
        `Assignee: ${result.spec.assignee}`,
        ...(workerIds.length ? [`Workers: ${workerIds.join(', ')}`] : []),
        `Priority: ${result.spec.priority}`,
        `Orchestrated: ${result.spec.orchestrated ? 'yes' : 'fallback'}`,
      ].join('\n'),
    );
  } catch (error) {
    pushSupervisorLog('error', `discord task failed: ${error.message || String(error)}`);
    await sendDiscordFollowup(interaction, `Task failed: ${error.message || String(error)}`).catch(() => {});
  }
}

function assertSharedSecret(req) {
  if (!DISCORD_SHARED_SECRET) {
    throw new HttpError(503, 'discord relay secret is not configured');
  }
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || String(req.headers['x-codex-secret'] || '');
  if (provided !== DISCORD_SHARED_SECRET) {
    throw new HttpError(403, 'invalid shared secret');
  }
}

function summarize(tasks) {
  const active = tasks.filter((task) => task.status !== 'archived');
  const done = active.filter((task) => task.status === 'done').length;
  const running = active.filter((task) => task.status === 'running');
  const ready = active.filter((task) => ['ready', 'todo', 'triage', 'scheduled'].includes(task.status));
  const blocked = active.filter((task) => task.status === 'blocked');
  const current = running[0] || ready[0] || blocked[0] || active[0] || null;
  const progressTotal = active.reduce((sum, task) => sum + taskProgress(task), 0);
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  return {
    total: active.length,
    done,
    running: running.length,
    ready: ready.length,
    blocked: blocked.length,
    archived: tasks.length - active.length,
    overallProgress: active.length ? clampProgress(progressTotal / active.length) : 0,
    currentTask: current ? { ...current, progress: taskProgress(current) } : null,
    counts,
  };
}

function dispatchableReadyCount(state) {
  return (state.tasks || []).filter((task) => task.status === 'ready').length;
}

async function loadBoardState(board) {
  let output;
  if (DASHBOARD_STATE_MODE === 'sqlite') {
    output = await readBoardSqlite(board);
  } else {
    const listArgs = [
      'kanban',
      '--board',
      board,
      'list',
      '--json',
    ];
    if (DASHBOARD_INCLUDE_ARCHIVED) listArgs.push('--archived');
    if (kanbanListSupportsSort) {
      try {
        output = await runHermes([...listArgs, '--sort', 'priority-desc']);
      } catch (error) {
        if (!/unrecognized arguments: --sort/.test(String(error.message || error))) throw error;
        kanbanListSupportsSort = false;
      }
    }
    if (!output) output = await runHermes(listArgs);
  }
  const rawTasks = JSON.parse(output);
  rawTasks.sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  const tasks = DASHBOARD_FAST_STATE
    ? rawTasks.map((task) => fastTaskActivity(task))
    : await Promise.all(rawTasks.map((task) => enrichTaskProgress(board, task)));
  const activeTasks = tasks.filter((task) => task.status !== 'archived');
  return {
    board,
    updatedAt: new Date().toISOString(),
    summary: summarize(tasks),
    tasks: activeTasks,
  };
}

function isRecoveryTask(task) {
  return /^Codex unblock:/i.test(task.title || '') || /CODEX_BLOCK_RECOVERY/.test(task.body || '');
}

function latestEventAt(details, kind) {
  const events = Array.isArray(details?.events) ? details.events : [];
  const matching = events.filter((event) => event.kind === kind).map((event) => Number(event.created_at || 0));
  return matching.length ? Math.max(...matching) : null;
}

function recoveryMarker(task, details) {
  const blockedAt = latestEventAt(details, 'blocked') || task.started_at || task.created_at || 'unknown';
  return `CODEX_BLOCK_RECOVERY task=${task.id} blocked_at=${blockedAt}`;
}

function userInputMarker(task, details) {
  const blockedAt = latestEventAt(details, 'blocked') || task.started_at || task.created_at || 'unknown';
  return `CODEX_USER_INPUT_REQUEST task=${task.id} blocked_at=${blockedAt}`;
}

function taskDetailsText(details) {
  const comments = Array.isArray(details?.comments) ? details.comments : [];
  const events = Array.isArray(details?.events) ? details.events : [];
  return [
    details?.latest_summary || '',
    ...comments.map((comment) => comment.body || ''),
    ...events.map((event) => `${event.kind} ${JSON.stringify(event.payload || {})}`),
  ].join('\n');
}

function recoveryAlreadyQueued(tasks, marker) {
  return tasks.some((task) => task.status !== 'archived' && task.status !== 'done' && String(task.body || '').includes(marker));
}

async function loadTaskDetails(board, taskId) {
  const output = DASHBOARD_STATE_MODE === 'sqlite'
    ? await readTaskDetailsSqlite(board, taskId)
    : await runHermes(['kanban', '--board', board, 'show', '--json', taskId]);
  return JSON.parse(output);
}

function runFinishedAt(run) {
  return Number(run?.ended_at || run?.endedAt || run?.finished_at || run?.started_at || 0) || 0;
}

function isSystemicWorkerFailure(run) {
  const status = String(run?.status || '').toLowerCase();
  const outcome = String(run?.outcome || '').toLowerCase();
  if (!['blocked', 'crashed', 'error', 'failed'].includes(status) && !['crashed', 'error', 'failed'].includes(outcome)) {
    return false;
  }
  const failureText = [run?.error, run?.summary].filter(Boolean).join('\n');
  return SYSTEMIC_WORKER_FAILURE_RE.test(failureText);
}

function taskHasSystemicWorkerFailure(details) {
  const runs = Array.isArray(details?.runs) ? details.runs : [];
  return runs.some(isSystemicWorkerFailure);
}

function recoverySkipMarker(task, details) {
  const blockedAt = latestEventAt(details, 'blocked') || task.started_at || task.created_at || 'unknown';
  return `CODEX_RECOVERY_SKIPPED_SYSTEMIC_WORKER task=${task.id} blocked_at=${blockedAt}`;
}

async function evaluateSupervisorHealthGate(board, state) {
  if (!SUPERVISOR_HEALTH_GATE_ENABLED) {
    return { active: false, reason: 'disabled', count: 0, threshold: SUPERVISOR_CRASH_STORM_THRESHOLD };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const blocked = (state.tasks || [])
    .filter((task) => task.status === 'blocked')
    .sort((a, b) => Number(b.started_at || b.created_at || 0) - Number(a.started_at || a.created_at || 0))
    .slice(0, SUPERVISOR_CRASH_STORM_SCAN_LIMIT);
  const failures = [];
  for (const task of blocked) {
    let details;
    try {
      details = await loadTaskDetails(board, task.id);
    } catch (error) {
      pushSupervisorLog('error', `health gate inspect failed: ${task.id} ${error.message || String(error)}`);
      continue;
    }
    const runs = Array.isArray(details?.runs) ? details.runs : [];
    const failedRun = runs.find((run) => {
      const finishedAt = runFinishedAt(run);
      if (!finishedAt || nowSeconds - finishedAt > SUPERVISOR_CRASH_STORM_WINDOW_SECONDS) return false;
      return isSystemicWorkerFailure(run);
    });
    if (failedRun) {
      failures.push({
        id: task.id,
        assignee: task.assignee || '',
        profile: failedRun.profile || task.assignee || '',
      });
    }
  }
  if (failures.length < SUPERVISOR_CRASH_STORM_THRESHOLD) {
    return {
      active: false,
      reason: 'healthy',
      count: failures.length,
      threshold: SUPERVISOR_CRASH_STORM_THRESHOLD,
      windowSeconds: SUPERVISOR_CRASH_STORM_WINDOW_SECONDS,
      tasks: failures,
    };
  }
  return {
    active: true,
    reason: 'worker_crash_storm',
    message: `${failures.length} recent systemic worker crashes; recovery paused; dispatch limited to half-open probes`,
    count: failures.length,
    threshold: SUPERVISOR_CRASH_STORM_THRESHOLD,
    windowSeconds: SUPERVISOR_CRASH_STORM_WINDOW_SECONDS,
    tasks: failures,
  };
}

function updateSupervisorHealthGate(gate) {
  const prior = supervisor.healthGate || { active: false };
  supervisor.healthGate = gate || { active: false, reason: 'unknown', count: 0 };
  if (supervisor.healthGate.active) {
    const key = `${supervisor.healthGate.reason}:${supervisor.healthGate.count}:${(supervisor.healthGate.tasks || []).map((task) => task.id).join(',')}`;
    if (key !== supervisor.lastHealthGateKey) {
      pushSupervisorLog('warning', `health gate active: ${supervisor.healthGate.message}`);
      supervisor.lastHealthGateKey = key;
    }
  } else if (prior.active) {
    pushSupervisorLog('info', 'health gate cleared');
    supervisor.lastHealthGateKey = '';
  }
}

async function createBlockedRecoveryTask(board, task, details, marker) {
  const reason = cleanText(details?.latest_summary || 'No blocked summary was provided.', 1200);
  const latest = cleanText(taskDetailsText(details).replace(/\s+/g, ' '), 2400);
  const body = [
    'Source: codex-block-recovery',
    marker,
    '',
    `Blocked task: ${task.id}`,
    `Original title: ${task.title}`,
    `Original assignee: ${task.assignee || '-'}`,
    `Blocked reason: ${reason}`,
    '',
    'Codex recovery protocol:',
    '1. Read the original task context, comments, run history, and worker log.',
    '2. Classify the blocker as environment, dependency, permission, test failure, missing input, or review-required.',
    '3. Fix the root cause when it is safe to do so. Do not repeat the same failing command blindly.',
    '4. If the original acceptance criteria are already satisfied, complete the original task with evidence.',
    '5. If the blocker is fixed but work remains, unblock the original task and add a concrete next-step comment.',
    '6. If it cannot be fixed, leave the original task blocked with the exact remaining blocker.',
    '',
    'Required final action:',
    `- Run one of: hermes kanban --board ${board} complete ${task.id} OR hermes kanban --board ${board} unblock ${task.id}`,
    '- Add a comment to the original task explaining the decision.',
    '',
    `Recent blocked context: ${latest}`,
  ].join('\n');
  const priority = Math.min(100, Math.max(80, Number(task.priority || 0) + 20));
  const output = await runHermesLong([
    'kanban',
    '--board',
    board,
    'create',
    `Codex unblock: ${task.title}`,
    '--body',
    body,
    '--assignee',
    runtimeAssignee(supervisor.recoveryAssignee),
    '--priority',
    String(priority),
    '--workspace',
    'scratch',
    '--max-runtime',
    '30m',
    '--max-retries',
    '2',
    '--created-by',
    'Codex blocked-task supervisor',
    '--idempotency-key',
    `codex-block-recovery:${marker}`,
    '--json',
  ], 60000);
  return JSON.parse(output);
}

async function processBlockedRecoveries(board, state, options = {}) {
  if (!supervisor.blockedRecovery) return 0;
  const annotateOnly = Boolean(options.annotateOnly);
  let created = 0;
  for (const task of state.tasks) {
    try {
      if (task.status !== 'blocked' || isRecoveryTask(task)) continue;
      const details = await loadTaskDetails(board, task.id);
      if (taskHasSystemicWorkerFailure(details)) {
        const marker = recoverySkipMarker(task, details);
        if (!taskDetailsText(details).includes(marker)) {
          await runHermesLong([
            'kanban',
            '--board',
            board,
            'comment',
            '--author',
            'codex-supervisor',
            task.id,
            `${marker} status=skipped policy=no_recovery_for_systemic_worker_failure`,
          ], 60000);
          pushSupervisorLog('warning', `blocked recovery skipped for systemic worker failure: ${task.id}`, {
            task: task.id,
          });
        }
        continue;
      }
      const blockInfo = userInputBlockInfo(task, details);
      if (blockInfo.needsUserInput) {
        const marker = userInputMarker(task, details);
        if (!taskDetailsText(details).includes(marker)) {
          const required = blockInfo.requiredInputs.length
            ? blockInfo.requiredInputs.map((item) => `${item.name}${item.secret ? ' secret' : ''}`).join(', ')
            : 'unspecified required user input';
          await runHermesLong([
            'kanban',
            '--board',
            board,
            'comment',
            '--author',
            'codex-supervisor',
            task.id,
            `${marker} status=waiting_for_user_input required=${required}`,
          ], 60000);
          pushSupervisorLog('info', `waiting for user input: ${task.id}`, {
            task: task.id,
            required: blockInfo.requiredInputs,
          });
        }
        continue;
      }
      if (annotateOnly) continue;
      const marker = recoveryMarker(task, details);
      if (taskDetailsText(details).includes(marker) || recoveryAlreadyQueued(state.tasks, marker)) {
        continue;
      }
      const recovery = await createBlockedRecoveryTask(board, task, details, marker);
      const recoveryId = recovery.id || recovery.task_id || recovery.task?.id || 'created';
      await runHermesLong([
        'kanban',
        '--board',
        board,
        'comment',
        '--author',
        'codex-supervisor',
        task.id,
        `${marker} recovery_task=${recoveryId} status=queued policy=fix-unblock-or-complete`,
      ], 60000);
      pushSupervisorLog('info', `blocked recovery queued: ${task.id} -> ${recoveryId}`, {
        task: task.id,
        recovery: recoveryId,
        assignee: supervisor.recoveryAssignee,
      });
      created += 1;
    } catch (error) {
      pushSupervisorLog('error', `blocked recovery failed for ${task.id}: ${error.message || String(error)}`);
    }
  }
  return created;
}

function pushSupervisorLog(level, message, details = null) {
  supervisor.logs.unshift({
    level,
    message,
    details,
    at: new Date().toISOString(),
  });
  supervisor.logs = supervisor.logs.slice(0, MAX_SUPERVISOR_LOGS);
}

function detectTransitions(tasks) {
  let changed = false;
  for (const task of tasks) {
    const prior = supervisor.seenStatuses.get(task.id);
    if (prior && prior !== task.status) {
      changed = true;
      pushSupervisorLog('info', `${task.id} ${prior} -> ${task.status}`, {
        title: task.title,
        assignee: task.assignee,
      });
    }
    supervisor.seenStatuses.set(task.id, task.status);
  }
  if (changed) invalidateSummaryCache(supervisor.board);
  return changed;
}

function resetSupervisorBackoff() {
  supervisor.currentIntervalMs = supervisor.intervalMs;
  supervisor.idleBackoffStreak = 0;
}

function updateSupervisorBackoff(state) {
  const summary = state?.summary || {};
  const idle = Number(summary.ready || 0) === 0
    && Number(summary.running || 0) === 0
    && Number(summary.blocked || 0) === 0;
  if (!idle) {
    resetSupervisorBackoff();
    return;
  }
  const priorIntervalMs = Math.max(supervisor.intervalMs, supervisor.currentIntervalMs || supervisor.intervalMs);
  const nextIntervalMs = supervisor.idleBackoffStreak === 0
    ? Math.max(supervisor.intervalMs, SUPERVISOR_IDLE_BACKOFF_INITIAL_MS)
    : priorIntervalMs * 2;
  supervisor.idleBackoffStreak += 1;
  supervisor.currentIntervalMs = Math.min(SUPERVISOR_IDLE_BACKOFF_MAX_MS, nextIntervalMs);
}

function supervisorSnapshot() {
  return publicSupervisorSnapshot();
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function healthGateProbeDecision(state) {
  if (!supervisor.healthGate?.active) return { allowed: true, reason: 'gate inactive' };
  if (Number(state.summary.running || 0) > 0) {
    return { allowed: false, reason: `running=${state.summary.running}` };
  }
  const dispatchableReady = dispatchableReadyCount(state);
  if (dispatchableReady <= 0) {
    return { allowed: false, reason: 'no dispatchable ready task' };
  }
  const lastProbeMs = supervisor.lastHealthGateProbeAt ? Date.parse(supervisor.lastHealthGateProbeAt) : 0;
  const waitMs = SUPERVISOR_HEALTH_GATE_PROBE_INTERVAL_SECONDS * 1000;
  const elapsedMs = lastProbeMs ? Date.now() - lastProbeMs : Infinity;
  if (elapsedMs < waitMs) {
    const remaining = Math.ceil((waitMs - elapsedMs) / 1000);
    return { allowed: false, reason: `probe backoff ${remaining}s` };
  }
  return { allowed: true, reason: `half-open probe after ${SUPERVISOR_HEALTH_GATE_PROBE_INTERVAL_SECONDS}s backoff` };
}

function scheduleSupervisor() {
  clearTimeout(supervisor.timer);
  supervisor.timer = null;
  supervisor.nextTickAt = null;
  if (!supervisor.enabled) return;
  const delayMs = supervisor.currentIntervalMs || supervisor.intervalMs;
  supervisor.nextTickAt = new Date(Date.now() + delayMs).toISOString();
  supervisor.timer = setTimeout(() => {
    supervisorTick('timer').catch(() => {});
  }, delayMs);
}

async function supervisorTick(reason = 'manual') {
  if (reason === 'manual') invalidateSummaryCache(supervisor.board);
  if (supervisor.runningTick) {
    return supervisorSnapshot();
  }
  let latestState = null;
  supervisor.runningTick = true;
  supervisor.lastTickAt = new Date().toISOString();
  supervisor.nextTickAt = null;
  try {
    let state = await loadBoardState(supervisor.board);
    latestState = state;
    setSummaryCache(supervisor.board, state);
    supervisor.lastSummary = state.summary;
    supervisor.lastError = null;
    detectTransitions(state.tasks);

    if (supervisor.enabled) {
      updateSupervisorHealthGate(await evaluateSupervisorHealthGate(supervisor.board, state));
      const gateActive = Boolean(supervisor.healthGate?.active);
      const recoveryCreated = await processBlockedRecoveries(supervisor.board, state, { annotateOnly: gateActive });
      if (recoveryCreated) {
        state = await loadBoardState(supervisor.board);
        latestState = state;
        setSummaryCache(supervisor.board, state);
        supervisor.lastSummary = state.summary;
        detectTransitions(state.tasks);
      }

      let availableSlots = Math.max(0, supervisor.concurrency - state.summary.running);
      let failureLimit = supervisor.failureLimit;
      if (gateActive) {
        const probe = healthGateProbeDecision(state);
        if (!probe.allowed) {
          if (!/^probe backoff /.test(probe.reason)) {
            pushSupervisorLog('debug', `health gate pause: ${probe.reason}`);
          }
          return supervisorSnapshot();
        }
        availableSlots = Math.min(1, availableSlots);
        failureLimit = 1;
        supervisor.lastHealthGateProbeAt = new Date().toISOString();
        pushSupervisorLog('warning', `health gate half-open probe dispatch allowed: ${probe.reason}`);
      }

      const dispatchableReady = dispatchableReadyCount(state);
      const dispatchSlots = Math.min(availableSlots, dispatchableReady);
      if (dispatchSlots > 0) {
        const output = await runHermes([
          'kanban',
          '--board',
          supervisor.board,
          'dispatch',
          '--max',
          String(dispatchSlots),
          '--failure-limit',
          String(failureLimit),
          '--json',
        ]);
        const dispatch = JSON.parse(output);
        supervisor.lastDispatch = dispatch;
        supervisor.lastError = null;
        const spawned = (dispatch.spawned || []).map((task) => task.task_id).join(', ') || 'none';
        pushSupervisorLog('info', `dispatch ${reason}: slots=${dispatchSlots}, spawned=${spawned}`, dispatch);
        invalidateSummaryCache(supervisor.board);
        resetSupervisorBackoff();
      } else {
        pushSupervisorLog('debug', `tick ${reason}: running=${state.summary.running}, ready=${state.summary.ready}, dispatchable_ready=${dispatchableReady}`);
      }
    } else {
      pushSupervisorLog('debug', `tick ${reason}: monitor only`);
    }
  } catch (error) {
    supervisor.lastError = error.message || String(error);
    pushSupervisorLog('error', supervisor.lastError);
  } finally {
    if (supervisor.enabled && latestState) updateSupervisorBackoff(latestState);
    supervisor.runningTick = false;
    scheduleSupervisor();
  }
  return supervisorSnapshot();
}

function startSupervisor(config) {
  const board = cleanBoard(config.board || supervisor.board);
  if (!board) throw new Error('invalid board slug');
  supervisor.board = board;
  supervisor.concurrency = clampInt(config.concurrency, supervisor.concurrency, 1, 8);
  supervisor.intervalMs = clampInt(config.intervalMs, supervisor.intervalMs, 5000, 60000);
  resetSupervisorBackoff();
  supervisor.failureLimit = clampInt(config.failureLimit, supervisor.failureLimit, 1, 10);
  supervisor.blockedRecovery = boolValue(config.blockedRecovery, supervisor.blockedRecovery);
  supervisor.recoveryAssignee = cleanProfile(config.recoveryAssignee, supervisor.recoveryAssignee);
  supervisor.enabled = true;
  supervisor.startedAt = new Date().toISOString();
  pushSupervisorLog('info', `supervisor started on ${supervisor.board}`);
  supervisorTick('start').catch(() => {});
  return supervisorSnapshot();
}

function stopSupervisor() {
  supervisor.enabled = false;
  supervisor.nextTickAt = null;
  clearTimeout(supervisor.timer);
  supervisor.timer = null;
  pushSupervisorLog('info', 'supervisor stopped');
  return supervisorSnapshot();
}

function staticBoards() {
  return DASHBOARD_BOARDS.map((slug) => ({
    slug,
    current: slug === SUPERVISOR_DEFAULT_BOARD,
  }));
}

async function listBoards() {
  const output = await runHermes(['kanban', 'boards', 'list']);
  const boards = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([●*]?\s*)?([A-Za-z0-9._-]+)\s{2,}(.+?)\s{2,}/);
    if (match && !['SLUG'].includes(match[2])) {
      boards.push({ slug: match[2], current: line.includes('●') });
    }
  }
  return boards;
}

async function apiState(req, res) {
  assertControlAuth(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const board = cleanBoard(url.searchParams.get('board'));
  if (!board) {
    errJson(res, 400, 'invalid board slug');
    return;
  }
  okJson(res, await loadBoardState(board));
}

async function apiSummary(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const board = cleanBoard(url.searchParams.get('board'));
  if (!board) {
    errJson(res, 400, 'invalid board slug');
    return;
  }
  okJson(res, await loadCachedSummary(board));
}

function apiHealth(req, res) {
  okJson(res, {
    ok: true,
    service: 'codex-control-dashboard',
    csrf_token: CONTROL_CSRF_TOKEN,
    interactions_enabled: DISCORD_INTERACTIONS_ENABLED,
  });
}

async function apiSupervisor(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET') {
    okJson(res, supervisorSnapshot());
    return;
  }
  if (req.method !== 'POST') {
    errJson(res, 405, 'method not allowed');
    return;
  }
  assertControlAuth(req);
  if (/^(1|true|yes|on)$/i.test(String(url.searchParams.get('dryRun') || ''))) {
    okJson(res, { ...supervisorSnapshot(), dryRun: true });
    return;
  }
  const body = await readJson(req);
  if (url.pathname === '/api/supervisor/start') {
    okJson(res, startSupervisor(body));
    return;
  }
  if (url.pathname === '/api/supervisor/stop') {
    okJson(res, stopSupervisor());
    return;
  }
  if (url.pathname === '/api/supervisor/tick') {
    okJson(res, await supervisorTick('manual'));
    return;
  }
  errJson(res, 404, 'not found');
}

async function apiTasks(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== 'POST') {
    errJson(res, 405, 'method not allowed');
    return;
  }
  if (url.pathname !== '/api/tasks/create') {
    errJson(res, 404, 'not found');
    return;
  }
  assertControlAuth(req);
  okJson(res, await createKanbanTask(await readJson(req)));
}

async function apiDiscord(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== 'POST') {
    errJson(res, 405, 'method not allowed');
    return;
  }

  if (url.pathname === '/api/discord/task') {
    assertSharedSecret(req);
    const body = await readJson(req);
    const split = body.content && !body.title ? splitDiscordContent(body.content) : {};
    const userId = cleanText(body.userId || body.user || 'relay', 80);
    assertDiscordAllowed(userId);
    okJson(res, await createKanbanTask({
      ...body,
      title: body.title || split.title,
      detail: body.detail || body.body || split.detail,
      board: body.board || 'codex-control',
      source: 'discord-relay',
      sourceId: body.messageId || body.id,
      createdBy: `Discord:${userId}`,
    }));
    return;
  }

  if (url.pathname === '/api/discord/resume') {
    assertSharedSecret(req);
    okJson(res, await resumeBlockedTask(await readJson(req)));
    return;
  }

  if (url.pathname === '/api/discord/interactions') {
    if (!DISCORD_INTERACTIONS_ENABLED) {
      errJson(res, 404, 'discord interactions disabled');
      return;
    }
    const rawBody = await readBody(req);
    if (!verifyDiscordRequest(req, rawBody)) {
      errJson(res, 401, 'invalid request signature');
      return;
    }
    const interaction = parseJson(rawBody);
    if (interaction.type === 1) {
      okJson(res, { type: 1 });
      return;
    }
    if (interaction.type === 2) {
      try {
        assertDiscordAllowed(discordUserId(interaction));
      } catch (error) {
        okJson(res, {
          type: 4,
          data: {
            flags: 64,
            content: error.message || String(error),
            allowed_mentions: { parse: [] },
          },
        });
        return;
      }
      processDiscordInteraction(interaction).catch(() => {});
      okJson(res, {
        type: 5,
        data: {
          flags: 64,
        },
      });
      return;
    }
    okJson(res, {
      type: 4,
      data: {
        flags: 64,
        content: 'Unsupported Discord interaction type.',
        allowed_mentions: { parse: [] },
      },
    });
    return;
  }

  errJson(res, 404, 'not found');
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(file);
    const type =
      ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/health')) {
      apiHealth(req, res);
      return;
    }
    if (req.url.startsWith('/api/summary')) {
      await apiSummary(req, res);
      return;
    }
    if (req.url.startsWith('/api/state')) {
      await apiState(req, res);
      return;
    }
    if (req.url.startsWith('/api/boards')) {
      okJson(res, { boards: staticBoards() });
      return;
    }
    if (req.url.startsWith('/api/supervisor')) {
      await apiSupervisor(req, res);
      return;
    }
    if (req.url.startsWith('/api/tasks')) {
      await apiTasks(req, res);
      return;
    }
    if (req.url.startsWith('/api/discord')) {
      await apiDiscord(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    const status = Number(error.status || 500);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Codex Hermes Kanban dashboard: http://${HOST}:${PORT}`);
    if (SUPERVISOR_AUTO_START) {
      try {
        startSupervisor({
          board: SUPERVISOR_DEFAULT_BOARD,
          concurrency: supervisor.concurrency,
          intervalMs: supervisor.intervalMs,
          failureLimit: supervisor.failureLimit,
          blockedRecovery: supervisor.blockedRecovery,
          recoveryAssignee: supervisor.recoveryAssignee,
        });
      } catch (error) {
        console.error(`supervisor auto-start failed: ${error.message || String(error)}`);
      }
    }
  });
}

module.exports = {
  server,
  __test: {
    supervisor,
    loadCachedSummary,
    invalidateSummaryCache,
    clearSummaryCache: () => summaryCache.clear(),
    setLoadBoardStateForTest: (fn) => { loadBoardStateForTest = fn; },
    restoreLoadBoardState: () => { loadBoardStateForTest = null; },
    resetSupervisorBackoff,
    updateSupervisorBackoff,
    idempotencyKey,
    duplicateReport,
    fingerprintComponents,
    planFingerprintSpec,
  },
};
