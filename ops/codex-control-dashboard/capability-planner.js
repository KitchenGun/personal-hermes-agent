const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HERMES_HOME = process.env.HERMES_HOME || '/home/ubuntu/.hermes';
const STATE_DIR = path.join(HERMES_HOME, 'state', 'capability-planner');
const INVENTORY_FILE = path.join(STATE_DIR, 'inventory.json');
const AUDIT_FILE = path.join(STATE_DIR, 'audit.jsonl');
const INVENTORY_TTL_MS = Math.max(15000, Math.min(600000, Number(process.env.CAPABILITY_PLANNER_TTL_MS || 60000) || 60000));

let cachedInventory = null;
let cachedInventoryAt = 0;

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function listDirs(root, limit = 200) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

function yamlListAfter(text, key) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!new RegExp(`^\\s*${key}:\\s*$`).test(line)) continue;
    const indent = (line.match(/^\s*/) || [''])[0].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) continue;
      const nextIndent = (next.match(/^\s*/) || [''])[0].length;
      if (nextIndent <= indent) break;
      const match = next.match(/^\s*-\s+['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
      if (match) out.push(match[1].trim());
    }
  }
  return out;
}


function yamlSectionList(text, section, key) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const sectionMatch = lines[i].match(new RegExp(`^(\\s*)${section}:\\s*$`));
    if (!sectionMatch) continue;
    const sectionIndent = sectionMatch[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) continue;
      const indent = (line.match(/^\s*/) || [''])[0].length;
      if (indent <= sectionIndent) break;
      const keyMatch = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
      if (!keyMatch) continue;
      const inline = keyMatch[1].trim();
      if (inline.startsWith('[') && inline.endsWith(']')) {
        return inline.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      }
      const out = [];
      const keyIndent = indent;
      for (let k = j + 1; k < lines.length; k += 1) {
        const next = lines[k];
        if (!next.trim()) continue;
        const nextIndent = (next.match(/^\s*/) || [''])[0].length;
        if (nextIndent < keyIndent) break;
        if (nextIndent === keyIndent && /^\s*[A-Za-z0-9_.-]+:\s*/.test(next)) break;
        const match = next.match(/^\s*-\s+['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
        if (match) out.push(match[1].trim());
      }
      return out;
    }
  }
  return [];
}

function sectionKeys(text, section) {
  const lines = String(text || '').split(/\r?\n/);
  const keys = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!new RegExp(`^${section}:\\s*$`).test(line)) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) continue;
      if (/^\S/.test(next)) break;
      const match = next.match(/^\s{2}([A-Za-z0-9_.-]+):\s*/);
      if (match) keys.push(match[1]);
    }
  }
  return keys;
}

function capabilityTags(text) {
  const lower = String(text || '').toLowerCase();
  const tags = [];
  const rules = [
    ['cron', /\bcron\b|scheduler|scheduled|스케줄|크론|예약/],
    ['discord', /discord|디스코드|webhook|slash/],
    ['mcp', /\bmcp\b|tool server|connector/],
    ['skills', /\bskill\b|skills hub|curator|스킬/],
    ['plugins', /plugin|plugins|플러그인/],
    ['ai-trends', /ai[-_ ]?trend|ai trends|트렌드|rss|x rss|nitter|newsletter/],
    ['google-workspace', /google|calendar|gmail|sheet|sheets|drive|캘린더|시트|메일/],
    ['dashboard', /dashboard|codex-control|kanban|queue|작업큐|대시보드/],
    ['code-change', /implement|fix|patch|refactor|수정|구현|개선|추가/],
    ['verification', /test|smoke|verify|검증|테스트|확인/],
    ['research', /research|search|조사|분석|탐색/],
    ['docs', /docs|document|readme|문서|정리|보고/],
  ];
  for (const [tag, pattern] of rules) {
    if (pattern.test(lower)) tags.push(tag);
  }
  return tags;
}

