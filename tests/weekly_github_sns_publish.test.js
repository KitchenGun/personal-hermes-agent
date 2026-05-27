'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sns = require('../scripts/weekly_github_sns_publish.js');

function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-github-sns-'));
}

const fixtureCommits = [
  {
    repo: 'KitchenGun/personal-hermes-agent',
    sha: 'abcdef1234567890',
    short_sha: 'abcdef1',
    date: '2026-05-27T09:00:00Z',
    subject: 'Add automation without leaking sk-testSecretValue or person@example.com github_pat_1234567890abcdefghij1234567890abcdef',
    private: false,
    source: 'fixture',
  },
  {
    repo: 'KitchenGun/personal-hermes-agent',
    sha: 'fedcba1234567890',
    short_sha: 'fedcba1',
    date: '2026-05-27T09:30:00Z',
    subject: 'Rotate Discord webhook https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz.ABCDEFGHIJKLMNOPQRSTUVWXYZ_123',
    private: false,
    source: 'fixture',
  },
  {
    repo: 'KitchenGun/private-work',
    sha: '1234567890abcdef',
    short_sha: '1234567',
    date: '2026-05-27T10:00:00Z',
    subject: 'Internal path C:\\Users\\name\\secret and customer work',
    private: true,
    source: 'fixture',
  },
];

test('draft mode sanitizes commits and stores only approval token hash', async () => {
  const stateDir = tempStateDir();
  const result = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin,x,facebook,instagram',
    dryRun: true,
    commits: fixtureCommits,
  });

  assert.equal(result.run.status, 'pending_review');
  assert.equal(result.run.summary.commit_count, 2);
  assert.equal(result.run.summary.blocked_count, 1);
  assert.ok(result.approval_token);
  assert.equal(result.run.approval.token_hash.includes(result.approval_token), false);

  const serialized = JSON.stringify(sns.loadLedger(stateDir));
  assert.equal(serialized.includes('sk-testSecretValue'), false);
  assert.equal(serialized.includes('person@example.com'), false);
  assert.equal(serialized.includes('github_pat_'), false);
  assert.equal(serialized.includes('discord.com/api/webhooks'), false);
  assert.equal(serialized.includes('C:\\Users\\name'), false);
  assert.equal(serialized.includes(result.approval_token), false);
});

test('GitHub API collector marks private repository commits as private', async () => {
  const requests = [];
  const commits = await sns.collectGitHubApiMetadata({
    repos: ['KitchenGun/private-work'],
    since: '2026-05-22T09:30:00.000Z',
    until: '2026-05-29T09:30:00.000Z',
    token: 'token',
    requester: async (pathname) => {
      requests.push(pathname);
      if (pathname === '/repos/KitchenGun/private-work') return { private: true };
      return [
        {
          sha: '1234567890abcdef',
          commit: {
            author: { date: '2026-05-27T10:00:00Z' },
            message: 'Internal launch notes',
          },
        },
      ];
    },
  });

  assert.equal(requests[0], '/repos/KitchenGun/private-work');
  assert.equal(commits[0].private, true);
  const sanitized = sns.sanitizeCommits(commits);
  assert.equal(sanitized.commits[0].blocked, true);
  assert.equal(JSON.stringify(sanitized).includes('Internal launch notes'), false);
});

test('re-running the same scheduled draft keeps a valid fixed window', async () => {
  const stateDir = tempStateDir();
  const first = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin',
    dryRun: true,
    commits: fixtureCommits,
  });
  const second = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin',
    dryRun: true,
    commits: fixtureCommits,
  });

  assert.equal(first.run.scheduled_window.since, second.run.scheduled_window.since);
  assert.equal(first.run.scheduled_window.until, second.run.scheduled_window.until);
});

test('approval blocks wrong tokens and detects binding mismatch', async () => {
  const stateDir = tempStateDir();
  const draft = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin',
    dryRun: true,
    commits: fixtureCommits,
  });

  const wrong = await sns.approveRun({
    stateDir,
    runId: draft.run.run_id,
    token: 'wrong-token',
    decision: 'confirm',
  });
  assert.equal(wrong.status, 'blocked');

  const mismatch = await sns.approveRun({
    stateDir,
    runId: draft.run.run_id,
    token: draft.approval_token,
    draftHash: 'not-the-draft-hash',
    decision: 'confirm',
  });
  assert.equal(mismatch.status, 'needs_reapproval');
});

