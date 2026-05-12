# 10. Operation Guide

## 새 Job 추가

1. Hermes에게 자연어로 요청합니다. 예: “매주 금요일 GitHub 활동 요약 Job을 추가해줘.”
2. Hermes가 `prompts/workflows/add-job-to-repo.md`를 사용해 YAML 초안을 만듭니다.
3. 파일은 적절한 registry 경로(`jobs/weekly/...yaml` 등)에 생성/갱신됩니다.
4. validator와 secret scan을 실행합니다.
5. 사용자가 diff를 검토한 뒤 운영 환경에 반영합니다.

## 공개 전 점검

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
```

## 운영 파일 반입 금지

실제 `.env`, memory, session, logs, DB, gateway state를 이 저장소로 복사하지 마세요. 필요한 경우 placeholder로 다시 작성합니다.
