# Security Policy

이 저장소는 공개 가능한 synthetic/sanitized 예시만 포함합니다.

## 금지 항목

- 실제 API key, OAuth token, session cookie, Discord token
- 실제 Discord channel/user/server ID 또는 개인 식별 정보
- 원본 memory, private prompt, gateway state, database, session, log
- 운영 환경의 `.env`, local config, credential file

## Placeholder 규칙

허용되는 placeholder 형식은 다음과 같습니다.

- `<YOUR_SERVICE_TOKEN>`
- `<YOUR_DISCORD_CHANNEL_ID>`
- `${HERMES_MODEL}`

실제 secret처럼 보이는 `sk-...` 값이나 장문 credential 샘플은 만들지 않습니다.

## 공개 전 점검

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
```

문제가 발견되면 commit/publish 전에 값을 삭제하고 history 노출 여부를 확인하세요.
