# Codex Control worker crash gate (2026-05-27)

## 목적

- swarm dispatch 자체는 병렬로 동작했지만, `openai-codex` 호출 레이어 장애가 나면 모든 worker와 recovery worker가 같은 오류로 연쇄 차단된다.
- 같은 런타임 장애가 반복될 때는 새 작업과 복구 작업을 계속 투입하지 않고, supervisor가 즉시 멈춰 원인을 드러내야 한다.

## 적용 내용

- `worker_crash_storm` health gate를 `codex-control-dashboard` supervisor에 추가했다.
- 최근 1시간 안에 `pid ... not alive`, `NoneType object is not iterable`, non-streaming timeout, non-retryable client error 계열 worker 실패가 3개 이상 감지되면 gate가 active 된다.
- gate가 active인 동안 supervisor는 신규 `dispatch`와 blocked recovery 생성을 건너뛴다.
- dashboard supervisor 패널에 `health gate on` 상태와 원인 메시지를 표시한다.
- 기존 worker, Hermes gateway, 전역 Hermes 모델 설정은 변경하지 않았다.

## 운영 기본값

- `SUPERVISOR_HEALTH_GATE=1`
- `SUPERVISOR_CRASH_STORM_THRESHOLD=3`
- `SUPERVISOR_CRASH_STORM_WINDOW_SECONDS=3600`
- `SUPERVISOR_CRASH_STORM_SCAN_LIMIT=12`

## 현재 사건 분석

- `t_c1b290a1`은 swarm 하위 작업을 생성한 뒤 완료 처리됐다.
- 하위 작업 `t_6d5bdb38`, `t_89ae9a79`, `t_da5fa371`, `t_d9cfa7f3`는 모두 2회 crash 후 blocked 처리됐다.
- 공통 로그는 `openai-codex` + `gpt-5.5` 호출 중 `TypeError: 'NoneType' object is not iterable`이다.
- 이는 AI Trends X RSS 코드 구현 실패가 아니라 공통 LLM 호출 레이어 장애다.
- 기존 blocked recovery는 fixer 작업을 자동 생성했지만, fixer도 같은 호출 장애로 blocked되어 장애를 증폭했다.

## 검증

- `node --check`로 server/app 구문 확인
- dashboard smoke 통과
- `/api/supervisor`에서 `healthGate.active=true`, `reason=worker_crash_storm` 확인
- `codex-control-api.service` active 확인
- `hermes-gateway.service` active 확인