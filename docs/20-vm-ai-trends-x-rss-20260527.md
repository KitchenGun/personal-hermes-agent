# AI Trends X RSS 수집 추가 (2026-05-27)

## 목적

- X API bearer token이 없어도 공개 RSS/Atom feed 목록으로 AI-agent 관련 X 글을 weak signal로 수집한다.
- 로그인, 쿠키, browser profile, 비공식 authenticated scraping은 사용하지 않는다.

## 적용 위치

- Runtime repo: /home/ubuntu/.hermes/jobs/repos/ai-trends
- Cron wrapper: /home/ubuntu/.hermes/scripts/ai-trends-hourly-collector.sh
- Tracking task: codex-control/t_a426b5ac

## 변경 요약

- src/ai_trends/sources.py
  - AI_TRENDS_X_RSS_FEEDS_JSON, AI_TRENDS_X_RSS_FEEDS_FILE 기반 feed URL 해석 추가
  - parse_x_rss_feed와 x_rss_signal RawTrendItem 생성 추가
  - x-rss-signal, x-author:<handle> tags 보존
  - feed별 failure/timeout은 전체 collector 실패로 전파하지 않고 skip
  - X bearer token 기반 x_weak_signal 경로는 유지
- src/ai_trends/config.py, src/ai_trends/collector.py
  - X RSS 설정 값을 collection config에서 collector로 전달
- tests/ai_trends/test_sources.py, tests/ai_trends/test_config.py
  - RSS 변환, low relevance filtering, failed feed skip, env/file URL 해석, config redaction 검증 추가
- docs/ai-trends/source_policy.md, docs/ai-trends/cron_operations.md
  - X RSS 운영 정책과 env 이름 문서화
- ai-trends-hourly-collector.sh
  - AI_TRENDS_X_RSS_FEED_TIMEOUT_SECONDS=8
  - AI_TRENDS_X_RSS_TOTAL_BUDGET_SECONDS=40
  - AI_TRENDS_X_RSS_FEED_LIMIT=20

## 운영 설정

Example:

AI_TRENDS_X_RSS_FEEDS_JSON='["https://example.invalid/user/rss"]'

or:

AI_TRENDS_X_RSS_FEEDS_FILE=/path/to/x-rss-feeds.json

파일 형식은 URL list 또는 {"feeds": ["https://..."]} object를 지원한다. 값에는 secret, cookie, session 정보를 넣지 않는다.

## 검증

- python -m compileall -q src tests
- python -m pytest -q tests/ai_trends/test_sources.py tests/ai_trends/test_config.py -> 21 passed
- python -m pytest -q -> 82 passed
- 수동 collect_trend_items(..., x_rss_feeds_json=...) 검증 -> X RSS x_rss_signal 생성 확인
- bash -n /home/ubuntu/.hermes/scripts/ai-trends-hourly-collector.sh

## 주의

- Runtime repo에는 .git이 없어 변경은 VM runtime에 직접 반영했다.
- 변경 전 백업: /home/ubuntu/.hermes/backups/ai-trends-x-rss-20260527-