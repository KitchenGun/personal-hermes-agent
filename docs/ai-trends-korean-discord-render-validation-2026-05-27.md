# AI Trends Discord 한국어 렌더링 회귀 검증 (2026-05-27)

## 작업 범위
- 런타임 저장소: `/home/ubuntu/.hermes/jobs/repos/ai-trends`
- 변경 파일:
  - `src/ai_trends/discord.py`
  - `tests/ai_trends/test_discord.py`

## 변경 내용
- 일간/주간 Discord 보고 항목 렌더링에 다음 한국어 섹션을 추가했다.
  - `새 기능/변경점`
  - `선정 이유`
  - `근거`
  - `내 환경에서의 활용`
- `Hermes agent:` 접두사와 `Fallback(hermes_cli_timeout)`, `hermesevaluationerror` 계열 내부 fallback 문구가 사용자 보고에 그대로 노출되지 않도록 변환했다.
- fallback 기반 항목은 `자동 예비 평가 기준으로 선별됨`으로 표시한다.
- 낮은 점수 항목은 제한적 영향/후보 검토 맥락을 함께 표시한다.
- `x_rss_signal` 항목은 `공개 X RSS 기반 조기 신호` 및 `공개 소셜 신호라 보조 근거로만 사용` 문구로 근거를 설명한다.

## 검증 결과
- `python -m compileall -q src tests`: 통과
- `python -m pytest -q`: `91 passed`
- dry-run 렌더 샘플:
  - `PYTHONPATH=src python - <<'PY' ...` 방식으로 일간/주간 메시지 렌더링만 수행했다.
  - 실제 Discord 전송은 수행하지 않았다.
  - 샘플에서 fallback 내부 문구 대신 `자동 예비 평가 기준으로 선별됨`이 출력되는 것을 확인했다.

## 남은 이슈
- `/home/ubuntu/.hermes/jobs/repos/ai-trends`는 현재 git 저장소가 아니어서 해당 런타임 디렉터리 자체에서는 커밋/푸시를 수행할 수 없었다.
- 문서화는 personal-hermes-agent 저장소의 `docs/` 아래에 남겼다.
