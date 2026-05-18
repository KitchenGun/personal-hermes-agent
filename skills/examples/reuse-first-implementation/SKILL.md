# Reuse-First Implementation Skill

## Purpose

Implement changes by finding existing code, tools, skills, or proven public implementations before writing new code.

## When to use

- Feature implementation
- Bug fixes with unclear local patterns
- Automation or tool integration
- Refactors that may duplicate existing behavior

## Inputs

- User request
- Target repository or file scope
- Approved external source constraints
- Validation commands

## Procedure

1. Search local files, docs, tests, and prior implementations.
2. Check available skills, MCP tools, connectors, and plugins.
3. Prefer official docs and SDK examples for external APIs.
4. Compare proven GitHub or package-registry implementations.
5. Reuse the smallest safe part that fits local patterns.
6. Verify license, security, dependencies, and tests.
7. Summarize changed files, validation, and any referenced source.

## Outputs

- Minimal patch or implementation summary
- Referenced sources when external implementations influenced the result
- Validation result

## Safety

Do not copy code with unclear licensing. Do not import secrets, private paths, private memory, logs, sessions, or credentials into public artifacts.
