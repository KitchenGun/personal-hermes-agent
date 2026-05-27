const boardSelect = document.querySelector('#boardSelect');
const refreshButton = document.querySelector('#refreshButton');
const overallProgress = document.querySelector('#overallProgress');
const currentProgress = document.querySelector('#currentProgress');
const overallBar = document.querySelector('#overallBar');
const currentBar = document.querySelector('#currentBar');
const taskCount = document.querySelector('#taskCount');
const taskBreakdown = document.querySelector('#taskBreakdown');
const currentTask = document.querySelector('#currentTask');
const updatedAt = document.querySelector('#updatedAt');
const queueHint = document.querySelector('#queueHint');
const taskRows = document.querySelector('#taskRows');
const supervisorStatus = document.querySelector('#supervisorStatus');
const supervisorBoard = document.querySelector('#supervisorBoard');
const concurrencyInput = document.querySelector('#concurrencyInput');
const intervalSelect = document.querySelector('#intervalSelect');
const blockedRecoveryInput = document.querySelector('#blockedRecoveryInput');
const recoveryAssigneeInput = document.querySelector('#recoveryAssigneeInput');
const startSupervisor = document.querySelector('#startSupervisor');
const stopSupervisor = document.querySelector('#stopSupervisor');
const tickSupervisor = document.querySelector('#tickSupervisor');
const supervisorLog = document.querySelector('#supervisorLog');

const DEFAULT_SUPERVISOR_INTERVAL_MS = '300000';
let board = 'codex-control';
let timer = null;
let csrfToken = '';

function pct(value) {
  const n = Number(value || 0);
  return `${Math.max(0, Math.min(100, n))}%`;
}