function chooseProfile(tags, spawnableProfiles, fallback) {
  const available = new Set(spawnableProfiles || []);
  const prefer = (...profiles) => profiles.find((profile) => available.has(profile));
  if (tags.includes('cron') || tags.includes('discord') || tags.includes('dashboard') || tags.includes('google-workspace')) {
    return prefer('devops_fast', 'devops', 'fixer', fallback) || fallback;
  }
  if (tags.includes('verification')) return prefer('tester', 'reviewer', fallback) || fallback;
  if (tags.includes('code-change')) return prefer('coder', 'fixer', fallback) || fallback;
  if (tags.includes('research') || tags.includes('ai-trends')) return prefer('researcher', 'planner', fallback) || fallback;
  if (tags.includes('docs')) return prefer('editor', 'planner', fallback) || fallback;
  if (tags.includes('mcp') || tags.includes('skills') || tags.includes('plugins')) return prefer('planner', 'researcher', fallback) || fallback;
  return fallback;
}

function recommendedWorkers(tags, spawnableProfiles) {
  const available = new Set(spawnableProfiles || []);
  const ordered = [];
  const add = (profile, title) => {
    if (!available.has(profile) || ordered.some((item) => item.profile === profile)) return;
    ordered.push({ profile, title });
  };
  add('researcher', '현재 capability와 의존성 후보 조사');
  if (tags.includes('cron') || tags.includes('discord') || tags.includes('dashboard') || tags.includes('google-workspace')) {
    add(available.has('devops_fast') ? 'devops_fast' : 'devops', '운영 영향과 실행 경로 점검');
  }
  if (tags.includes('code-change') || tags.includes('dashboard') || tags.includes('plugins') || tags.includes('mcp') || tags.includes('skills')) {
    add('coder', '핵심 코드 및 설정 반영');
  }
  add('tester', '회귀 테스트와 smoke 검증');
  add('reviewer', '결과 리뷰와 위험 확인');
  return ordered.slice(0, 5);
}

function collectInventory(spawnableProfiles = []) {
  const configText = readText(path.join(HERMES_HOME, 'config.yaml'));
  const cronJobs = readJson(path.join(HERMES_HOME, 'cron', 'jobs.json'), { jobs: [] });
  const jobs = Array.isArray(cronJobs) ? cronJobs : Array.isArray(cronJobs.jobs) ? cronJobs.jobs : [];
  return {
    generatedAt: new Date().toISOString(),
    spawnableProfiles: [...spawnableProfiles].sort(),
    plugins: {
      user: listDirs(path.join(HERMES_HOME, 'plugins')),
      enabled: yamlSectionList(configText, 'plugins', 'enabled'),
      disabled: yamlSectionList(configText, 'plugins', 'disabled'),
    },
    mcpServers: sectionKeys(configText, 'mcp_servers'),
    skills: listDirs(path.join(HERMES_HOME, 'skills'), 300),
    cron: {
      total: jobs.length,
      enabled: jobs.filter((job) => job.enabled !== false).length,
      recentOk: jobs.filter((job) => String(job.last_status || '').toLowerCase() === 'ok').length,
      names: jobs.map((job) => String(job.name || job.id || '')).filter(Boolean).slice(0, 40),
    },
  };
}

function getInventory(spawnableProfiles = []) {
  const now = Date.now();
  if (cachedInventory && now - cachedInventoryAt < INVENTORY_TTL_MS) return cachedInventory;
  ensureStateDir();
  cachedInventory = collectInventory(spawnableProfiles);
  cachedInventoryAt = now;
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(cachedInventory, null, 2));
  return cachedInventory;
}

function capabilityHints(tags, inventory) {
  const hints = [];
  const add = (kind, name, reason) => hints.push({ kind, name, reason });
  if (tags.includes('ai-trends')) {
    add('skill', 'rss/xurl/web-search', 'AI Trends 수집/검증 계열 작업에는 공개 피드와 URL 정규화 capability가 유용함');
  }
  if (tags.includes('google-workspace')) {
    add('skill', 'google-workspace', 'Calendar/Sheets/Gmail 작업은 기존 Google Workspace 경로와 토큰 상태를 먼저 확인');
  }
  if (tags.includes('mcp')) {
    add('mcp', inventory.mcpServers.length ? inventory.mcpServers.join(', ') : 'catalog-check', 'MCP는 설치보다 현재 mcp_servers와 tool include/exclude 확인을 우선');
  }
  if (tags.includes('plugins')) {
    add('plugin', inventory.plugins.enabled.join(', ') || 'plugins.enabled', '플러그인은 user plugin과 enabled 목록을 기준으로 판단');
  }
  if (tags.includes('cron')) {
    add('cron', `${inventory.cron.enabled}/${inventory.cron.total} enabled`, '기존 Hermes cron은 read-only로 확인하고 직접 수정하지 않음');
  }
  if (!hints.length) {
    add('profile', 'default', '추가 capability 없이 기본 작업큐 실행 가능');
  }
  return hints.slice(0, 8);
}

