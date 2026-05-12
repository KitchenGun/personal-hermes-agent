# Code Review Skill

## Purpose

Review code or repository changes for correctness, maintainability, security, and test coverage.

## When to use

- Pull request review
- Local diff review
- Public example repository hygiene checks

## Inputs

- Changed files or diff
- Project conventions
- Test/validation commands

## Procedure

1. Inspect the relevant files and diff.
2. Identify correctness, security, and maintainability issues.
3. Check tests or validation output when available.
4. Recommend minimal actionable fixes.
5. Separate blocking issues from suggestions.

## Outputs

- Findings with severity
- Verified commands
- Suggested patch or checklist

## Safety

Do not expose secrets from diffs. If a secret-like value appears, stop and report a redacted finding.
