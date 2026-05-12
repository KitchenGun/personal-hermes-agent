# Add Job to Repository Workflow

Use this workflow when the user asks Hermes to add or update an automation Job.

## Steps

1. Parse the user's request into purpose, cadence, inputs, tools, output destination, and safety constraints.
2. Choose a registry path under `jobs/daily`, `jobs/weekly`, `jobs/monitoring`, `jobs/research`, or `jobs/maintenance`.
3. Create or update a YAML file with required fields:
   - `name`
   - `description`
   - `schedule`
   - `trigger`
   - `input`
   - `steps`
   - `output`
   - `tools`
   - `model`
   - `safety`
   - `status`
4. Use placeholders only (`<YOUR_...>` or `${...}`).
5. Run registry validation and secret scan.
6. Report changed files and any issues to the user.

## Safety

Do not copy real `.env`, tokens, OAuth data, channel IDs, memory, sessions, logs, gateway state, or databases into the repo.