function hashPlan(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function planCapabilities({ input = {}, spec = {}, board = 'codex-control', spawnableProfiles = [], executionProfile = 'default' } = {}) {
  const combined = [input.title, input.detail, input.body, input.description, spec.title, spec.body].filter(Boolean).join('\n');
  const tags = capabilityTags(combined);
  const inventory = getInventory(spawnableProfiles);
  const requestedAssignee = String(input.assignee || '').trim();
  const currentAssignee = String(spec.assignee || executionProfile || 'default').trim();
  const recommendedAssignee = chooseProfile(tags, spawnableProfiles, executionProfile || currentAssignee || 'default');
  const workers = recommendedWorkers(tags, spawnableProfiles);
  const hints = capabilityHints(tags, inventory);
  const swarmRecommended = tags.length >= 3 || (tags.includes('cron') && (tags.includes('code-change') || tags.includes('verification')));
  const plan = {
    id: hashPlan(`${board}\n${combined}\n${tags.join(',')}`),
    board,
    generatedAt: new Date().toISOString(),
    tags,
    requestedAssignee: requestedAssignee || null,
    currentAssignee,
    recommendedAssignee,
    shouldOverrideAssignee: !requestedAssignee && ['default', 'planner'].includes(currentAssignee) && recommendedAssignee !== currentAssignee,
    swarmRecommended,
    workers,
    hints,
    guardrails: [
      '기존 Hermes cron jobs.json, gateway service, codex-control.env는 직접 수정하지 말 것',
      'cron 문제는 직접 변경 대신 별도 Kanban 작업으로 분리할 것',
      'Spark는 읽기 조사/분류/검증에 우선 사용하고 구현/복구는 안정 프로필을 사용할 것',
    ],
    inventorySummary: {
      profiles: inventory.spawnableProfiles.length,
      enabledPlugins: inventory.plugins.enabled.length,
      mcpServers: inventory.mcpServers.length,
      skills: inventory.skills.length,
      cronEnabled: inventory.cron.enabled,
      cronTotal: inventory.cron.total,
      cronRecentOk: inventory.cron.recentOk,
    },
  };
  auditPlan(plan);
  return plan;
}

function renderCapabilitySection(plan) {
  if (!plan) return '';
  const lines = [
    'Capability Planner:',
    `- 추천 담당 profile: ${plan.recommendedAssignee}`,
    `- 감지 태그: ${plan.tags.length ? plan.tags.join(', ') : 'none'}`,
    `- 병렬 권장: ${plan.swarmRecommended ? 'yes' : 'no'}`,
    `- 현재 inventory: profiles=${plan.inventorySummary.profiles}, plugins=${plan.inventorySummary.enabledPlugins}, mcp=${plan.inventorySummary.mcpServers}, skills=${plan.inventorySummary.skills}, cron=${plan.inventorySummary.cronRecentOk}/${plan.inventorySummary.cronTotal} ok`,
    '- 추천 capability:',
    ...plan.hints.map((hint) => `  - ${hint.kind}:${hint.name} - ${hint.reason}`),
  ];
  if (plan.workers.length) {
    lines.push('- 추천 병렬 worker:');
    for (const worker of plan.workers) lines.push(`  - ${worker.profile}: ${worker.title}`);
  }
  lines.push('- 운영 경계:');
  for (const item of plan.guardrails) lines.push(`  - ${item}`);
  return lines.join('\n');
}

function auditPlan(plan) {
  try {
    ensureStateDir();
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({
      at: new Date().toISOString(),
      id: plan.id,
      board: plan.board,
      tags: plan.tags,
      recommendedAssignee: plan.recommendedAssignee,
      swarmRecommended: plan.swarmRecommended,
      inventorySummary: plan.inventorySummary,
    })}\n`);
  } catch {
    // Planner must never break queue creation because audit logging failed.
  }
}

module.exports = {
  planCapabilities,
  renderCapabilitySection,
  getInventory,
};