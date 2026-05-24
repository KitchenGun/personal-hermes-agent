# Changelog

## Unreleased

- Discord 작업 지시 채널의 메시지를 Kanban 작업 큐로만 라우팅하는 `queue_intake_guard` 플러그인을 추가.
- Discord `/workout` 명령 플러그인을 추가해 운동기록/인바디 기록을 지정 채널에서 Google Sheets로 라우팅하도록 구현.
- `/workout` native Discord slash 자동 등록을 기본 비활성화해 slash sync 상태와 텍스트 hook 처리 경로가 충돌하지 않도록 조정.
- 현재 Hermes Agent 상태 문서(`docs/12-current-hermes-status.md`)와 매주 토요일 갱신 Job(`weekly_hermes_agent_status_update`)을 추가.
- 운동 일정 자동화 안전장치(`workout_automation_safeguards`)를 Job Registry에 추가하고, 확인 토큰·Sheets gid·Calendar upsert 안전 기준을 문서화.
- 날짜별 Job Registry 카탈로그를 `docs/job-registry.md` 단일 기준 문서로 통합.
- README에 현재 Orchestrator / Profile 구조를 추가하고 `config/hermes.example.yaml`, architecture 문서, gateway/job registry 경계를 연결.
- 2026-05-13 기준 추가 Job 4개(`daily_calendar_briefing`, `mail_notify_discord`, `daily_game_jobs_crawl_to_sheets`, `weekly_game_jobs_digest`)를 sanitized Job Registry 예시로 반영.
- `daily_weather_report` 공개 schedule을 매일 08:00 기준으로 갱신.
- README, docs/02-jobs.md, jobs README에서 Job Registry 카탈로그 링크를 단일 기준 문서로 연결.
- 공개용 sanitized Hermes 운영 프로필 저장소로 재구성.
- 요청된 docs 파일명(`00-overview.md` ~ `10-operation-guide.md`) 추가.
- Hermes 대화 기반 Job Registry 구조와 예시 Job YAML 추가.
- prompts/system, prompts/agents, prompts/workflows, prompts/templates 구조 보강.
- config, scripts, skills README와 안전한 placeholder 예시 보강.
- Gateway, Job flow, Architecture Mermaid 다이어그램 갱신.
- SECURITY.md 추가 및 secret/state/log publish 금지 원칙 명시.
