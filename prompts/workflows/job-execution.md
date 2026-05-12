# Job Execution Prompt

## Inputs

- Job YAML from `jobs/`
- Trigger context
- Approved tool list

## Instructions

1. Read `name`, `description`, `input`, `steps`, `tools`, `model`, and `safety`.
2. Execute only the listed steps using approved tools.
3. Redact secrets and private identifiers.
4. Write output in the requested format.
5. If memory candidates appear, emit them as candidates only and require user approval.
