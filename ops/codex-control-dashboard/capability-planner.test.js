const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function makeHermesHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-planner-'));
  fs.mkdirSync(path.join(home, 'cron'), { recursive: true });
  fs.mkdirSync(path.join(home, 'kanban', 'boards', 'codex-control'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'plugins:\n  enabled: []\nmcp_servers:\n');
  fs.writeFileSync(path.join(home, 'cron', 'jobs.json'), JSON.stringify({ jobs: [] }));
  return home;
}

function createRunDb(home, rows) {
  const db = path.join(home, 'kanban', 'boards', 'codex-control', 'kanban.db');
  const script = `
import sqlite3, sys
rows = ${JSON.stringify(rows)}
con = sqlite3.connect(sys.argv[1])
con.execute('create table task_runs (id integer primary key, task_id text, profile text, status text, started_at integer, ended_at integer, outcome text)')
for row in rows:
    con.execute('insert into task_runs(task_id, profile, status, started_at, ended_at, outcome) values (?, ?, ?, ?, ?, ?)', row)
con.commit()
`;
  execFileSync('python3', ['-c', script, db]);
}

function loadPlanner(home) {
  process.env.HERMES_HOME = home;
  delete require.cache[require.resolve('./capability-planner')];
  return require('./capability-planner');
}

function testRoutesAroundPoorRecentFailureRate() {
  const home = makeHermesHome();
  createRunDb(home, [
    ['t1', 'coder', 'crashed', 100, 160, 'crashed'],
    ['t2', 'coder', 'timed_out', 200, 2000, 'timed_out'],
    ['t3', 'coder', 'blocked', 300, 600, 'blocked'],
    ['t4', 'coder', 'crashed', 400, 450, 'crashed'],
    ['t5', 'fixer', 'completed', 100, 180, 'completed'],
    ['t6', 'fixer', 'done', 200, 280, 'completed'],
    ['t7', 'fixer', 'completed', 300, 380, 'completed'],
    ['t8', 'fixer', 'completed', 400, 500, 'completed'],
  ]);
  const planner = loadPlanner(home);
  const plan = planner.planCapabilities({
    board: 'codex-control',
    spawnableProfiles: ['coder', 'fixer', 'researcher'],
    executionProfile: 'planner',
    input: { title: 'Implement code change' },
    spec: {},
  });
  assert.equal(plan.recommendedAssignee, 'fixer');
  assert.equal(plan.routingWeights.selectedProfile, 'fixer');
  assert.equal(plan.routingWeights.baseProfile, 'coder');
  assert.ok(plan.routingWeights.profiles.coder.failed >= 3);
  assert.ok(plan.routingWeights.profiles.fixer.completed >= 4);
  const section = planner.renderCapabilitySection(plan);
  assert.match(section, /라우팅 가중치:/);
  assert.match(section, /fixer selected/);
  assert.match(section, /coder: sample=4/);
  const statsPath = path.join(home, 'state', 'capability-planner', 'profile-routing-stats.json');
  assert.ok(fs.existsSync(statsPath));
}

function testKeepsHeuristicWhenDataInsufficient() {
  const home = makeHermesHome();
  createRunDb(home, [
    ['t1', 'coder', 'completed', 100, 160, 'completed'],
    ['t2', 'fixer', 'completed', 200, 240, 'completed'],
  ]);
  const planner = loadPlanner(home);
  const plan = planner.planCapabilities({
    board: 'codex-control',
    spawnableProfiles: ['coder', 'fixer'],
    executionProfile: 'planner',
    input: { title: 'Implement code change' },
    spec: {},
  });
  assert.equal(plan.recommendedAssignee, 'coder');
  assert.equal(plan.routingWeights.reason, 'insufficient-data');
}

testRoutesAroundPoorRecentFailureRate();
testKeepsHeuristicWhenDataInsufficient();
console.log('capability-planner tests passed');
