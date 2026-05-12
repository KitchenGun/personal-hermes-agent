# 02. Jobs and Job Registry

`jobs/`는 수동 파일 보관함이 아니라 Hermes가 대화 요청을 받아 생성/갱신하는 **Job Registry**입니다.

## 추가 흐름

1. 사용자가 Hermes에게 자연어로 Job 추가/수정을 요청합니다.
2. Hermes가 요구사항을 정리하고 안전한 schedule/trigger/input을 설계합니다.
3. `prompts/workflows/add-job-to-repo.md` 절차를 따라 YAML을 생성/수정합니다.
4. `scripts/examples/validate-job-registry.sh`로 필수 필드를 검증합니다.
5. secret scan 후 사용자가 diff를 확인합니다.

## 필수 필드

모든 Job YAML은 다음 필드를 포함합니다.

- `name`
- `description`
- `schedule`
- `trigger`
- `input`
- `steps`
- `output`
- `tools`
- `model`
- `safety`
- `status`

## 분류

- `daily/`: 매일 실행되는 brief/report
- `weekly/`: 주간 요약 및 회고
- `monitoring/`: 상태 점검/알림
- `research/`: 정보 수집/트렌드 조사
- `maintenance/`: 저장소/메모리/운영 상태 관리
