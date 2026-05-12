# Memory Extraction Prompt

Extract durable memory candidates from sanitized summaries.

Accept only:

- Stable user preferences
- Long-lived project facts
- Repeated workflow patterns

Reject:

- Secrets or credentials
- Raw private messages
- Temporary plans
- Exact personal identifiers

Return YAML candidates with `claim`, `reason`, `source_summary`, and `requires_user_approval: true`.
