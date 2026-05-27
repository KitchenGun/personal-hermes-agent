# AI Trends X RSS 점수화 및 일간 포함 검증 (2026-05-27)

## 목적

- X RSS로 수집된 Hermes/NousResearch 항목이 점수화 후 일간 보고에 실제 포함되는지 검증한다.
- row 순서 때문에 점수화된 X RSS가 digest limit 밖으로 밀리는 문제를 방지한다.

## 적용 위치

- Runtime repo: /home/ubuntu/.hermes/jobs/repos/ai-trends
- Scorer cron script: /home/ubuntu/.hermes/scripts/ai-trends-scorer.sh
- Daily cron job: 6b96123e2af9 / 일간 AI 트렌드 보고

## 변경 요약

- src/ai_trends/daily.py
  - daily digest 후보를 시트 row 순서로 limit 하기 전에 전체 일자 점수 행을 읽는다.
  - importance_score, relevance_score, published_at 순으로 정렬한 뒤 limit을 적용한다.
- src/ai_trends/weekly.py
  - weekly digest 후보도 같은 방식으로 점수 우선 정렬 후 limit을 적용한다.
- tests/ai_trends/test_failure_policy.py
  - 낮은 점수 행이 앞에 있어도 높은 점수 X RSS 행이 daily/weekly digest limit 안에 들어오는지 검증한다.

## 실행 결과

- 점수 cron script 수동 실행:
  - 명령: HERMES_HOME=/home/ubuntu/.hermes AI_TRENDS_SCORING_ITEM_LIMIT=60 AI_TRENDS_HERMES_EVAL_TIMEOUT_SECONDS=20 /home/ubuntu/.hermes/scripts/ai-trends-scorer.sh
  - 결과: 대상=36 성공=36 실패=0 건너뜀=82
  - X RSS 상태: total=20, scored=20, unscored=0
- 일간 cron job 트리거:
  - 명령: HERMES_HOME=/home/ubuntu/.hermes hermes cron run 6b96123e2af9
  - Last run: 2026-05-27T16:31:05.950342+09:00 ok
- 최신 daily_digest 확인:
  - digest_date=2026-05-27
  - discord_status=sent
  - item_count=12
  - x_rss_signal 포함=3개
  - 포함된 X RSS 제목:
    - Qwen 3.7 Max is now supported in Hermes Agent
    - RT by @NousResearch: If you have been experiencing issues with OpenAI Codex oAuth, it is now fixed.
    - Open Source Must Win - The Pope

## 검증

- python -m compileall -q src tests
- python -m pytest -q tests/ai_trends/test_failure_policy.py -> 13 passed
- python -m pytest -q -> 86 passed

## 주의

- Runtime repo에는 .git이 없어 코드 변경은 VM runtime에 직접 반영했다.
- Scorer 실행 중 일부 항목은 Hermes CLI 실패로 fallback 점수가 사용됐지만, scorer 결과상 실패는 0건이며 score_rationale은 Hermes agent prefix로 기록됐다.