# Repository Maintenance Template

## Goal
Review a public template repository for documentation quality and safety.

## Checks
- README completeness
- docs 00~10 presence
- example config uses placeholders only
- no runtime state, logs, sessions, DB, or secrets

## Output Format
```json
{
  "status": "ok|needs_attention",
  "findings": [],
  "recommended_changes": []
}
```
