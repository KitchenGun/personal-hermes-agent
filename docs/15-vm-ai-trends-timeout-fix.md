# 15. VM AI Trends Timeout Fix

## 요약

2026-05-27 VM 런타임 `/home/ubuntu/.hermes/jobs/repos/ai-trends`에서 Hermes CLI 평가 timeout이 주간 workflow 전체를 중단시키는 문제를 수정했다.

## 변경 내용

- `src/ai_trends/hermes_eval.py`: 후보별 평가 실패를 격리하고, timeout 및 parse/CLI 실패 시 deterministic fallback score를 사용한다.
- `src/ai_trends/hermes_eval.py`: AI agent 관련성이 낮은 후보는 Hermes CLI 호출 전 `irrelevant_prefilter`로 낮은 점수를 반환한다.
- `src/ai_trends/weekly.py`: 주간 요약 Hermes CLI timeout은 workflow 실패가 아닌 deterministic fallback summary로 처리한다.
- subprocess 호출에 `stdin=subprocess.DEVNULL`을 지정해 interactive hang 가능성을 줄였다.

## 검증

```bash
cd /home/ubuntu/.hermes/jobs/repos/ai-trends
/home/ubuntu/.local/bin/python3 -m py_compile src/ai_trends/hermes_eval.py src/ai_trends/weekly.py tests/ai_trends/test_hermes_eval.py tests/ai_trends/test_failure_policy.py
/home/ubuntu/.local/bin/uv run --with pytest pytest tests/ai_trends/test_hermes_eval.py tests/ai_trends/test_failure_policy.py -q
/home/ubuntu/.local/bin/uv run --with pytest --with pyyaml pytest -q
```

- 핵심 테스트: 18 passed
- 전체 테스트: 74 passed
- Google Missouri 후보: Hermes CLI 호출 없이 `1/1 Fallback(irrelevant_prefilter)` 처리

## 2026-05-27 scorer timeout 추가 수정

`ai-trends-scorer.sh`가 300초 wrapper timeout에 걸리는 문제도 같은 계열의 장애였다. scorer는 기본 5개 항목을 처리하는데 각 Hermes 평가 timeout 기본값이 180초라, 일부 항목만 지연되어도 전체 script timeout을 초과할 수 있었다.

변경 내용:

- `/home/ubuntu/.hermes/scripts/ai-trends-scorer.sh`: scorer 전용 기본 `AI_TRENDS_HERMES_EVAL_TIMEOUT_SECONDS=45`를 지정했다.
- `src/ai_trends/scorer.py`: 단일 `evaluate_trend_item()` 호출 대신 `evaluate_trend_items((raw_item,))`를 사용해 Hermes timeout fallback score를 row에 기록한다.
- `tests/ai_trends/test_scorer.py`: timeout 계열 실패가 job 실패/무한 재시도 대신 fallback score update로 끝나는지 검증한다.

검증:

```bash
cd /home/ubuntu/.hermes/jobs/repos/ai-trends
/home/ubuntu/.local/bin/python3 -m py_compile src/ai_trends/scorer.py src/ai_trends/hermes_eval.py tests/ai_trends/test_scorer.py
/home/ubuntu/.local/bin/uv run --with pytest pytest tests/ai_trends/test_scorer.py tests/ai_trends/test_hermes_eval.py -q
/home/ubuntu/.local/bin/uv run --with pytest --with pyyaml pytest -q
```

- scorer/평가 핵심 테스트: 13 passed
- 전체 테스트: 75 passed
- 수동 cron 실행: `57932eeb045a` 최신 실행 `2026-05-27T12:55:39+09:00 ok`
- 출력: `AI 트렌드 scoring 완료: 대상=5 성공=5 실패=0 건너뜀=93`