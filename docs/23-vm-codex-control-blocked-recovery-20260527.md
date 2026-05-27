# Codex Control 블럭 재발 원인 및 복구 기록 - 2026-05-27

## 결론

대시보드의 `blocked` 표시가 남은 이유는 캐시 문제가 아니라 `codex-control` 보드 DB에 실제 `blocked` 작업이 남아 있었기 때문이다. 이후 단순 unblock만으로는 다시 막혔는데, 근본 원인은 두 가지였다.

1. `ready` 집계가 표시용으로 `todo`, `triage`, `scheduled`까지 포함해 supervisor가 실제 dispatch 가능한 작업이 없어도 `hermes kanban dispatch`를 반복 호출했다.
2. Hermes gateway 내장 kanban dispatcher와 codex-control dashboard supervisor가 같은 보드를 동시에 다룰 수 있었고, 당시 Hermes Agent v0.13.0의 `openai-codex` provider가 `NoneType object is not iterable` 또는 300초 무응답으로 worker를 계속 죽였다.

## 적용 조치

- `ops/codex-control-dashboard/server.js`에 `dispatchableReadyCount()`를 추가했다.
- supervisor dispatch 조건을 `state.summary.ready`가 아니라 실제 `task.status === "ready"` 수로 바꿨다.
- dispatch slot도 실제 dispatch 가능한 ready 수를 넘지 않게 제한했다.
- runtime 파일 `/home/ubuntu/.hermes/codex-control-dashboard/server.js`에도 같은 변경을 반영하고 `codex-control-api.service`를 재시작했다.
- `/home/ubuntu/.hermes/config.yaml`에서 `kanban.dispatch_in_gateway: false`로 바꿔 gateway 내장 dispatcher를 껐다.
- Hermes Agent를 `v0.13.0`에서 `v0.14.0`으로 업데이트했다.
- 기존 중복 복구 작업 4개는 archive 처리했다.
- 기존 원본 작업 4개는 provider smoke test 통과 후 unblock 했다.

## 확인 결과

- `researcher` 프로필 Spark smoke test: `OK`
- `coder` 프로필 gpt-5.5 smoke test: `OK`
- gateway 로그: `kanban dispatcher: disabled via config kanban.dispatch_in_gateway=false`
- supervisor 상태: `healthGate.reason=healthy`, `blocked=0`
- 기존 원본 작업 4개는 `running` 상태로 재개됨
- `todo` 2개는 부모 작업 완료 대기 상태라 dispatch 대상이 아님

## 백업

- dashboard server 백업: `/home/ubuntu/.hermes/backups/codex-control-dispatchable-ready-20260527-111514`
- blocked cleanup DB 백업: `/home/ubuntu/.hermes/backups/codex-control-blocked-cleanup-20260527-111816`
- post-update unblock DB 백업: `/home/ubuntu/.hermes/backups/codex-control-post-update-unblock-20260527-114823`
- Hermes pre-update backup: `/home/ubuntu/.hermes/backups/pre-update-2026-05-27-112857.zip`

## 운영 정책

앞으로 `codex-control` 보드는 dashboard supervisor가 단일 소유자로 dispatch한다. gateway 내장 dispatcher는 계속 꺼둔다. Spark는 조사/계획 프로필에는 사용할 수 있지만, provider smoke test 없이 대량 unblock 또는 recovery storm을 만들지 않는다.
