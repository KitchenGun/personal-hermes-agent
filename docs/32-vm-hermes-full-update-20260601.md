# VM Hermes 전체 업데이트 적용 기록 - 2026-06-01

## 목적

Hermes runtime이 `origin/main`보다 312 commits 뒤처진 상태였고, Tool Search만 선별 반영되어 있었다. VM의 Hermes 본체를 최신 `origin/main`으로 fast-forward 업데이트하고 기존 운영 보정은 guard로 재적용한다.

## 적용 결과

- 업데이트 전: `/home/ubuntu/.hermes/hermes-agent` `main...origin/main [behind 312]`
- 업데이트 후: `main...origin/main`, ahead/behind `0 0`
- 현재 Hermes: `Hermes Agent v0.15.1 (2026.5.29)`, `Up to date`
- 백업: `/home/ubuntu/.hermes/backups/hermes-full-update-20260601T062638Z`

## 보존한 VM 운영 보정

- Discord `/queue`를 Codex Control queue API로 연결하는 bridge
- Kanban stale-running timeout 기본값 보정
- Tool Search 적극 사용 정책: `enabled: on`, `threshold_pct: 0`
- Google Workspace token/client secret 경로를 환경변수로 override 가능하게 하는 보정
- Background review가 운동/캘린더 단발 수정 요청을 불필요한 skill로 저장하지 않게 하는 보정
- Workout weekly plugin이 다른 `cron` 모듈 이름과 충돌해 import 실패하지 않도록 runtime import-shadow 보정

## 재시작 guard

`hermes-gateway.service`의 `ExecStartPre`에서 다음 guard를 실행한다.

- `/home/ubuntu/.hermes/scripts/ensure_codex_control_queue_bridge.py`
- `/home/ubuntu/.hermes/scripts/ensure_kanban_stale_timeout_policy.py`
- `/home/ubuntu/.hermes/scripts/ensure_hermes_tool_search_policy.py`
- `/home/ubuntu/.hermes/scripts/ensure_hermes_google_workspace_env_paths.py`
- `/home/ubuntu/.hermes/scripts/ensure_hermes_background_review_policy.py`
- `/home/ubuntu/.hermes/scripts/ensure_workout_weekly_plugin.py`

## 검증 항목

- `hermes --version`에서 `Up to date` 확인
- Tool Search 테스트 통과
- Python compile 검증
- Discord toolset에 `tool_search`, `tool_describe`, `tool_call` 노출 확인
- Workout weekly plugin load 경고 없음 확인
- gateway 재시작 후 `hermes-gateway.service` active/running 확인