function time(value) {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function unix(value) {
  if (!value) return '-';
  return new Date(Number(value) * 1000).toLocaleString('ko-KR');
}

function statusProgress(status) {
  if (status === 'done' || status === 'archived') return 100;
  if (status === 'running') return 45;
  if (status === 'ready' || status === 'todo' || status === 'triage' || status === 'scheduled') return 15;
  return 0;
}

function ageText(seconds) {
  const n = Number(seconds || 0);
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m`;
  if (n < 86400) return `${Math.floor(n / 3600)}h`;
  return `${Math.floor(n / 86400)}d`;
}

function statusBadge(status) {
  const value = escapeHtml(status || 'unknown');
  return `<span class="status ${value}">${value}</span>`;
}

function progressCell(value, stage = '') {
  const label = pct(value);
  const title = stage ? ` title="${escapeHtml(stage)}"` : '';
  return `<div class="miniProgress"${title}><span>${label}</span><div class="bar"><i style="width:${label}"></i></div></div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function taskMeta(task, includeAssignee = false) {
  const parts = [];
  if (includeAssignee) parts.push(`assignee ${task.assignee || '-'}`);
  parts.push(`age ${ageText(task.age_seconds)}`);
  parts.push(`retries ${task.retry_count || 0}`);
  if (task.updated_at) parts.push(`updated ${time(task.updated_at)}`);
  if (task.sanitized_error_class) parts.push(`error ${task.sanitized_error_class}`);
  return parts.map(escapeHtml).join(' &middot; ');
}

async function loadHealth() {
  const response = await fetch('/api/health');
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'health failed');
  csrfToken = data.csrf_token || '';
}

async function loadBoards() {
  try {
    const response = await fetch('/api/boards');
    const data = await response.json();
    const boards = data.boards?.length ? data.boards : [{ slug: 'codex-control', current: true }];
    const preferred = boards.find((entry) => entry.slug === 'codex-control')
      || boards.find((entry) => entry.current)
      || boards[0];
    boardSelect.innerHTML = boards
      .map((entry) => `<option value="${entry.slug}" ${entry.slug === preferred.slug ? 'selected' : ''}>${entry.slug}</option>`)
      .join('');
    board = preferred.slug || 'codex-control';
  } catch {
    boardSelect.innerHTML = '<option value="codex-control">codex-control</option>';
    board = 'codex-control';
  }
}

function render(data) {
  const summary = data.summary;
  const overall = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  const activeTask = data.tasks.find((task) => task.status !== 'done' && task.status !== 'archived') || data.tasks[0] || null;
  const activeProgress = activeTask ? statusProgress(activeTask.status) : 0;
  overallProgress.textContent = pct(overall);
  currentProgress.textContent = pct(activeProgress);
  overallBar.style.width = pct(overall);
  currentBar.style.width = pct(activeProgress);
  taskCount.textContent = String(summary.total);
  taskBreakdown.textContent = `done ${summary.done} - running ${summary.running} - ready ${summary.ready} - blocked ${summary.blocked}`;
  updatedAt.textContent = `updated ${time(data.updated_at)}`;
  queueHint.textContent = `${data.tasks.length} rows - board ${data.board}`;

  if (activeTask) {
    const task = activeTask;
    currentTask.innerHTML = `
      <div class="taskId">${escapeHtml(task.id)}</div>
      <div>
        <div class="taskTitle">${escapeHtml(task.title)}</div>
        <div class="taskMeta">${taskMeta(task, true)}</div>
      </div>
      <div>${statusBadge(task.status)}${progressCell(statusProgress(task.status), task.sanitized_error_class)}</div>
    `;
  } else {
    currentTask.innerHTML = '<div class="taskMeta">No current task.</div>';
  }

  taskRows.innerHTML = data.tasks
    .map(
      (task) => `
        <tr>
          <td class="taskId">${escapeHtml(task.id)}</td>
          <td>
            <div class="taskTitle">${escapeHtml(task.title)}</div>
            <div class="taskMeta">${taskMeta(task)}</div>
          </td>
          <td>${statusBadge(task.status)}</td>
          <td>${escapeHtml(task.assignee || '-')}</td>
          <td>${task.retry_count ?? 0}</td>
          <td>${escapeHtml(ageText(task.age_seconds))}</td>
        </tr>
      `,
    )
    .join('');
}

function renderSupervisor(data) {
  supervisorStatus.textContent = data.enabled
    ? `running - next ${time(data.nextTickAt)}`
    : 'stopped';
  supervisorStatus.className = data.enabled ? 'live' : '';
  supervisorBoard.textContent = data.board;
  concurrencyInput.value = data.concurrency;
  const intervalMs = String(data.intervalMs || DEFAULT_SUPERVISOR_INTERVAL_MS);
  if (!intervalSelect.querySelector(`option[value="${intervalMs}"]`)) {
    const option = document.createElement('option');
    option.value = intervalMs;
    option.textContent = `${intervalMs}ms`;
    intervalSelect.appendChild(option);
  }
  intervalSelect.value = intervalMs;
  blockedRecoveryInput.checked = Boolean(data.blockedRecovery);
  recoveryAssigneeInput.value = data.recoveryAssignee || 'fixer';
  startSupervisor.disabled = data.enabled || data.runningTick;
  stopSupervisor.disabled = !data.enabled;
  tickSupervisor.disabled = data.runningTick;
  const summary = data.lastSummary
    ? `total ${data.lastSummary.total} - running ${data.lastSummary.running} - ready ${data.lastSummary.ready} - blocked ${data.lastSummary.blocked} - recovery ${data.blockedRecovery ? 'on' : 'off'}`
    : 'no tick yet';
  const rows = [
    `<div><b>state</b><span>${escapeHtml(summary)}</span></div>`,
    ...data.logs.slice(0, 8).map((entry) => (
      `<div class="${escapeHtml(entry.level)}"><b>${time(entry.at)}</b><span>${escapeHtml(entry.message)}</span></div>`
    )),
  ];
  supervisorLog.innerHTML = rows.join('');
}

async function loadState() {
  try {
    const response = await fetch(`/api/summary?board=${encodeURIComponent(board)}`);
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'load failed');
    render(data);
  } catch (error) {
    currentTask.innerHTML = `<div class="taskMeta">${error.message}</div>`;
    taskRows.innerHTML = '';
  }
}

async function loadSupervisor() {
  try {
    const response = await fetch('/api/supervisor');
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'load failed');
    renderSupervisor(data);
  } catch (error) {
    supervisorStatus.textContent = error.message;
  }
}

async function postSupervisor(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-csrf': csrfToken },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'request failed');
  renderSupervisor(data);
  await loadState();
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    loadState();
    loadSupervisor();
  }, 30000);
}

boardSelect.addEventListener('change', () => {
  board = boardSelect.value;
  loadState();
});

refreshButton.addEventListener('click', loadState);

startSupervisor.addEventListener('click', async () => {
  await postSupervisor('/api/supervisor/start', {
    board,
    concurrency: concurrencyInput.value,
    intervalMs: intervalSelect.value,
    blockedRecovery: blockedRecoveryInput.checked,
    recoveryAssignee: recoveryAssigneeInput.value,
  });
});

stopSupervisor.addEventListener('click', async () => {
  await postSupervisor('/api/supervisor/stop');
});

tickSupervisor.addEventListener('click', async () => {
  await postSupervisor('/api/supervisor/tick');
});

await loadHealth();
await loadBoards();
await loadState();
await loadSupervisor();
schedule();
