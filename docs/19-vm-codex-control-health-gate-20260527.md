# Codex Control worker crash gate (2026-05-27)

## 배경

- swarm dispatch 자체는 병렬로 동작하지만, `openai-codex` 호출 레이어 장애가 나면 모든 worker와 recovery worker가 같은 오류로 연쇄 차단된다.
- 대표 오류는 `Non-streaming API call timed out`, `'NoneType' object is not iterable`, `pid ... not alive` 이다.
- 이 오류는 개별 작업 구현 실패가 아니라 공통 provider/worker 런타임 장애로 분류한다.

## 기존 gate 정책

- `worker_crash_storm` health gate를 `codex-control-dashboard` supervisor에 추가했다.
- 최근 blocked task의 run history에서 시스템성 worker crash가 임계치 이상이면 gate를 active로 둔다.
- 기존 정책은 gate active 동안 신규 dispatch와 blocked recovery 생성을 모두 멈췄다.
- 이는 recovery worker가 같은 오류로 다시 blocked 되는 증폭은 막지만, provider가 회복되어도 window가 지나기 전까지 ready 작업이 진행되지 않는 교착을 만들 수 있다.

## 운영 기본값

- `SUPERVISOR_HEALTH_GATE=1`
- `SUPERVISOR_CRASH_STORM_THRESHOLD=3`
- `SUPERVISOR_CRASH_STORM_WINDOW_SECONDS=3600`
- `SUPERVISOR_CRASH_STORM_SCAN_LIMIT=12`
- `SUPERVISOR_HEALTH_GATE_PROBE_INTERVAL_SECONDS=300`

## 2026-05-27 사건 분석

- `AI Trends 일간/주간 보고 한국어 해설 강화` swarm 하위 작업들이 동시에 시작됐다.
- `researcher`, `devops`, `coder`, `tester`, `fixer` 작업들이 `openai-codex` timeout 또는 `NoneType` 오류 뒤 `pid ... not alive` crash로 blocked 처리됐다.
- 이 상태에서 기존 blocked recovery가 fixer 작업을 추가로 만들었고, fixer도 같은 호출 장애로 blocked 되어 오류가 증폭됐다.
- `hermes kanban show --json` 조회도 일부 tick에서 오래 걸려 supervisor가 task detail 조회에 매달릴 수 있었다.

## 합의된 수정

- health gate의 task detail 조회는 `hermes kanban show --json` 대신 SQLite read-only helper로 수행한다.
- 시스템성 worker failure 원본에는 fixer recovery를 만들지 않고 `CODEX_RECOVERY_SKIPPED_SYSTEMIC_WORKER` 주석만 남긴다.
- gate active 중에는 recovery 생성은 계속 막는다.
- 단, 완전 정지 대신 `SUPERVISOR_HEALTH_GATE_PROBE_INTERVAL_SECONDS` backoff 뒤 ready 작업 1개만 `failure-limit=1`로 dispatch한다.
- 이 half-open probe는 provider/worker 레이어가 회복됐는지 확인하기 위한 제한적 재개다.
- probe 중 running 작업이 있으면 추가 dispatch는 하지 않는다.

## 기대 효과

- provider 장애 중에는 worker 폭주와 recovery 증폭을 막는다.
- provider가 회복되면 1시간 window를 기다리지 않고 제한적으로 작업이 다시 흐른다.
- supervisor tick은 SQLite 직접 조회를 사용하므로 Kanban CLI 상세 조회 지연에 덜 묶인다.

## 검증 기준

- `node --check ops/codex-control-dashboard/server.js`
- `python3 -m py_compile ops/codex-control-dashboard/board-state.py ops/codex-control-dashboard/board-task-details.py`
- `python3 ops/codex-control-dashboard/board-task-details.py codex-control <task_id>` 가 run/comment/event를 즉시 반환
- runtime 반영 후 `codex-control-api.service` 재시작
- `/api/supervisor`에서 health gate active 상태에서도 `lastHealthGateProbeAt`와 half-open probe 로그 확인