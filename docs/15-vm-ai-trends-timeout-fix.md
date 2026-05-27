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
