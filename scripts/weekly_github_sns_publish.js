#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const STATUS_VALUES = new Set([
  'draft',
  'pending_review',
  'approved',
  'denied',
  'expired',
  'dry_run',
  'inflight',
  'posted',
  'failed',
  'blocked',
  'needs_reapproval',
  'reconcile_required',
  'compose_ready',
  'compose_opened',
  'awaiting_user_post',
  'user_confirmed_posted',
  'abandoned',
]);

const DEFAULT_TARGETS = ['linkedin', 'x', 'facebook', 'instagram'];
const MANUAL_COMPOSE_TARGETS = new Set(['linkedin', 'x', 'facebook', 'instagram']);
const DEFAULT_LIMITS = {
  x: Number(process.env.SNS_X_WEIGHTED_LIMIT || 260),
  linkedin: Number(process.env.SNS_LINKEDIN_TEXT_LIMIT || 1200),
  facebook: Number(process.env.SNS_FACEBOOK_TEXT_LIMIT || 1200),
  instagram: Number(process.env.SNS_INSTAGRAM_CAPTION_LIMIT || 1200),
};
const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /gh[pousr]_[A-Za-z0-9_]{12,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+/ig,
  /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/ig,
  /(?:authorization|bearer|token|secret|api[_-]?key|client_secret)\s*[:=]\s*[^ \n\r;]+/ig,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/ig;
const PRIVATE_PATH_RE = /\b(?:\/home\/|\/mnt\/|C:\\Users\\)[^\s)'"<>]+/ig;

function defaultStateDir() {
  const base = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  return process.env.SNS_AUTOMATION_STATE_DIR || path.join(base, 'state', 'weekly-github-sns');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cleanText(raw, maxLength = 4000) {
  return String(raw || '').replace(/\r\n/g, '\n').replace(/\s+\n/g, '\n').trim().slice(0, maxLength);
}

function sanitizeText(raw, maxLength = 4000) {
  let text = cleanText(raw, maxLength);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text.replace(EMAIL_RE, '[redacted-email]');
  text = text.replace(PRIVATE_PATH_RE, '[redacted-path]');
  text = text.replace(/https?:\/\/[^/\s:@]+:[^@\s]+@[^\s]+/g, '[redacted-url]');
  return text.slice(0, maxLength);
}

function redactCount(raw) {
  const before = cleanText(raw, 20000);
  const after = sanitizeText(before, 20000);
  return before === after ? 0 : 1;
}

function normalizeTargets(rawTargets) {
  const raw = Array.isArray(rawTargets) ? rawTargets.join(',') : String(rawTargets || DEFAULT_TARGETS.join(','));
  const targets = raw
    .split(',')
    .map((target) => target.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(targets)].filter((target) => DEFAULT_TARGETS.includes(target));
}

function parseDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO date: ${value}`);
  return date;
}

function computeScheduledWindow({ scheduledAt, previousWindowUntil }) {
  const until = parseDate(scheduledAt);
  const previous = previousWindowUntil ? parseDate(previousWindowUntil, null) : null;
  const since = previous && previous < until
    ? previous
    : new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (since >= until) throw new Error('scheduled window since must be before until');
  return {
    since: since.toISOString(),
    until: until.toISOString(),
  };
}

function approvalTokenHash(runId, token) {
  return sha256(`${runId}:${token}`);
}

function makeApprovalToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function ensureStateDir(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

function ledgerPath(stateDir) {
  return path.join(stateDir, 'ledger.json');
}

function auditPath(stateDir) {
  return path.join(stateDir, 'audit.jsonl');
}

function loadLedger(stateDir = defaultStateDir()) {
  try {
    const data = JSON.parse(fs.readFileSync(ledgerPath(stateDir), 'utf8'));
    return {
      cursor: data.cursor || {},
      runs: Array.isArray(data.runs) ? data.runs : [],
    };
  } catch {
    return { cursor: {}, runs: [] };
  }
}

function saveLedger(stateDir, ledger) {
  ensureStateDir(stateDir);
  const file = ledgerPath(stateDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appendAudit(stateDir, event) {
  ensureStateDir(stateDir);
  const allowed = {
    at: new Date().toISOString(),
    event: sanitizeText(event.event, 64),
    run_id: sanitizeText(event.run_id, 80),
    scheduled_window: event.scheduled_window || null,
    draft_hash: sanitizeText(event.draft_hash, 80),
    approval_method: sanitizeText(event.approval_method, 40),
    approver_hash: sanitizeText(event.approver_hash, 80),
    targets: Array.isArray(event.targets) ? event.targets.map((target) => sanitizeText(target, 32)) : [],
    idempotency_key: sanitizeText(event.idempotency_key, 200),
    provider_post_id: sanitizeText(event.provider_post_id, 120),
    retry_count: Number(event.retry_count || 0),
    sanitized_error_class: sanitizeText(event.sanitized_error_class, 40),
  };
  fs.appendFileSync(auditPath(stateDir), `${JSON.stringify(allowed)}\n`, { mode: 0o600 });
}

async function withLock(stateDir, fn) {
  ensureStateDir(stateDir);
  const file = path.join(stateDir, 'ledger.lock');
  let handle;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      handle = fs.openSync(file, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!handle) throw new Error('state ledger lock timeout');
  try {
    return await fn();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(file, { force: true });
  }
}

function classifyError(error) {
  const text = String(error && (error.message || error) || '').toLowerCase();
  if (/timeout|timed out|abort/.test(text)) return 'timeout';
  if (/rate.?limit|quota|429/.test(text)) return 'rate_limit';
  if (/permission|denied|unauthorized|forbidden|401|403/.test(text)) return 'permission';
  if (/network|fetch|econn|socket|dns/.test(text)) return 'network';
  if (/missing|required|not found/.test(text)) return 'missing_dependency';
  return 'error';
}

function weightedLength(text) {
  const withoutUrls = String(text || '').replace(URL_RE, ' '.repeat(23));
  let length = 0;
  for (const char of withoutUrls) {
    const code = char.codePointAt(0);
    length += code > 0x10ff ? 2 : 1;
  }
  return length;
}

function fitWeightedText(text, limit) {
  const clean = sanitizeText(text, 5000);
  if (weightedLength(clean) <= limit) return clean;
  let output = '';
  for (const char of clean) {
    const candidate = `${output}${char}`;
    if (weightedLength(`${candidate}...`) > limit) break;
    output = candidate;
  }
  return `${output.trimEnd()}...`;
}

function truncateText(text, limit) {
  const clean = sanitizeText(text, 5000);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function repoSlugFromRemote(remote) {
  const text = String(remote || '').trim();
  const match = text.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, '') : 'local/repository';
}

function isConfiguredPrivateRepo(repo) {
  const privateRepos = String(process.env.SNS_GITHUB_PRIVATE_REPOS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return privateRepos.includes(String(repo || '').toLowerCase());
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60000, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message || '').trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function collectGitMetadata({ since, until, cwd = process.cwd() }) {
  const remote = await execFileText('git', ['config', '--get', 'remote.origin.url'], { cwd }).catch(() => '');
  const repo = repoSlugFromRemote(remote);
  const privateRepo = isConfiguredPrivateRepo(repo);
  const output = await execFileText('git', [
    'log',
    `--since=${since}`,
    `--until=${until}`,
    '--date=iso-strict',
    '--pretty=format:%H%x00%ad%x00%s',
  ], { cwd }).catch(() => '');
  const commits = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split('\0');
      return {
        repo,
        sha: sanitizeText(sha, 80),
        short_sha: sanitizeText(sha, 12),
        date: sanitizeText(date, 40),
        subject: sanitizeText(subject, 300),
        private: privateRepo,
        source: 'git-metadata',
      };
    });
  return commits;
}

function githubRequest(pathname, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: pathname,
      method: 'GET',
      headers: {
        'accept': 'application/vnd.github+json',
        'user-agent': 'HermesWeeklySns/0.1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      timeout: 20000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function collectGitHubApiMetadata({ repos, since, until, token, requester = githubRequest }) {
  if (!token || !repos.length) return [];
  const items = [];
  for (const repo of repos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue;
    let privateRepo = isConfiguredPrivateRepo(repo);
    try {
      const repoInfo = await requester(`/repos/${repo}`, token);
      privateRepo = privateRepo || Boolean(repoInfo?.private);
    } catch {
      privateRepo = true;
    }
    const query = new URLSearchParams({ since, until, per_page: '100' });
    const commits = await requester(`/repos/${repo}/commits?${query}`, token);
    for (const commit of commits || []) {
      items.push({
        repo,
        sha: sanitizeText(commit.sha, 80),
        short_sha: sanitizeText(commit.sha, 12),
        date: sanitizeText(commit.commit?.author?.date, 40),
        subject: sanitizeText(String(commit.commit?.message || '').split('\n')[0], 300),
        private: privateRepo,
        source: 'github-api',
      });
    }
  }
  return items;
}

async function collectCommits(options) {
  if (Array.isArray(options.commits)) return options.commits;
  const repos = String(options.repos || process.env.SNS_GITHUB_REPOS || process.env.GITHUB_REPOSITORY_SLUGS || '')
    .split(',')
    .map((repo) => repo.trim())
    .filter(Boolean);
  try {
    const apiCommits = await collectGitHubApiMetadata({
      repos,
      since: options.window.since,
      until: options.window.until,
      token: process.env.GITHUB_TOKEN || '',
    });
    if (apiCommits.length) return apiCommits;
  } catch {}
  return collectGitMetadata({ since: options.window.since, until: options.window.until, cwd: options.cwd || process.cwd() });
}

function sanitizeCommits(commits, allowPrivate = false) {
  let redactions = 0;
  const sanitized = [];
  for (const item of commits || []) {
    const privateRepo = Boolean(item.private);
    const subject = sanitizeText(item.subject || item.message || '', 220);
    redactions += redactCount(item.subject || item.message || '');
    sanitized.push({
      repo: privateRepo && !allowPrivate ? '[private-repo]' : sanitizeText(item.repo || 'unknown/repo', 120),
      short_sha: sanitizeText(item.short_sha || item.sha || '', 12),
      date: sanitizeText(item.date || '', 40),
      subject: privateRepo && !allowPrivate ? 'redacted internal work' : subject,
      private: privateRepo,
      source: sanitizeText(item.source || 'unknown', 40),
      blocked: privateRepo && !allowPrivate,
    });
  }
  return { commits: sanitized, redactions };
}

function summarizeCommits(commits) {
  const visible = commits.filter((commit) => !commit.blocked);
  const byRepo = new Map();
  for (const commit of visible) {
    byRepo.set(commit.repo, (byRepo.get(commit.repo) || 0) + 1);
  }
  const topSubjects = visible.slice(0, 5).map((commit) => commit.subject).filter(Boolean);
  return {
    commit_count: visible.length,
    blocked_count: commits.length - visible.length,
    repo_counts: [...byRepo.entries()].map(([repo, count]) => ({ repo, count })),
    top_subjects: topSubjects,
  };
}

function baseSummaryText(summary, window) {
  const repos = summary.repo_counts.map((item) => `${item.repo} ${item.count}`).join(', ') || 'no public commits';
  const bullets = summary.top_subjects.map((subject) => `- ${subject}`).join('\n');
  return [
    `Weekly GitHub update (${window.since.slice(0, 10)} to ${window.until.slice(0, 10)})`,
    `${summary.commit_count} public commit(s) across ${summary.repo_counts.length} repo(s): ${repos}.`,
    bullets ? `Highlights:\n${bullets}` : 'No public commit highlights found.',
    summary.blocked_count ? `${summary.blocked_count} private/internal item(s) were excluded.` : '',
  ].filter(Boolean).join('\n');
}

function buildDrafts({ summary, window, targets }) {
  const base = baseSummaryText(summary, window);
  const drafts = {};
  for (const target of targets) {
    if (target === 'x') {
      const oneLine = `${summary.commit_count} public GitHub commit(s) this week. ${summary.top_subjects[0] || 'Maintenance and automation updates.'} #buildinpublic`;
      drafts[target] = {
        text: fitWeightedText(oneLine, DEFAULT_LIMITS.x),
        weighted_length: weightedLength(fitWeightedText(oneLine, DEFAULT_LIMITS.x)),
        mode: process.env.SNS_X_PUBLISH_ENABLED === '1' ? 'publish' : 'dry-run',
      };
    } else if (target === 'linkedin') {
      drafts[target] = {
        text: truncateText(`${base}\n\nBuilt with an approval-first automation pipeline.`, DEFAULT_LIMITS.linkedin),
        mode: process.env.SNS_LINKEDIN_PUBLISH_ENABLED === '1' ? 'publish' : 'dry-run',
      };
    } else if (target === 'facebook') {
      drafts[target] = {
        text: truncateText(base, DEFAULT_LIMITS.facebook),
        mode: process.env.SNS_FACEBOOK_PUBLISH_ENABLED === '1' ? 'publish' : 'dry-run',
        note: 'Facebook Page API publishing requires a Page access token with approved Page permissions.',
      };
    } else if (target === 'instagram') {
      drafts[target] = {
        text: truncateText(base, DEFAULT_LIMITS.instagram),
        mode: process.env.SNS_INSTAGRAM_PUBLISH_ENABLED === '1' ? 'publish' : 'dry-run',
        note: 'Instagram API publishing requires a Professional account, linked Page, permissions, and a public media URL.',
      };
    }
  }
  return drafts;
}

