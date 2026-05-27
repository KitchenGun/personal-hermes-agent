# Dashboard 연결 끊김 복구 및 헬스체크 보강 (2026-05-27)

## 현상

- 로컬 브라우저에서 `http://127.0.0.1:17640` 접속 시 `ERR_CONNECTION_REFUSED`가 발생했다.
- 조사 시점에는 Windows, WSL, VM 세 경로 모두 dashboard root와 `/api/health`가 정상 응답했다.

## 원인 분석

- VM `codex-control-api.service`는 2026-05-27 15:01~15:04 KST 사이 실제로 내려가 있었다.
- 이 시간대 WSL SSH tunnel journal에 `channel open failed: connect failed: Connection refused`가 반복됐다.
- 즉, 핵심 원인은 로컬 브라우저나 Discord 전송 자체가 아니라 VM 내부 dashboard API 포트 `127.0.0.1:17640`이 일시적으로 닫힌 상태였다.
- 이후 WSL tunnel service도 여러 번 stop/start됐고, 한 차례 health 요청 timeout이 재현되어 로컬 터널 불안정도 겹친 것으로 확인했다.

## 적용한 복구책

- VM runtime에 `dashboard-healthcheck.sh`를 추가했다.
- VM user-systemd에 아래 timer/service를 추가하고 활성화했다.
  - `codex-control-api-healthcheck.service`
  - `codex-control-api-healthcheck.timer`
- healthcheck는 `http://127.0.0.1:17640/api/health`를 확인하고 실패 시 `codex-control-api.service`를 재시작한다.
- WSL에도 `oracle-hermes-vm-dashboard-tunnel-healthcheck.timer`를 추가해 로컬 `127.0.0.1:17640/api/health`가 timeout이면 tunnel service를 재시작하게 했다.
- 의도적인 maintenance 중에는 VM healthcheck timer를 먼저 중지한다.

```bash
systemctl --user stop codex-control-api-healthcheck.timer
# maintenance
systemctl --user start codex-control-api-healthcheck.timer
```

## 검증

- Windows: `http://127.0.0.1:17640/` -> HTTP 200
- WSL: `curl http://127.0.0.1:17640/api/health` -> ok
- WSL tunnel healthcheck timer -> active
- VM: `curl http://127.0.0.1:17640/api/health` -> ok
- `systemctl --user start codex-control-api-healthcheck.service` -> success
- `systemctl --user is-active codex-control-api-healthcheck.timer` -> active

## 남은 관찰 포인트

- WSL tunnel service는 이미 `Restart=always`와 `ServerAliveInterval=30`을 사용 중이며, 추가 healthcheck timer가 stuck tunnel을 재시작한다.
- WSL 자체가 종료되면 로컬 tunnel도 내려갈 수 있으므로, 로컬 접속이 다시 끊기면 WSL service와 healthcheck timer 상태를 함께 확인한다.
- Discord relay 로그의 slash command 중복 ack와 일부 누락 스크립트 경고는 별도 이슈이며, 이번 `127.0.0.1:17640` connection refused의 직접 원인은 아니다.
