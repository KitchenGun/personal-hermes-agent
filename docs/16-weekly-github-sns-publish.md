# Weekly GitHub SNS Publish

This document records the public-safe v1 design for weekly GitHub commit based SNS publishing.

## Operating Model

- `weekly_github_summary` remains a markdown summary job.
- `weekly_github_sns_publish` creates sanitized platform drafts and a review task.
- The default write path is browser handoff, not API publishing.
- Publishing requires a state-machine approval, not free text.
- X, LinkedIn, Facebook, and Instagram can be opened as logged-in browser compose sessions without storing platform OAuth tokens.
- LinkedIn/X API publishing remains optional and disabled by default.
- Instagram handoff copies the caption and opens the create flow; the user still selects media and clicks Post.

## Runtime State

The runner stores state outside the repository, under `SNS_AUTOMATION_STATE_DIR` or `~/.hermes/state/weekly-github-sns`.

Stored state:

- `ledger.json`: run status, platform status, idempotency keys, and token hashes.
- `audit.jsonl`: append-only sanitized audit events.

Never store OAuth tokens, refresh tokens, API keys, cookies, raw diffs, private paths, stdout/stderr, or raw task bodies in these files.

## Approval Flow

1. Draft mode calculates a fixed scheduled window.
2. GitHub activity is collected with the API first and metadata-only `git` fallback.
3. Sanitization runs before draft generation.
4. A review token is generated and only its hash is stored.
5. Approval is accepted through `POST /api/sns/approval` or Discord `/sns confirm <token>`.
6. The token is bound to `draft_hash`, targets, and scheduled window.
7. `compose` mode refuses to run unless the ledger state is approved.
8. X opens `x.com/intent/tweet`; LinkedIn/Facebook/Instagram open compose handoff pages and copy the draft to the clipboard.
9. The user clicks the final platform Post button.

## CLI

```bash
node scripts/weekly_github_sns_publish.js \
  --mode draft \
  --scheduled-at 2026-05-29T18:30:00+09:00 \
  --targets linkedin,x,facebook,instagram \
  --manual-handoff

node scripts/weekly_github_sns_publish.js \
  --mode approval \
  --approval-token "<REVIEW_TOKEN>"

node scripts/weekly_github_sns_publish.js \
  --mode compose \
  --run-id "<RUN_ID>" \
  --targets linkedin,x,facebook,instagram

node scripts/weekly_github_sns_publish.js \
  --mode confirm-posted \
  --run-id "<RUN_ID>" \
  --targets linkedin,x,facebook,instagram

node scripts/weekly_github_sns_publish.js \
  --mode meta-check
```

## Meta API Path

Facebook Page and Instagram API publishing are supported only when explicitly enabled.

Required Facebook Page runtime values:

- `SNS_FACEBOOK_PUBLISH_ENABLED=1`
- `SNS_FACEBOOK_PAGE_ID`
- `SNS_FACEBOOK_PAGE_ACCESS_TOKEN`
- Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.

Required Instagram runtime values:

- `SNS_INSTAGRAM_PUBLISH_ENABLED=1`
- `SNS_INSTAGRAM_USER_ID`
- `SNS_INSTAGRAM_ACCESS_TOKEN` or `SNS_FACEBOOK_PAGE_ACCESS_TOKEN`
- `SNS_INSTAGRAM_MEDIA_URL` pointing to a public image/video URL.
- Permissions: `instagram_basic`, `instagram_content_publish`, plus Page access for the linked Facebook Page.

Use `--mode meta-check` to return a sanitized readiness report. It never prints token values.

## Acceptance

- Dry-run mode performs no SNS write API calls.
- Wrong, expired, or mismatched approval tokens do not publish.
- Browser handoff mode performs no SNS API write calls and stores no platform OAuth tokens.
- LinkedIn draft text is copied to the local clipboard; X draft text is encoded into the intent URL.
- Facebook draft text is copied to the local clipboard.
- Instagram caption text is copied to the local clipboard and requires user-selected media.
- Final platform Post clicks remain user-controlled.
- Meta API publish mode is disabled unless explicit publish flags and VM-local tokens are present.
- Retry uses the ledger idempotency key before attempting provider writes.
- Timeout marks a target `reconcile_required` instead of blindly retrying.
- Public dashboard responses expose only sanitized status, never raw draft bodies or credentials.
