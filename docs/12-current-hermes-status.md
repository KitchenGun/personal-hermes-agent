# 12. Current Hermes Agent Status

Last verified: 2026-05-22 Asia/Seoul

This document records a public-safe snapshot of the local Hermes Agent health. It intentionally excludes raw local paths, tokens, sessions, logs, database state, Discord IDs, and gateway state.

## Status Summary

| Check | Result |
| --- | --- |
| Hermes CLI | PASS |
| Hermes version | `Hermes Agent v0.14.0 (2026.5.16)` |
| Update state | Up to date |
| ACP readiness | PASS, `Hermes ACP check OK` |
| Python runtime | `Python 3.11.15` |
| OpenAI SDK | `2.24.0` |
| Local path handling | Raw paths are replaced with `<LOCAL_HERMES_AGENT_PATH>` before publication. |
| Public repo posture | No secrets, raw memory, sessions, logs, DB dumps, or gateway state are recorded. |

## Operational Interpretation

- Hermes is currently available as a local CLI.
- ACP health check passes, so Hermes can be treated as ACP-capable by compatible local tools.
- The local Hermes package reports itself as up to date.
- Public documentation should keep runtime details sanitized and record only pass/fail, version, and compatibility facts.

## Weekly Refresh Rule

The weekly status refresh is modeled by `jobs/weekly/weekly_hermes_agent_status_update.yaml`.

The refresh should:

1. Run `hermes --version`.
2. Run `hermes acp --check`.
3. Record only sanitized version/status fields in this document.
4. Run `scripts/examples/scan-for-secrets.sh`.
5. Run `scripts/examples/validate-job-registry.sh`.
6. Commit and publish documentation-only updates after validation passes.

