# 01. Architecture

## 구성 요소

- **User / Discord / API Gateway**: 외부 입력을 Hermes 명령으로 변환합니다.
- **Hermes Core**: 대화, planning, tool use, delegation을 조정합니다.
- **Job Registry**: `jobs/.../*.yaml`에 자동화 작업 정의를 저장합니다.
- **Cron Runner**: registry schedule을 읽어 실행 계획을 만듭니다.
- **Skills**: 반복 가능한 전문 절차를 `SKILL.md`로 캡슐화합니다.
- **Memory Pipeline**: 결과에서 memory candidate를 추출하고 승인 후 반영합니다.
- **Provider Router**: 작업 성격에 따라 모델/provider를 선택합니다.

자세한 흐름은 `diagrams/architecture.mmd`를 참고하세요.
