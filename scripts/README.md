# Scripts

공개 repo 검증과 Job Registry 관리를 돕는 예시 스크립트입니다.

- `examples/scan-for-secrets.sh`: secret-like 문자열 탐지
- `examples/validate-examples.sh`: config/prompt/job 예시 기본 검증
- `examples/validate-job-registry.sh`: Job YAML 필수 필드 검증
- `examples/sync-job-registry.sh`: Cron runner가 registry를 읽는 흐름의 예시

실제 운영 환경의 credential이나 private path를 스크립트에 하드코딩하지 마세요.
