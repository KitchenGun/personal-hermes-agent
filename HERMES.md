# Hermes Project Context

This repository is a public-safe operating profile for a personal Hermes Agent.

## Rules

- Keep artifacts sanitized: no secrets, tokens, raw memory, logs, sessions, DB dumps, gateway state, or private identifiers.
- Before creating new code or configuration, search local docs/code/tests, installed skills, MCP tools, official docs, and proven public implementations.
- Reuse the smallest safe part that fits local patterns.
- Verify license, security, dependencies, and tests before adopting external code.
- Record repeatable work as `jobs/*.yaml` or `skills/*/SKILL.md`.

## Key Paths

- `docs/`: architecture and operating model.
- `jobs/`: sanitized Job Registry.
- `skills/`: reusable Hermes skills.
- `prompts/`: reusable workflow and system prompts.
- `scripts/examples/`: public-safe validation scripts.
- `ops/`: public-safe VM operations source and deployment examples.

## Validation

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
ops/codex-control-dashboard/dashboard-smoke.sh
```
