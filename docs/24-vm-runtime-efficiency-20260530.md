# VM 런타임 효율화 적용 기록 - 2026-05-30

## 목적

최근 Hermes 업데이트와 운동 자동화 수정이 안정적으로 적용된 상태에서, 기존 cron/job 동작은 유지하면서 idle 상태의 불필요한 polling과 반복 경고를 줄인다.

## 적용 범위

- Codex Control supervisor idle backoff를 1분 시작, 최대 5분으로 확장했다.
- Discord relay 상태 polling을 active/idle/error 상태에 따라 adaptive interval로 바꿨다.
- Codex Control API healthcheck timer를 1분에서 5분으로 완화했다.
- VM live config에서 사용하지 않는 `unreal-mcp`를 disabled 처리하고 VM 경로로 정정했다.
- workout append state에 기존 `last_append`를 유지하면서 최근 20건 `append_history`를 추가했다.
- VM runtime drift audit 스크립트를 추가해 repo/runtime/systemd/MCP 상태를 secret-safe하게 점검한다.
- `hermes-dashboard.service` public-safe user systemd 예시를 repo에 추가했다.

## 적용하지 않은 것

- Hermes cron/job schedule 자체는 변경하지 않았다.
- AI Trends dirty 설정 파일은 기존 변경으로 보고 건드리지 않았다.
- Discord 채널 ID나 Google credential 원문은 문서화하지 않았다.

## 검증

- `node --check ops/codex-control-dashboard/server.js`
- `node --check ops/codex-control-dashboard/discord-relay.js`
- `node ops/codex-control-dashboard/server-cache-backoff.test.js`
- `node ops/codex-control-dashboard/discord-relay-prune.test.js`
- `python -m py_compile` for workout runtime/managed/startup guard
- `ensure_workout_weekly_plugin.py` startup guard smoke
- workout append history 임시 state smoke
- dashboard smoke script
- `/api/summary` and `/api/supervisor` runtime 확인

## 운영 메모

- `hermes-gateway.service`는 system scope다.
- `codex-control-api.service`, `codex-discord-relay.service`, `hermes-dashboard.service`, `codex-control-api-healthcheck.timer`는 user scope다.
- user scope 상태 확인은 `systemctl --user ...`를 사용한다.
- idle 상태에서 작업큐 반응성이 떨어지지 않도록 task create/resume/manual tick은 즉시 tick을 유지한다.

## 정상 서비스 추가 개선 - 2026-05-30

정상 실행 중인 서비스는 직접 실행 경로를 바꾸지 않고, 감시와 복구의 폭을 넓히는 방향으로 개선했다.

- `dashboard-healthcheck.sh`가 `/api/health`뿐 아니라 dashboard root, public summary, authenticated summary를 확인한다.
- relay user service가 inactive이면 healthcheck가 같이 복구한다.
- API 재시작 후 relay가 오래된 secret/env로 403을 내는 상황을 피하기 위해 API 복구 시 relay도 함께 재시작한다.
- gateway unit 자체는 현재 cron/job scheduler와 Discord ingress를 함께 소유하므로 재시작 정책 변경은 보류하고 운영 기준으로만 기록한다.

검증은 `dashboard-healthcheck.sh`, `dashboard-smoke.sh`, service active 상태, 최근 journal warning/error 확인으로 한다.
