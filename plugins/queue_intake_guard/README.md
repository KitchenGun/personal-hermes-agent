# queue_intake_guard

Discord task-intake channel guard for Hermes Kanban.

Messages in configured Discord channels are converted into Kanban tasks and then skipped so Hermes does not execute them directly.

```yaml
plugins:
  enabled:
    - queue_intake_guard

queue_intake:
  enabled: true
  board: codex-control
  assignee: planner
  priority: 70
  discord:
    channel_ids:
      - "<TASK_QUEUE_CHANNEL_ID>"
    ack: true

discord:
  free_response_channels: "<TASK_QUEUE_CHANNEL_ID>"
  no_thread_channels: "<TASK_QUEUE_CHANNEL_ID>"
```

The same channel should be listed in `discord.free_response_channels` and `discord.no_thread_channels`; otherwise Discord mention handling can auto-create a Hermes thread before the queue guard gets a chance to skip direct execution.

Accepted message forms:

- `제목 AI 뉴스 보고서 한글화`
- `[queue] 제목 AI 뉴스 보고서 한글화`
- `/queue AI 뉴스 보고서 한글화`
- `제목: AI 뉴스 보고서 한글화`
- `담당: coder`
- `우선순위: 80`

No secrets or real Discord channel IDs belong in this repository.
