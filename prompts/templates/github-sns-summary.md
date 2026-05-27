# GitHub SNS Summary Prompt

Create SNS-ready drafts from a sanitized weekly GitHub activity summary.

Inputs:

- Fixed scheduled window: `{{scheduled_window}}`
- Sanitized commits only: `{{sanitized_commits}}`
- Allowed targets: `{{targets}}`
- Risk report: `{{risk_report}}`

Rules:

- Do not use raw diffs, patches, private clone URLs, local paths, emails, tokens, OAuth values, cookies, logs, or stdout/stderr.
- If private repository activity is present, describe it only as redacted internal work.
- Generate drafts only from sanitized inputs.
- X must pass weighted-character validation.
- LinkedIn, Facebook, and Instagram limits must come from runtime config.
- Facebook and Instagram remain dry-run until official account and permission checks are completed.
- Publish is forbidden unless the runner state is approved for the same draft hash, target list, and scheduled window.

Output:

- Platform draft text
- Target status: `dry_run`, `pending_review`, `blocked`, or `needs_reapproval`
- Short risk report
- Follow-up tasks for missing OAuth scope or platform verification