test('dry-run publish never calls provider writer', async () => {
  const stateDir = tempStateDir();
  const draft = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin',
    dryRun: true,
    commits: fixtureCommits,
  });
  await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });

  let calls = 0;
  const result = await sns.publishRun({
    stateDir,
    runId: draft.run.run_id,
    targets: 'linkedin',
    publishers: {
      linkedin: async () => {
        calls += 1;
        return { providerPostId: 'should-not-happen' };
      },
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.results[0].status, 'dry_run');
});

test('manual compose requires approval before opening handoff', async () => {
  const stateDir = tempStateDir();
  const draft = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin,x',
    manualHandoff: true,
    commits: fixtureCommits,
  });

  const result = await sns.composeRun({
    stateDir,
    runId: draft.run.run_id,
    targets: 'linkedin,x',
  });

  assert.equal(result.results[0].status, 'blocked');
});

test('manual compose creates tokenless X and LinkedIn handoffs', async () => {
  const stateDir = tempStateDir();
  const draft = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin,x',
    manualHandoff: true,
    commits: fixtureCommits,
  });
  await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });

  const result = await sns.composeRun({
    stateDir,
    runId: draft.run.run_id,
    targets: 'linkedin,x',
  });

  const linkedin = result.results.find((item) => item.target === 'linkedin');
  const x = result.results.find((item) => item.target === 'x');
  assert.equal(linkedin.status, 'compose_ready');
  assert.equal(linkedin.clipboard_required, true);
  assert.equal(linkedin.compose_url, 'https://www.linkedin.com/feed/');
  assert.equal(x.status, 'compose_ready');
  assert.match(x.compose_url, /^https:\/\/x\.com\/intent\/tweet\?text=/);
  assert.equal(JSON.stringify(result).includes('SNS_X_ACCESS_TOKEN'), false);
});

test('manual compose supports Facebook and Instagram browser handoffs without Meta tokens', async () => {
  const stateDir = tempStateDir();
  const draft = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'facebook,instagram',
    manualHandoff: true,
    commits: fixtureCommits,
  });
  await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });

  const result = await sns.composeRun({
    stateDir,
    runId: draft.run.run_id,
    targets: 'facebook,instagram',
  });

  const facebook = result.results.find((item) => item.target === 'facebook');
  const instagram = result.results.find((item) => item.target === 'instagram');
  assert.equal(facebook.status, 'compose_ready');
  assert.equal(facebook.clipboard_required, true);
  assert.match(facebook.compose_url, /^https:\/\/www\.facebook\.com/);
  assert.equal(instagram.status, 'compose_ready');
  assert.equal(instagram.clipboard_required, true);
  assert.equal(instagram.media_required, true);
  assert.match(instagram.compose_url, /^https:\/\/www\.instagram\.com/);
  assert.equal(JSON.stringify(result).includes('SNS_FACEBOOK_ACCESS_TOKEN'), false);
});

