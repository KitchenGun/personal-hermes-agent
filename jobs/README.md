# Jobs Registry

`jobs/`는 Hermes가 대화 요청을 받아 생성/갱신하는 Job Registry입니다.

## 사용 방식

- 사용자가 Hermes에게 Job 추가/변경을 요청합니다.
- Hermes가 `prompts/workflows/add-job-to-repo.md`에 따라 YAML을 작성합니다.
- 모든 Job은 필수 필드(`name`, `description`, `schedule`, `trigger`, `input`, `steps`, `output`, `tools`, `model`, `safety`, `status`)를 포함해야 합니다.
- 검증: `scripts/examples/validate-job-registry.sh`

## 카탈로그

- 최신 카탈로그: 2026-05-13 기준 공개 저장소에 반영된 13개 Job 설명: [docs/12-job-registry-catalog-2026-05-13.md](../docs/12-job-registry-catalog-2026-05-13.md)
- 이전 카탈로그: 2026-05-12 기준 생성/정리된 9개 Job 설명: [docs/11-job-registry-catalog-2026-05-12.md](../docs/11-job-registry-catalog-2026-05-12.md)

## 분류

- `daily/`
- `weekly/`
- `monitoring/`
- `research/`
- `maintenance/`
- `examples/` — 공개용 draft 예시 Job
