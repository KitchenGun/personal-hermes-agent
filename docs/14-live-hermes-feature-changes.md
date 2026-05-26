# 14. Live Hermes Feature Changes

이 문서는 VM 핵심 실행 repo `/home/ubuntu/.hermes/hermes-agent`에 쌓인 운영 변경을 public-safe하게 요약하기 위한 변경 기능 README이다.

## 기준

- source of truth: `/home/ubuntu/.hermes/hermes-agent`
- personal profile repo: `personal-hermes-agent`
- WSL 역할: VM SSH tunnel과 보조 검증
- 금지: `.env`, `auth.json`, DB, memories, sessions, logs, raw gateway state, private path 복사

## 2026-05-26 현재 VM change groups

현재 VM live repo에는 다음 기능군 변경이 쌓여 있다.

| 기능군 | 주요 파일 | 요약 |
| --- | --- | --- |
| Workout weekly workflow | `cron/workout.py`, `scripts/workout_weekly_job.py`, `plugins/workout_weekly/`, `tests/cron/test_workout_risk_controls.py` | 주간 운동 자동화와 위험 제어 테스트를 확장 |
| AI agent trend collection | `scripts/ai_agent_trend_collector.py`, `jobs/daily/daily_ai_agent_trend_collector.yaml`, `jobs/weekly/weekly_ai_agent_trend_digest.yaml`, `docs/ai-agent-trends/` | AI agent trend 수집/주간 요약 job과 운영 문서 추가 |
| Google Calendar bridge | `plugins/google_calendar_bridge/`, `tests/plugins/test_google_calendar_bridge.py` | Google Calendar 연동 bridge plugin 추가 |
| Discord/gateway/profile commands | `gateway/`, `hermes_cli/`, `cron/profile_update.py`, `tests/gateway/test_profile_update_command.py` | Discord command, gateway, profile update 흐름 확장 |
| Kanban queue and heartbeat | `hermes_cli/kanban.py`, `hermes_cli/kanban_queue.py`, `prompts/codex-kanban-heartbeat-inspector.*`, `tests/hermes_cli/test_kanban_queue.py` | Kanban queue와 heartbeat inspector prompt/schema 추가 |
| Memory tool behavior | `tools/memory_tool.py`, `tests/tools/`, `website/docs/user-guide/features/memory.md` | Memory tool schema/behavior와 문서 보강 |
| Codex app transport | `agent/transports/codex_app_server_session.py`, `tests/agent/transports/test_codex_app_server_session.py` | Codex app server session transport 테스트와 동작 보강 |

## Commit plan

권장 커밋 단위:

1. `feat: add workout weekly cron workflow and risk controls`
2. `feat: add AI trend jobs and google calendar bridge`
3. `feat: extend gateway, kanban, memory, and Codex transport`

## Verification plan

VM repo 기준 권장 검증:

```bash
pytest tests/cron/test_workout_risk_controls.py
pytest tests/hermes_cli/test_kanban_queue.py tests/hermes_cli/test_gateway.py tests/hermes_cli/test_kanban_core_functionality.py
pytest tests/gateway/test_discord_slash_commands.py tests/gateway/test_discord_memory_toolset.py tests/gateway/test_profile_update_command.py
pytest tests/tools/test_memory_tool.py tests/tools/test_memory_tool_schema.py
pytest tests/agent/transports/test_codex_app_server_session.py tests/run_agent/test_run_agent.py
pytest tests/plugins/test_google_calendar_bridge.py tests/scripts/test_ai_agent_trend_collector_localization.py tests/test_profile_update.py
```