function platformAccount(target) {
  if (target === 'linkedin') return process.env.SNS_LINKEDIN_AUTHOR_URN || '<LINKEDIN_AUTHOR_URN>';
  if (target === 'x') return process.env.SNS_X_USER_ID || '<X_USER_ID>';
  if (target === 'facebook') return process.env.SNS_FACEBOOK_PAGE_ID || '<FACEBOOK_PAGE_ID>';
  if (target === 'instagram') return process.env.SNS_INSTAGRAM_USER_ID || '<INSTAGRAM_USER_ID>';
  return '<ACCOUNT>';
}

function buildRun({ scheduledAt, targets, window, sanitized, summary, drafts, dryRun, manualHandoff }) {
  const runId = `sns_${sha256(`${window.since}:${window.until}:${targets.join(',')}`).slice(0, 16)}`;
  const draftHash = sha256(stableJson({ window, targets, drafts }));
  const token = makeApprovalToken();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const platformState = {};
  for (const target of targets) {
    const account = platformAccount(target);
    let mode = dryRun || drafts[target]?.mode !== 'publish' ? 'dry-run' : 'publish';
    if (manualHandoff && MANUAL_COMPOSE_TARGETS.has(target)) mode = 'manual';
    platformState[target] = {
      target,
      account: sanitizeText(account, 120),
      mode,
      status: mode === 'dry-run' ? 'dry_run' : 'pending_review',
      idempotency_key: `${target}:${sanitizeText(account, 80)}:${window.until}:${draftHash}`,
      retry_count: 0,
    };
  }
  return {
    run: {
      run_id: runId,
      status: 'pending_review',
      scheduled_at: parseDate(scheduledAt).toISOString(),
      scheduled_window: window,
      targets,
      draft_hash: draftHash,
      approval: {
        token_hash: approvalTokenHash(runId, token),
        expires_at: expiresAt,
        method: 'token',
      },
      risk_report: {
        redactions: sanitized.redactions,
        private_blocked: summary.blocked_count,
        dry_run_targets: Object.values(platformState).filter((item) => item.mode === 'dry-run').map((item) => item.target),
        manual_handoff_targets: Object.values(platformState).filter((item) => item.mode === 'manual').map((item) => item.target),
      },
      summary,
      drafts,
      platforms: platformState,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    approval_token: token,
  };
}

function canReplaceDraftRun(run) {
  if (!run) return true;
  const mutableRunStatus = new Set(['draft', 'pending_review', 'denied', 'expired', 'blocked', 'needs_reapproval']);
  if (!mutableRunStatus.has(run.status)) return false;
  const immutablePlatformStatus = new Set([
    'approved',
    'inflight',
    'posted',
    'reconcile_required',
    'compose_opened',
    'awaiting_user_post',
    'user_confirmed_posted',
  ]);
  return !Object.values(run.platforms || {}).some((platform) => immutablePlatformStatus.has(platform.status));
}

async function createDraftRun(options = {}) {
  const stateDir = options.stateDir || defaultStateDir();
  const targets = normalizeTargets(options.targets);
  const scheduledAt = options.scheduledAt || new Date().toISOString();
  let result;
  await withLock(stateDir, async () => {
    const ledger = loadLedger(stateDir);
    const window = computeScheduledWindow({
      scheduledAt,
      previousWindowUntil: options.previousWindowUntil || ledger.cursor.window_until,
    });
    const rawCommits = await collectCommits({ ...options, window });
    const sanitized = sanitizeCommits(rawCommits, Boolean(options.allowPrivate));
    const summary = summarizeCommits(sanitized.commits);
    const drafts = buildDrafts({ summary, window, targets });
    result = buildRun({
      scheduledAt,
      targets,
      window,
      sanitized,
      summary,
      drafts,
      dryRun: Boolean(options.dryRun),
      manualHandoff: Boolean(options.manualHandoff) || process.env.SNS_BROWSER_HANDOFF_ENABLED === '1',
    });
    const existingIndex = ledger.runs.findIndex((run) => run.run_id === result.run.run_id);
    if (existingIndex >= 0) {
      if (!canReplaceDraftRun(ledger.runs[existingIndex])) {
        result = { run: ledger.runs[existingIndex], approval_token: null };
        appendAudit(stateDir, {
          event: 'draft_reused',
          run_id: result.run.run_id,
          scheduled_window: result.run.scheduled_window,
          draft_hash: result.run.draft_hash,
          targets: result.run.targets,
        });
      } else {
        ledger.runs[existingIndex] = { ...ledger.runs[existingIndex], ...result.run, updated_at: new Date().toISOString() };
      }
    } else {
      ledger.runs.push(result.run);
    }
    ledger.cursor.window_until = window.until;
    saveLedger(stateDir, ledger);
    appendAudit(stateDir, {
      event: 'draft_created',
      run_id: result.run.run_id,
      scheduled_window: window,
      draft_hash: result.run.draft_hash,
      targets,
    });
  });
  return result;
}

function findRun(ledger, runId) {
  return ledger.runs.find((run) => run.run_id === runId);
}

function findRunByToken(ledger, token) {
  return ledger.runs.find((run) => approvalTokenHash(run.run_id, token) === run.approval?.token_hash);
}

function validateApprovalBinding(run, body) {
  if (body.draftHash && body.draftHash !== run.draft_hash) return false;
  if (body.weekRange || body.windowUntil || body.window_from || body.window_to) {
    const until = body.windowUntil || body.window_to;
    if (until && until !== run.scheduled_window.until) return false;
  }
  const targets = normalizeTargets(body.targets || run.targets);
  return targets.every((target) => run.targets.includes(target));
}

async function approveRun(options = {}) {
  const stateDir = options.stateDir || defaultStateDir();
  const runId = cleanText(options.runId || options.run_id, 80);
  const token = cleanText(options.token, 200);
  const decision = cleanText(options.decision || options.action || 'confirm', 20).toLowerCase();
  if (!token) return { ok: false, status: 'blocked', error: 'missing approval token' };
  let response;
  await withLock(stateDir, async () => {
    const ledger = loadLedger(stateDir);
    const run = runId ? findRun(ledger, runId) : findRunByToken(ledger, token);
    if (!run) {
      response = { ok: false, status: 'blocked', error: 'run not found' };
      return;
    }
    const activeRunId = run.run_id;
    if (new Date(run.approval?.expires_at || 0) <= new Date()) {
      run.status = 'expired';
      run.updated_at = new Date().toISOString();
      response = { ok: false, run_id: activeRunId, status: 'expired' };
      appendAudit(stateDir, { event: 'approval_expired', run_id: activeRunId, draft_hash: run.draft_hash, targets: run.targets });
      saveLedger(stateDir, ledger);
      return;
    }
    if (approvalTokenHash(activeRunId, token) !== run.approval?.token_hash) {
      response = { ok: false, run_id: activeRunId, status: 'blocked', error: 'approval token mismatch' };
      appendAudit(stateDir, { event: 'approval_mismatch', run_id: activeRunId, draft_hash: run.draft_hash, targets: run.targets });
      return;
    }
    if (!validateApprovalBinding(run, options)) {
      run.status = 'needs_reapproval';
      run.updated_at = new Date().toISOString();
      response = { ok: false, run_id: activeRunId, status: 'needs_reapproval' };
      appendAudit(stateDir, { event: 'approval_binding_mismatch', run_id: activeRunId, draft_hash: run.draft_hash, targets: run.targets });
      saveLedger(stateDir, ledger);
      return;
    }
    if (/^(deny|denied|reject|rejected)$/i.test(decision)) {
      run.status = 'denied';
      for (const target of run.targets) run.platforms[target].status = 'denied';
      run.updated_at = new Date().toISOString();
      response = { ok: true, run_id: activeRunId, status: 'denied' };
      appendAudit(stateDir, {
        event: 'approval_denied',
        run_id: activeRunId,
        draft_hash: run.draft_hash,
        approval_method: 'token',
        approver_hash: sha256(options.userId || options.approver || 'unknown').slice(0, 16),
        targets: run.targets,
      });
      saveLedger(stateDir, ledger);
      return;
    }
    run.status = 'approved';
    for (const target of run.targets) {
      if (run.platforms[target].mode === 'publish' || run.platforms[target].mode === 'manual') {
        run.platforms[target].status = 'approved';
      }
    }
    run.updated_at = new Date().toISOString();
    response = { ok: true, run_id: activeRunId, status: 'approved', targets: run.targets, draft_hash: run.draft_hash };
    appendAudit(stateDir, {
      event: 'approval_confirmed',
      run_id: activeRunId,
      draft_hash: run.draft_hash,
      approval_method: 'token',
      approver_hash: sha256(options.userId || options.approver || 'unknown').slice(0, 16),
      targets: run.targets,
    });
    saveLedger(stateDir, ledger);
  });
  return response;
}

function publishJson(url, payload, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`provider ${res.statusCode}`));
          return;
        }
        resolve({ body, headers: res.headers, statusCode: res.statusCode });
      });
    });
    req.on('timeout', () => req.destroy(new Error('provider timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function requestJson(url, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        'accept': 'application/json',
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`provider ${res.statusCode}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('provider timeout')));
    req.on('error', reject);
    req.end();
  });
}

function publishForm(url, fields, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = new URLSearchParams(fields).toString();
    const req = https.request({
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(data),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`provider ${res.statusCode}`));
          return;
        }
        resolve({ body, headers: res.headers, statusCode: res.statusCode });
      });
    });
    req.on('timeout', () => req.destroy(new Error('provider timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function metaGraphVersion() {
  const raw = sanitizeText(process.env.SNS_META_GRAPH_VERSION || 'v23.0', 20);
  return raw.startsWith('v') ? raw : `v${raw}`;
}

async function publishLinkedIn(draft) {
  if (process.env.SNS_LINKEDIN_PUBLISH_ENABLED !== '1') return { dryRun: true };
  const token = process.env.SNS_LINKEDIN_ACCESS_TOKEN;
  const author = process.env.SNS_LINKEDIN_AUTHOR_URN;
  if (!token || !author) throw new Error('missing LinkedIn secret alias/env');
  const version = process.env.SNS_LINKEDIN_VERSION || '202605';
  const response = await publishJson('https://api.linkedin.com/rest/posts', {
    author,
    commentary: draft.text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  }, {
    authorization: `Bearer ${token}`,
    'x-restli-protocol-version': '2.0.0',
    'linkedin-version': version,
  });
  return { providerPostId: sanitizeText(response.headers['x-restli-id'] || '', 120) };
}

async function publishX(draft) {
  if (process.env.SNS_X_PUBLISH_ENABLED !== '1') return { dryRun: true };
  const token = process.env.SNS_X_ACCESS_TOKEN;
  if (!token) throw new Error('missing X secret alias/env');
  const response = await publishJson('https://api.x.com/2/tweets', { text: draft.text }, {
    authorization: `Bearer ${token}`,
  });
  const data = response.body ? JSON.parse(response.body) : {};
  return { providerPostId: sanitizeText(data.data?.id || '', 120) };
}

async function publishFacebook(draft) {
  if (process.env.SNS_FACEBOOK_PUBLISH_ENABLED !== '1') return { dryRun: true };
  const token = process.env.SNS_FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.SNS_FACEBOOK_PAGE_ID;
  if (!token || !pageId) throw new Error('missing Facebook Page secret alias/env');
  const response = await publishForm(`https://graph.facebook.com/${metaGraphVersion()}/${encodeURIComponent(pageId)}/feed`, {
    message: draft.text,
    access_token: token,
  });
  const data = response.body ? JSON.parse(response.body) : {};
  return { providerPostId: sanitizeText(data.id || '', 120) };
}

