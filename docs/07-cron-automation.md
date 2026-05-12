# 07. Cron and Automation

Cron Runner는 `jobs/.../*.yaml` Registry를 읽어 실행 대상 Job을 결정합니다.

## 중요: 대화 기반 Job 등록

운영자는 YAML을 직접 작성하는 대신 Hermes에게 Job 추가/수정을 요청합니다. Hermes는 `prompts/workflows/add-job-to-repo.md`를 따라 registry 파일을 생성/갱신하고 validation을 실행합니다.

## 실행 흐름

1. Cron이 schedule과 status를 확인합니다.
2. enabled Job을 trigger context와 함께 Hermes에 전달합니다.
3. Hermes가 steps/tools/model/safety에 따라 실행합니다.
4. output destination에 결과를 저장하거나 알립니다.
5. memory 후보가 있으면 별도 승인 흐름으로 분리합니다.
