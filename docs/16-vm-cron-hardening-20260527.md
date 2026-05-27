# 16. VM Cron Hardening 2026-05-27

## 목적

VM `/home/ubuntu/.hermes`의 Hermes cron job을 응답시간, 정확도, 중복 실행 방지, 장애 격리 기준으로 점검하고 운영 안전성을 높였다.

## 핵심 조치

- 중복 `queue-watchdog-safe.py` 5개 중 1개만 활성 유지.
- 중복 `queue-watchdog-managed.py` 2개 중 1개만 활성 유지.
- `queue-watchdog-safe.py`의 inspector prompt 상대경로 오류를 수정해 `/home/ubuntu/.hermes/hermes-agent/prompts/...` 기준으로 동작하게 했다.
- watchdog 출력은 전체 snapshot 대신 핵심 요약 JSON만 남기게 축소했다.
- 매일 08:00에 몰리던 날씨/게임채용/AI daily job을 07:55, 08:05, 08:15로 분산했다.
- 월요일 09:00에 몰리던 게임채용 weekly와 AI weekly를 09:00, 09:20으로 분산했다.
- managed watchdog은 5분마다 2개 중복 실행되던 구조에서 단일 10분 주기로 낮췄다.
- 메일 알림 job에 IMAP timeout, 실행 lock, 부분 실패 감지를 추가했다.
- 게임 채용 crawler에 transient fetch retry와 JSON 상태 파일 파싱 실패 fallback을 추가했다.
- Google Calendar briefing은 Google API의 `date`/`dateTime` dict 스키마를 모두 정규화한다.
- AI trends collector/source fetch timeout, Sheets timeout, Discord retry budget을 환경변수로 제어하게 했다.
- AI trends scorer는 기본 `item_limit=4`, Hermes 평가 timeout 35초로 낮춰 300초 wrapper timeout 여유를 확보했다.

## 활성 cron 상태

2026-05-27 13:31 KST 기준 활성 job은 12개다.

| Job ID | 이름 | 주기 | 상태 |
| --- | --- | --- | --- |
| `1cb15744c542` | Daily Google Calendar Briefing | `30 7 * * *` | ok |
| `53d36f857a09` | mail-notify-discord | every 5m | ok |
| `f20e3c00d5d4` | daily-weather-briefing | `55 7 * * *` | ok |
| `b97683b4cc42` | Weekly Game Jobs | `0 9 * * 1` | ok |
| `4153fc551ca3` | Daily Game Jobs Crawl to Sheets | `5 8 * * *` | ok |
| `274ed1bdf2e5` | weekly workout routine draft | `0 18 * * 0` | ok |
| `4eebb276e9b7` | queue-watchdog-safe | every 5m | ok |
| `f612ac984202` | 주간 AI 트렌드 보고 | `20 9 * * 1` | ok |
| `6b96123e2af9` | 일간 AI 트렌드 보고 | `15 8 * * *` | ok |
| `be16c2abaa41` | 시간별 AI 트렌드 수집 | `0 * * * *` | ok |
| `57932eeb045a` | AI 트렌드 미평가 항목 점수화 | `10 * * * *` | ok |
| `d83759675d65` | queue-watchdog-managed | every 10m | ok |

## 비활성화한 중복 job

- `ed204e7212f1`: duplicate `queue-watchdog-safe.py`
- `39ef645e3a46`: duplicate `queue-watchdog-safe.py`
- `4c4171f7eb41`: duplicate `queue-watchdog-safe.py`
- `dec4bb9f30b7`: duplicate `queue-watchdog-safe.py`
- `53758dac0cd9`: duplicate `queue-watchdog-managed.py`

삭제 대신 pause로 처리했다. 되돌릴 필요가 있으면 `hermes cron resume <job_id>`로 복구 가능하다.

## 검증

```bash
python3 -m py_compile \
  /home/ubuntu/.hermes/scripts/queue-watchdog-safe.py \
  /home/ubuntu/.hermes/scripts/queue-watchdog-managed.py \
  /home/ubuntu/.hermes/scripts/mail-notify-discord.py \
  /home/ubuntu/.hermes/scripts/game_jobs_crawl_to_sheets.py \
  /home/ubuntu/.hermes/scripts/daily-google-calendar-briefing.py

/home/ubuntu/.hermes/hermes-agent/venv/bin/python /home/ubuntu/.hermes/scripts/mail-notify-discord.py --self-test
cd /home/ubuntu/.hermes/jobs/repos/ai-trends
/home/ubuntu/.local/bin/uv run --with pytest pytest tests/ai_trends/test_sources.py tests/ai_trends/test_sheets.py tests/ai_trends/test_discord.py tests/ai_trends/test_scorer.py tests/ai_trends/test_hermes_eval.py -q
/home/ubuntu/.local/bin/uv run --with pytest --with pyyaml pytest -q
```

- AI trends 핵심 테스트: 38 passed
- AI trends 전체 테스트: 78 passed
- mail notifier self-test: ok
- queue-watchdog-safe 수동 실행: ok, `inspector_error=null`
- queue-watchdog-managed 수동 실행: ok
- game jobs dry-run: partial, 공개 사이트 403/302 제외하고 정상 수집
- calendar briefing 수동 실행: 정상 출력
- cron 수동 tick 후 `4eebb276e9b7`, `d83759675d65` last status: ok

## 백업

수정 전 런타임 파일은 VM에 백업했다.

`/home/ubuntu/.hermes/backups/cron-hardening-20260527-042259`
