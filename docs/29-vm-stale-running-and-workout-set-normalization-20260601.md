# VM Codex Control stale running 및 운동 단위 표기 개선 - 2026-06-01

## 결정
- Codex Control supervisor는 ready 작업이 없어도 running 작업이 있으면 `hermes kanban dispatch --max 0`을 호출한다.
- 이 maintenance dispatch는 새 worker를 만들지 않고 Kanban 내부의 stale claim, heartbeat stale, crashed worker 감지만 실행한다.
- 운동 기록 요약과 운동 출력은 `회`/`세트` 접미사를 정규화해 `10회회`, `3세트세트` 중복 표기를 막는다.

## 원인
- Kanban에는 `detect_crashed_workers()`가 이미 있었지만 dashboard supervisor가 `dispatchable_ready=0`이면 dispatch를 생략했다.
- editor worker가 최종 보고서 작성 후 API overload로 종료되자 PID는 죽었지만 dispatch가 호출되지 않아 task가 running으로 남았다.

## 검증
- `node --check ops/codex-control-dashboard/server.js`
- `node ops/codex-control-dashboard/server-cache-backoff.test.js`
- `python3 -m py_compile` for workout runtime/managed/startup guard
- `HERMES_HOME=/home/ubuntu/.hermes python3 /home/ubuntu/.hermes/scripts/ensure_workout_weekly_plugin.py`
- managed/runtime workout.py byte parity

## 추가 Hermes 런타임 보정
- `/home/ubuntu/.hermes/hermes-agent/hermes_cli/kanban.py`: CLI `hermes kanban dispatch`도 `kanban.dispatch_stale_timeout_seconds` 기본값을 읽어 `dispatch_once`에 전달하도록 보정.
- `/home/ubuntu/.hermes/hermes-agent/gateway/run.py`: gateway dispatcher에서 누락/잘못된 stale timeout 값이 0으로 비활성화되지 않고 기본 14400초로 폴백하도록 보정.
- 명시적으로 `dispatch_stale_timeout_seconds: 0`을 설정한 경우에는 기존처럼 비활성화를 허용한다.

## 영속화
- `ops/codex-control-dashboard/ensure-kanban-stale-timeout-policy.py`를 추가하고 런타임 `/home/ubuntu/.hermes/scripts/ensure_kanban_stale_timeout_policy.py`에 동기화했다.
- `hermes-gateway.service` drop-in에 해당 ensure script를 `ExecStartPre`로 추가해 Hermes 업데이트 후에도 stale timeout 보정이 유지되게 했다.
- 런타임 `/etc/systemd/system/hermes-gateway.service`의 현재 systemd 버전 미지원 키 `RestartMaxDelaySec`, `RestartSteps`는 제거해 재시작 로그 warning을 없앴다.