test('Meta API publish path is gated by explicit publish flags', async () => {
  const stateDir = tempStateDir();
  const previous = {
    SNS_FACEBOOK_PUBLISH_ENABLED: process.env.SNS_FACEBOOK_PUBLISH_ENABLED,
    SNS_INSTAGRAM_PUBLISH_ENABLED: process.env.SNS_INSTAGRAM_PUBLISH_ENABLED,
    SNS_FACEBOOK_PAGE_ID: process.env.SNS_FACEBOOK_PAGE_ID,
    SNS_INSTAGRAM_USER_ID: process.env.SNS_INSTAGRAM_USER_ID,
    SNS_INSTAGRAM_MEDIA_URL: process.env.SNS_INSTAGRAM_MEDIA_URL,
  };
  process.env.SNS_FACEBOOK_PUBLISH_ENABLED = '1';
  process.env.SNS_INSTAGRAM_PUBLISH_ENABLED = '1';
  process.env.SNS_FACEBOOK_PAGE_ID = 'page_1';
  process.env.SNS_INSTAGRAM_USER_ID = 'ig_1';
  process.env.SNS_INSTAGRAM_MEDIA_URL = 'https://example.com/card.png';
  try {
    const draft = await sns.createDraftRun({
      stateDir,
      scheduledAt: '2026-05-29T09:30:00.000Z',
      targets: 'facebook,instagram',
      commits: fixtureCommits,
    });
    assert.equal(draft.run.platforms.facebook.mode, 'publish');
    assert.equal(draft.run.platforms.instagram.mode, 'publish');
    await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });

    let calls = 0;
    const result = await sns.publishRun({
      stateDir,
      runId: draft.run.run_id,
      targets: 'facebook,instagram',
      publishers: {
        facebook: async () => {
          calls += 1;
          return { providerPostId: 'fb_post_1' };
        },
        instagram: async () => {
          calls += 1;
          return { providerPostId: 'ig_media_1' };
        },
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.results.find((item) => item.target === 'facebook').status, 'posted');
    assert.equal(result.results.find((item) => item.target === 'instagram').status, 'posted');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('Meta permission report never exposes token values', async () => {
  const previous = {
    SNS_META_USER_ACCESS_TOKEN: process.env.SNS_META_USER_ACCESS_TOKEN,
    SNS_FACEBOOK_PAGE_ACCESS_TOKEN: process.env.SNS_FACEBOOK_PAGE_ACCESS_TOKEN,
    SNS_FACEBOOK_PAGE_ID: process.env.SNS_FACEBOOK_PAGE_ID,
    SNS_INSTAGRAM_USER_ID: process.env.SNS_INSTAGRAM_USER_ID,
    SNS_INSTAGRAM_MEDIA_URL: process.env.SNS_INSTAGRAM_MEDIA_URL,
  };
  process.env.SNS_META_USER_ACCESS_TOKEN = 'meta-user-token-secret';
  process.env.SNS_FACEBOOK_PAGE_ACCESS_TOKEN = 'page-token-secret';
  process.env.SNS_FACEBOOK_PAGE_ID = 'page_1';
  process.env.SNS_INSTAGRAM_USER_ID = 'ig_1';
  process.env.SNS_INSTAGRAM_MEDIA_URL = 'https://example.com/card.png';
  try {
    const report = await sns.metaPermissionReport({
      requester: async (url) => {
        if (url.includes('/me/permissions')) {
          return {
            data: [
              { permission: 'pages_show_list', status: 'granted' },
              { permission: 'pages_read_engagement', status: 'granted' },
              { permission: 'pages_manage_posts', status: 'granted' },
              { permission: 'instagram_basic', status: 'granted' },
              { permission: 'instagram_content_publish', status: 'granted' },
            ],
          };
        }
        if (url.includes('/me/accounts')) {
          return { data: [{ id: 'page_1', name: 'Page', instagram_business_account: { id: 'ig_1', username: 'ig' } }] };
        }
        return { id: 'page_1', name: 'Page', instagram_business_account: { id: 'ig_1', username: 'ig' } };
      },
    });
    const serialized = JSON.stringify(report);
    assert.equal(report.env.meta_user_token, true);
    assert.equal(report.env.facebook_page_token, true);
    assert.equal(report.ready.facebook_page_publish, true);
    assert.equal(report.ready.instagram_publish, true);
    assert.equal(serialized.includes('meta-user-token-secret'), false);
    assert.equal(serialized.includes('page-token-secret'), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('manual compose can be marked user-confirmed posted', async () => {
  const stateDir = tempStateDir();
  const draft = await sns.createDraftRun({
    stateDir,
    scheduledAt: '2026-05-29T09:30:00.000Z',
    targets: 'linkedin',
    manualHandoff: true,
    commits: fixtureCommits,
  });
  await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });
  await sns.composeRun({ stateDir, runId: draft.run.run_id, targets: 'linkedin' });

  const confirmed = await sns.confirmManualPost({
    stateDir,
    runId: draft.run.run_id,
    targets: 'linkedin',
  });

  assert.equal(confirmed.results[0].status, 'user_confirmed_posted');
  const ledger = sns.loadLedger(stateDir);
  assert.equal(ledger.runs[0].platforms.linkedin.status, 'user_confirmed_posted');
});

test('publish mode is idempotent after first successful provider post', async () => {
  const stateDir = tempStateDir();
  const previous = {
    SNS_LINKEDIN_PUBLISH_ENABLED: process.env.SNS_LINKEDIN_PUBLISH_ENABLED,
    SNS_LINKEDIN_AUTHOR_URN: process.env.SNS_LINKEDIN_AUTHOR_URN,
  };
  process.env.SNS_LINKEDIN_PUBLISH_ENABLED = '1';
  process.env.SNS_LINKEDIN_AUTHOR_URN = 'urn:li:person:test';
  try {
    const draft = await sns.createDraftRun({
      stateDir,
      scheduledAt: '2026-05-29T09:30:00.000Z',
      targets: 'linkedin',
      commits: fixtureCommits,
    });
    await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });

    let calls = 0;
    const publishers = {
      linkedin: async () => {
        calls += 1;
        return { providerPostId: 'urn:li:share:1' };
      },
    };
    const first = await sns.publishRun({ stateDir, runId: draft.run.run_id, targets: 'linkedin', publishers });
    const second = await sns.publishRun({ stateDir, runId: draft.run.run_id, targets: 'linkedin', publishers });

    assert.equal(calls, 1);
    assert.equal(first.results[0].status, 'posted');
    assert.equal(second.results[0].status, 'posted');
    assert.equal(second.results[0].skipped, true);
  } finally {
    if (previous.SNS_LINKEDIN_PUBLISH_ENABLED === undefined) delete process.env.SNS_LINKEDIN_PUBLISH_ENABLED;
    else process.env.SNS_LINKEDIN_PUBLISH_ENABLED = previous.SNS_LINKEDIN_PUBLISH_ENABLED;
    if (previous.SNS_LINKEDIN_AUTHOR_URN === undefined) delete process.env.SNS_LINKEDIN_AUTHOR_URN;
    else process.env.SNS_LINKEDIN_AUTHOR_URN = previous.SNS_LINKEDIN_AUTHOR_URN;
  }
});

test('re-drafting a posted scheduled window does not reset posted state', async () => {
  const stateDir = tempStateDir();
  const previous = {
    SNS_LINKEDIN_PUBLISH_ENABLED: process.env.SNS_LINKEDIN_PUBLISH_ENABLED,
    SNS_LINKEDIN_AUTHOR_URN: process.env.SNS_LINKEDIN_AUTHOR_URN,
  };
  process.env.SNS_LINKEDIN_PUBLISH_ENABLED = '1';
  process.env.SNS_LINKEDIN_AUTHOR_URN = 'urn:li:person:test';
  try {
    const draft = await sns.createDraftRun({
      stateDir,
      scheduledAt: '2026-05-29T09:30:00.000Z',
      targets: 'linkedin',
      commits: fixtureCommits,
    });
    await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });

    let calls = 0;
    const publishers = {
      linkedin: async () => {
        calls += 1;
        return { providerPostId: 'urn:li:share:1' };
      },
    };
    await sns.publishRun({ stateDir, runId: draft.run.run_id, targets: 'linkedin', publishers });

    const redraft = await sns.createDraftRun({
      stateDir,
      scheduledAt: '2026-05-29T09:30:00.000Z',
      targets: 'linkedin',
      commits: fixtureCommits,
    });
    const second = await sns.publishRun({ stateDir, runId: draft.run.run_id, targets: 'linkedin', publishers });

    assert.equal(redraft.approval_token, null);
    assert.equal(calls, 1);
    assert.equal(second.results[0].status, 'posted');
    assert.equal(second.results[0].skipped, true);
  } finally {
    if (previous.SNS_LINKEDIN_PUBLISH_ENABLED === undefined) delete process.env.SNS_LINKEDIN_PUBLISH_ENABLED;
    else process.env.SNS_LINKEDIN_PUBLISH_ENABLED = previous.SNS_LINKEDIN_PUBLISH_ENABLED;
    if (previous.SNS_LINKEDIN_AUTHOR_URN === undefined) delete process.env.SNS_LINKEDIN_AUTHOR_URN;
    else process.env.SNS_LINKEDIN_AUTHOR_URN = previous.SNS_LINKEDIN_AUTHOR_URN;
  }
});

test('provider timeout moves target to reconcile_required', async () => {
  const stateDir = tempStateDir();
  const previous = process.env.SNS_LINKEDIN_PUBLISH_ENABLED;
  process.env.SNS_LINKEDIN_PUBLISH_ENABLED = '1';
  try {
    const draft = await sns.createDraftRun({
      stateDir,
      scheduledAt: '2026-05-29T09:30:00.000Z',
      targets: 'linkedin',
      commits: fixtureCommits,
    });
    await sns.approveRun({ stateDir, token: draft.approval_token, decision: 'confirm' });

    const result = await sns.publishRun({
      stateDir,
      runId: draft.run.run_id,
      targets: 'linkedin',
      publishers: {
        linkedin: async () => {
          throw new Error('provider timeout');
        },
      },
    });

    assert.equal(result.results[0].status, 'reconcile_required');
  } finally {
    if (previous === undefined) delete process.env.SNS_LINKEDIN_PUBLISH_ENABLED;
    else process.env.SNS_LINKEDIN_PUBLISH_ENABLED = previous;
  }
});