async function publishInstagram(draft) {
  if (process.env.SNS_INSTAGRAM_PUBLISH_ENABLED !== '1') return { dryRun: true };
  const token = process.env.SNS_INSTAGRAM_ACCESS_TOKEN || process.env.SNS_FACEBOOK_PAGE_ACCESS_TOKEN;
  const userId = process.env.SNS_INSTAGRAM_USER_ID;
  const mediaUrl = process.env.SNS_INSTAGRAM_MEDIA_URL;
  if (!token || !userId || !mediaUrl) throw new Error('missing Instagram secret alias/env or media URL');
  const version = metaGraphVersion();
  const mediaFields = {
    caption: draft.text,
    access_token: token,
  };
  if (/\.(?:mp4|mov)(?:$|[?#])/i.test(mediaUrl)) {
    mediaFields.media_type = process.env.SNS_INSTAGRAM_VIDEO_MEDIA_TYPE || 'REELS';
    mediaFields.video_url = mediaUrl;
  } else {
    mediaFields.image_url = mediaUrl;
  }
  const container = await publishForm(`https://graph.facebook.com/${version}/${encodeURIComponent(userId)}/media`, mediaFields);
  const containerData = container.body ? JSON.parse(container.body) : {};
  const creationId = containerData.id;
  if (!creationId) throw new Error('missing Instagram creation id');
  const published = await publishForm(`https://graph.facebook.com/${version}/${encodeURIComponent(userId)}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  const publishedData = published.body ? JSON.parse(published.body) : {};
  return { providerPostId: sanitizeText(publishedData.id || '', 120) };
}

async function defaultPublisher(target, draft) {
  if (target === 'linkedin') return publishLinkedIn(draft);
  if (target === 'x') return publishX(draft);
  if (target === 'facebook') return publishFacebook(draft);
  if (target === 'instagram') return publishInstagram(draft);
  return { dryRun: true };
}

async function metaPermissionReport(options = {}) {
  const requester = options.requester || requestJson;
  const version = metaGraphVersion();
  const userToken = process.env.SNS_META_USER_ACCESS_TOKEN || '';
  const pageToken = process.env.SNS_FACEBOOK_PAGE_ACCESS_TOKEN || '';
  const pageId = process.env.SNS_FACEBOOK_PAGE_ID || '';
  const igUserId = process.env.SNS_INSTAGRAM_USER_ID || '';
  const tokenForPage = pageToken || userToken;
  const report = {
    ok: true,
    graph_version: version,
    env: {
      meta_user_token: Boolean(userToken),
      facebook_page_token: Boolean(pageToken),
      facebook_page_id: Boolean(pageId),
      instagram_user_id: Boolean(igUserId),
      instagram_media_url: Boolean(process.env.SNS_INSTAGRAM_MEDIA_URL),
    },
    permissions: [],
    pages: [],
    page: null,
    ready: {
      facebook_page_publish: false,
      instagram_publish: false,
    },
  };

  if (userToken) {
    try {
      const permissions = await requester(`https://graph.facebook.com/${version}/me/permissions?access_token=${encodeURIComponent(userToken)}`);
      report.permissions = (permissions.data || []).map((item) => ({
        permission: sanitizeText(item.permission, 80),
        status: sanitizeText(item.status, 40),
      }));
    } catch (error) {
      report.permissions_error_class = classifyError(error);
    }
    try {
      const accounts = await requester(`https://graph.facebook.com/${version}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`);
      report.pages = (accounts.data || []).map((item) => ({
        id: sanitizeText(item.id, 80),
        name: sanitizeText(item.name, 120),
        instagram_business_account: item.instagram_business_account ? {
          id: sanitizeText(item.instagram_business_account.id, 80),
          username: sanitizeText(item.instagram_business_account.username, 80),
        } : null,
      }));
    } catch (error) {
      report.pages_error_class = classifyError(error);
    }
  }

  if (pageId && tokenForPage) {
    try {
      const page = await requester(`https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(tokenForPage)}`);
      report.page = {
        id: sanitizeText(page.id, 80),
        name: sanitizeText(page.name, 120),
        instagram_business_account: page.instagram_business_account ? {
          id: sanitizeText(page.instagram_business_account.id, 80),
          username: sanitizeText(page.instagram_business_account.username, 80),
        } : null,
      };
    } catch (error) {
      report.page_error_class = classifyError(error);
    }
  }

  const granted = new Set(report.permissions.filter((item) => item.status === 'granted').map((item) => item.permission));
  const hasPermissionReport = report.permissions.length > 0;
  const facebookPermissionsOk = !hasPermissionReport || ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'].every((permission) => granted.has(permission));
  const instagramPermissionsOk = !hasPermissionReport || ['instagram_basic', 'instagram_content_publish'].every((permission) => granted.has(permission));
  report.ready.facebook_page_publish = Boolean(pageId && pageToken && facebookPermissionsOk);
  report.ready.instagram_publish = Boolean(igUserId && (process.env.SNS_INSTAGRAM_ACCESS_TOKEN || pageToken) && process.env.SNS_INSTAGRAM_MEDIA_URL && instagramPermissionsOk);
  return report;
}

function buildComposeHandoff(target, draft) {
  const text = sanitizeText(draft?.text || '', 5000);
  if (target === 'x') {
    return {
      target,
      compose_url: `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
      clipboard_required: false,
      text_length: text.length,
      weighted_length: weightedLength(text),
      manual_browser_handoff: true,
    };
  }
  if (target === 'linkedin') {
    return {
      target,
      compose_url: 'https://www.linkedin.com/feed/',
      clipboard_required: true,
      text_length: text.length,
      manual_browser_handoff: true,
    };
  }
  if (target === 'facebook') {
    return {
      target,
      compose_url: process.env.SNS_FACEBOOK_COMPOSE_URL || 'https://www.facebook.com/',
      clipboard_required: true,
      text_length: text.length,
      manual_browser_handoff: true,
    };
  }
  if (target === 'instagram') {
    return {
      target,
      compose_url: process.env.SNS_INSTAGRAM_COMPOSE_URL || 'https://www.instagram.com/create/select/',
      clipboard_required: true,
      media_required: true,
      text_length: text.length,
      manual_browser_handoff: true,
    };
  }
  return {
    target,
    compose_url: '',
    clipboard_required: false,
    text_length: text.length,
    manual_browser_handoff: false,
    unsupported: true,
  };
}

async function openBrowserUrl(url) {
  if (!url) return;
  if (process.platform === 'win32') {
    await execFileText('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $args[0]', url], { timeout: 10000 });
    return;
  }
  if (process.platform === 'darwin') {
    await execFileText('open', [url], { timeout: 10000 });
    return;
  }
  await execFileText('xdg-open', [url], { timeout: 10000 });
}

async function copyTextToClipboard(text) {
  const safeText = sanitizeText(text, 5000);
  if (process.platform === 'win32') {
    await execFileText('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value $args[0]', safeText], { timeout: 10000 });
    return;
  }
  throw new Error('clipboard copy is only implemented for Windows in this runner');
}

async function composeRun(options = {}) {
  const stateDir = options.stateDir || defaultStateDir();
  const runId = cleanText(options.runId || options.run_id, 80);
  const targets = normalizeTargets(options.targets || '');
  const openBrowser = options.openBrowser === true;
  const copyClipboard = options.copyClipboard === true;
  if (!runId) return { ok: false, status: 'blocked', error: 'missing run id' };
  const results = [];
  let handoffs = [];
  await withLock(stateDir, async () => {
    const ledger = loadLedger(stateDir);
    const run = findRun(ledger, runId);
    if (!run) {
      results.push({ status: 'blocked', error: 'run not found' });
      return;
    }
    if (run.status !== 'approved') {
      results.push({ status: 'blocked', error: 'run is not approved' });
      return;
    }
    const selectedTargets = (targets.length ? targets : run.targets).filter((target) => run.targets.includes(target));
    handoffs = selectedTargets.map((target) => {
      const platform = run.platforms?.[target];
      const handoff = buildComposeHandoff(target, run.drafts?.[target]);
      if (!platform) return { target, status: 'blocked', error: 'target not in run' };
      if (handoff.unsupported) return { ...handoff, status: 'blocked', error: 'manual compose is not supported for target' };
      if (platform.status === 'user_confirmed_posted' || platform.status === 'posted') {
        return { ...handoff, status: platform.status, skipped: true };
      }
      platform.mode = 'manual';
      platform.status = openBrowser ? 'compose_opened' : 'compose_ready';
      platform.manual_browser_handoff = true;
      run.updated_at = new Date().toISOString();
      appendAudit(stateDir, {
        event: openBrowser ? 'compose_opened' : 'compose_ready',
        run_id: runId,
        scheduled_window: run.scheduled_window,
        draft_hash: run.draft_hash,
        targets: [target],
        idempotency_key: platform.idempotency_key,
        retry_count: platform.retry_count,
      });
      return { ...handoff, status: platform.status };
    });
    saveLedger(stateDir, ledger);
  });

  for (const handoff of handoffs) {
    if (handoff.error || handoff.skipped) {
      results.push(handoff);
      continue;
    }
    try {
      if (copyClipboard && handoff.clipboard_required) {
        const ledger = loadLedger(stateDir);
        const run = findRun(ledger, runId);
        await copyTextToClipboard(run?.drafts?.[handoff.target]?.text || '');
        handoff.clipboard_copied = true;
      }
      if (openBrowser) await openBrowserUrl(handoff.compose_url);
      results.push({
        target: handoff.target,
        status: openBrowser ? 'awaiting_user_post' : handoff.status,
        compose_url: handoff.compose_url,
        clipboard_required: handoff.clipboard_required,
        clipboard_copied: Boolean(handoff.clipboard_copied),
        media_required: Boolean(handoff.media_required),
        manual_browser_handoff: true,
        text_length: handoff.text_length,
        weighted_length: handoff.weighted_length,
      });
    } catch (error) {
      const status = 'failed';
      await withLock(stateDir, async () => {
        const ledger = loadLedger(stateDir);
        const run = findRun(ledger, runId);
        const current = run?.platforms?.[handoff.target];
        if (current) {
          current.status = status;
          current.sanitized_error_class = classifyError(error);
          run.updated_at = new Date().toISOString();
          appendAudit(stateDir, {
            event: 'compose_failed',
            run_id: runId,
            scheduled_window: run.scheduled_window,
            draft_hash: run.draft_hash,
            targets: [handoff.target],
            idempotency_key: current.idempotency_key,
            sanitized_error_class: current.sanitized_error_class,
          });
          saveLedger(stateDir, ledger);
        }
      });
      results.push({ target: handoff.target, status, sanitized_error_class: classifyError(error) });
    }
  }

  if (openBrowser) {
    await withLock(stateDir, async () => {
      const ledger = loadLedger(stateDir);
      const run = findRun(ledger, runId);
      if (!run) return;
      for (const result of results) {
        const platform = run.platforms?.[result.target];
        if (platform && result.status === 'awaiting_user_post') {
          platform.status = 'awaiting_user_post';
          run.updated_at = new Date().toISOString();
        }
      }
      saveLedger(stateDir, ledger);
    });
  }

  return { ok: true, run_id: runId, results };
}

async function confirmManualPost(options = {}) {
  const stateDir = options.stateDir || defaultStateDir();
  const runId = cleanText(options.runId || options.run_id, 80);
  const targets = normalizeTargets(options.targets || '');
  const abandon = Boolean(options.abandon);
  if (!runId) return { ok: false, status: 'blocked', error: 'missing run id' };
  const results = [];
  await withLock(stateDir, async () => {
    const ledger = loadLedger(stateDir);
    const run = findRun(ledger, runId);
    if (!run) {
      results.push({ status: 'blocked', error: 'run not found' });
      return;
    }
    const selectedTargets = (targets.length ? targets : run.targets).filter((target) => run.targets.includes(target));
    for (const target of selectedTargets) {
      const platform = run.platforms?.[target];
      if (!platform) {
        results.push({ target, status: 'blocked', error: 'target not in run' });
        continue;
      }
      if (!['compose_ready', 'compose_opened', 'awaiting_user_post'].includes(platform.status)) {
        results.push({ target, status: 'blocked', error: 'target is not awaiting manual post' });
        continue;
      }
      platform.status = abandon ? 'abandoned' : 'user_confirmed_posted';
      platform.manual_browser_handoff = true;
      run.updated_at = new Date().toISOString();
      results.push({ target, status: platform.status });
      appendAudit(stateDir, {
        event: abandon ? 'manual_post_abandoned' : 'manual_post_confirmed',
        run_id: runId,
        scheduled_window: run.scheduled_window,
        draft_hash: run.draft_hash,
        targets: [target],
        idempotency_key: platform.idempotency_key,
      });
    }
    saveLedger(stateDir, ledger);
  });
  return { ok: true, run_id: runId, results };
}

async function publishRun(options = {}) {
  const stateDir = options.stateDir || defaultStateDir();
  const runId = cleanText(options.runId || options.run_id, 80);
  const targets = normalizeTargets(options.targets || '');
  if (!runId) return { ok: false, status: 'blocked', error: 'missing run id' };
  const publishers = options.publishers || {};
  const results = [];
  let runSnapshot = null;
  for (const target of targets.length ? targets : DEFAULT_TARGETS) {
    let platform;
    await withLock(stateDir, async () => {
      const ledger = loadLedger(stateDir);
      const run = findRun(ledger, runId);
      if (!run) {
        results.push({ target, status: 'blocked', error: 'run not found' });
        return;
      }
      runSnapshot = run;
      platform = run.platforms?.[target];
      if (!platform) {
        results.push({ target, status: 'blocked', error: 'target not in run' });
        return;
      }
      if (run.status !== 'approved') {
        results.push({ target, status: 'blocked', error: 'run is not approved' });
        return;
      }
      if (platform.status === 'posted') {
        results.push({ target, status: 'posted', provider_post_id: platform.provider_post_id, skipped: true });
        return;
      }
      if (platform.status === 'inflight') {
        platform.status = 'reconcile_required';
        run.updated_at = new Date().toISOString();
        results.push({ target, status: 'reconcile_required' });
        saveLedger(stateDir, ledger);
        return;
      }
      if (platform.mode !== 'publish' || options.dryRun) {
        platform.status = 'dry_run';
        run.updated_at = new Date().toISOString();
        results.push({ target, status: 'dry_run' });
        appendAudit(stateDir, {
          event: 'publish_dry_run',
          run_id: runId,
          scheduled_window: run.scheduled_window,
          draft_hash: run.draft_hash,
          targets: [target],
          idempotency_key: platform.idempotency_key,
          retry_count: platform.retry_count,
        });
        saveLedger(stateDir, ledger);
        return;
      }
      platform.status = 'inflight';
      platform.retry_count = Number(platform.retry_count || 0) + 1;
      run.updated_at = new Date().toISOString();
      saveLedger(stateDir, ledger);
    });
    if (!platform || results.some((result) => result.target === target)) continue;
    try {
      const publish = publishers[target] || defaultPublisher;
      const posted = await publish(target, runSnapshot.drafts[target], platform);
      await withLock(stateDir, async () => {
        const ledger = loadLedger(stateDir);
        const run = findRun(ledger, runId);
        const current = run?.platforms?.[target];
        if (!current) return;
        current.status = posted.dryRun ? 'dry_run' : 'posted';
        current.provider_post_id = sanitizeText(posted.providerPostId || '', 120);
        run.updated_at = new Date().toISOString();
        results.push({ target, status: current.status, provider_post_id: current.provider_post_id });
        appendAudit(stateDir, {
          event: current.status === 'posted' ? 'publish_posted' : 'publish_dry_run',
          run_id: runId,
          scheduled_window: run.scheduled_window,
          draft_hash: run.draft_hash,
          targets: [target],
          idempotency_key: current.idempotency_key,
          provider_post_id: current.provider_post_id,
          retry_count: current.retry_count,
        });
        saveLedger(stateDir, ledger);
      });
    } catch (error) {
      const status = classifyError(error) === 'timeout' ? 'reconcile_required' : 'failed';
      await withLock(stateDir, async () => {
        const ledger = loadLedger(stateDir);
        const run = findRun(ledger, runId);
        const current = run?.platforms?.[target];
        if (!current) return;
        current.status = status;
        current.sanitized_error_class = classifyError(error);
        run.updated_at = new Date().toISOString();
        results.push({ target, status, sanitized_error_class: current.sanitized_error_class });
        appendAudit(stateDir, {
          event: 'publish_failed',
          run_id: runId,
          scheduled_window: run.scheduled_window,
          draft_hash: run.draft_hash,
          targets: [target],
          idempotency_key: current.idempotency_key,
          retry_count: current.retry_count,
          sanitized_error_class: current.sanitized_error_class,
        });
        saveLedger(stateDir, ledger);
      });
    }
  }
  return { ok: true, run_id: runId, results };
}

function parseArgs(argv) {
  const args = { mode: 'draft', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') args.mode = argv[++index];
    else if (arg === '--scheduled-at') args.scheduledAt = argv[++index];
    else if (arg === '--targets') args.targets = argv[++index];
    else if (arg === '--state-dir') args.stateDir = argv[++index];
    else if (arg === '--repo' || arg === '--repos') args.repos = argv[++index];
    else if (arg === '--run-id') args.runId = argv[++index];
    else if (arg === '--approval-token') args.token = argv[++index];
    else if (arg === '--deny') args.decision = 'deny';
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--manual-handoff') args.manualHandoff = true;
    else if (arg === '--open-browser') args.openBrowser = true;
    else if (arg === '--copy-clipboard') args.copyClipboard = true;
    else if (arg === '--no-open') args.noOpen = true;
    else if (arg === '--no-clipboard') args.noClipboard = true;
    else if (arg === '--abandon') args.abandon = true;
    else if (arg === '--media-url') process.env.SNS_INSTAGRAM_MEDIA_URL = argv[++index];
    else if (arg === '--allow-private') args.allowPrivate = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  weekly_github_sns_publish --mode draft --scheduled-at <ISO> --targets linkedin,x --manual-handoff',
    '  weekly_github_sns_publish --mode compose --run-id <id> --targets linkedin,x',
    '  weekly_github_sns_publish --mode confirm-posted --run-id <id> --targets linkedin,x',
    '  weekly_github_sns_publish --mode meta-check',
    '  weekly_github_sns_publish --mode publish --run-id <id> --targets linkedin --dry-run',
    '  weekly_github_sns_publish --mode approval --run-id <id> --approval-token <token> [--deny]',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  let result;
  if (args.mode === 'draft') result = await createDraftRun(args);
  else if (args.mode === 'approval') result = await approveRun({ ...args, decision: args.decision || 'confirm' });
  else if (args.mode === 'publish') result = await publishRun(args);
  else if (args.mode === 'compose') {
    result = await composeRun({
      ...args,
      openBrowser: !args.noOpen,
      copyClipboard: !args.noClipboard,
    });
  } else if (args.mode === 'confirm-posted') result = await confirmManualPost(args);
  else if (args.mode === 'meta-check') result = await metaPermissionReport(args);
  else throw new Error(`unsupported mode: ${args.mode}`);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: sanitizeText(error.message || String(error), 240) }));
    process.exit(1);
  });
}

module.exports = {
  STATUS_VALUES,
  approveRun,
  buildComposeHandoff,
  buildDrafts,
  classifyError,
  collectGitHubApiMetadata,
  composeRun,
  computeScheduledWindow,
  confirmManualPost,
  createDraftRun,
  defaultStateDir,
  fitWeightedText,
  loadLedger,
  metaPermissionReport,
  normalizeTargets,
  publishRun,
  sanitizeCommits,
  sanitizeText,
  stableJson,
  weightedLength,
};
