# 17. VM Watchdog Cron Removal 2026-05-27

## 결론

watchdog cron을 재점검했고, 필요 없는 중복 watchdog 5개를 pause 상태에서 실제 cron registry에서 제거했다. 현재 watchdog cron은 운영상 필요한 2개만 남겼다.

## 제거한 cron

- `ed204e7212f1`: duplicate `queue-watchdog-safe.py`, paused, 최근 `json` import 이전 실패 기록만 보유
- `39ef645e3a46`: duplicate `queue-watchdog-safe.py`, paused, 동일 실패 기록
- `4c4171f7eb41`: duplicate `queue-watchdog-safe.py`, paused, 동일 실패 기록
- `dec4bb9f30b7`: duplicate `queue-watchdog-safe.py`, paused, 동일 실패 기록
- `53758dac0cd9`: duplicate `queue-watchdog-managed.py`, paused, active managed job과 중복되어 락 충돌 출력만 남김

제거 전 백업:

`/home/ubuntu/.hermes/backups/watchdog-cron-remove-20260527-044135`

## 유지한 cron

- `4eebb276e9b7`: `queue-watchdog-safe.py`, `kk-job` board safe report, every 5m
- `d83759675d65`: `queue-watchdog-managed.py`, `default` board managed apply, every 10m

유지 근거:

- 둘 다 현재 active이고 최근 cron status가 `ok`다.
- 담당 board와 mode가 다르다.
- safe는 `kk-job`의 blocked/needs_user 상태 감시에 필요하다.
- managed는 `default` board의 dispatch 후보 확인에 필요하다.
- 출력은 이미 요약 JSON으로 축소되어 snapshot 로그 비대화 위험이 낮아졌다.

## 제거 후 검증

```bash
/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes cron status
/home/ubuntu/.hermes/hermes-agent/venv/bin/hermes cron list
/home/ubuntu/.hermes/hermes-agent/venv/bin/python /home/ubuntu/.hermes/scripts/queue-watchdog-safe.py
/home/ubuntu/.hermes/hermes-agent/venv/bin/python /home/ubuntu/.hermes/scripts/queue-watchdog-managed.py
python3 -m py_compile \
  /home/ubuntu/.hermes/scripts/queue-watchdog-safe.py \
  /home/ubuntu/.hermes/scripts/queue-watchdog-managed.py
```

결과:

- `jobs.json` total jobs: 12
- active jobs: 12
- watchdog jobs: `4eebb276e9b7`, `d83759675d65`
- `queue-watchdog-safe.py` 수동 실행: ok, `inspector_error=null`
- `queue-watchdog-managed.py` 수동 실행: ok, `inspector_error=null`
- Hermes gateway: running
