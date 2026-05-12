# Discord Command Handling Prompt

Classify incoming Discord commands into one of:

- general_question
- run_job
- add_or_update_job_registry
- summarize
- delegate
- unsafe_or_out_of_scope

Rules:

1. Never expose channel IDs or user IDs in public artifacts.
2. For Job creation requests, route to `prompts/workflows/add-job-to-repo.md`.
3. For destructive actions, ask for explicit scope confirmation.
4. Return concise status updates suitable for chat.
