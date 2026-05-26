# Personal Hermes Agent

개인 Hermes 에이전트의 공개 안전 운영 프로필과 VM 운영 소스 저장소입니다.

이 저장소는 에이전트를 어떻게 운용하는지, 어떤 자료를 공개해도 되는지,
반복 가능한 job, skill, prompt, script, VM 운영 산출물을 어떻게 버전 관리할지
정리합니다.

## 현재 운영 모델

- Hermes VM을 단일 운영 source of truth로 둡니다.
- 로컬 WSL은 SSH 터널과 비활성 백업/캐시 역할로 제한합니다.
- secret, token, session, cookie, raw log, raw DB, gateway state, private workspace path는 커밋하지 않습니다.
- 런타임 상태는 저장소 밖에 두며, 이 저장소에는 정제된 예시와 운영 소스만 둡니다.
- dashboard/control API 보안은 선택 사항이 아니라 필수 acceptance condition입니다.

## 저장소 구성

| 경로 | 목적 |
| --- | --- |
| `docs/` | architecture, jobs, memory, tools, gateway, cron, delegation, operations 문서 |
| `jobs/` | 반복 작업을 위한 정제된 Job Registry YAML |
| `skills/` | 재사용 가능한 Hermes skill 예시와 작성 규칙 |
| `prompts/` | system, workflow, template prompt |
| `scripts/examples/` | 공개 안전 검증 및 registry helper script |
| `config/` | placeholder 전용 설정 예시 |
| `ops/` | 공개 안전 VM 운영 소스와 배포 예시 |

## VM Dashboard And Control API

현재 VM 운용 상태 기준 Codex Control Dashboard 소스는 다음 경로에 있습니다.

```text
ops/codex-control-dashboard/
```

포함 항목:

- dashboard/control API runtime
- static dashboard UI
- Discord relay runtime
- summary DTO 및 auth smoke test
- placeholder 전용 env 예시
- systemd user service 예시

보안 모델:

- dashboard는 `127.0.0.1`에만 bind합니다.
- control mutating endpoint는 `CONTROL_SHARED_SECRET` 또는 localhost CSRF가 필요합니다.
- Discord relay endpoint는 `DISCORD_SHARED_SECRET`이 필요합니다.
- `DISCORD_PUBLIC_KEY`는 Discord Interactions를 활성화할 때만 필요합니다.
- `/api/summary`는 raw object redaction이 아니라 allowlist DTO만 반환합니다.
- raw `/api/state`는 인증이 필요합니다.

관련 문서:

- `ops/README.md`
- `docs/12-codex-control-dashboard.md`

## Summary Endpoint Contract

`/api/summary`가 반환할 수 있는 필드는 아래로 제한합니다.

- `board`
- `updated_at`
- `summary.total`
- `summary.done`
- `summary.running`
- `summary.ready`
- `summary.blocked`
- `tasks[].id`
- `tasks[].title`
- `tasks[].status`
- `tasks[].assignee`
- `tasks[].age_seconds`
- `tasks[].retry_count`
- `tasks[].sanitized_error_class`
- `tasks[].updated_at`

응답에 포함하면 안 되는 항목:

- raw task body
- workspace path
- raw command
- stdout 또는 stderr
- env key name 또는 value
- token, secret, key, cookie, session material
- private filesystem path

## 검증

공개 전 실행:

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
```

dashboard 배포 후 VM에서 실행:

```bash
set -a
. ~/.hermes/codex-control.env
set +a
bash ~/.hermes/codex-control-dashboard/dashboard-smoke.sh
```

smoke test 기대 항목:

- health endpoint가 `200`을 반환합니다.
- summary endpoint가 allowlist schema와 일치합니다.
- summary string이 sensitive deny pattern과 매칭되지 않습니다.
- no-token mutating request는 `401` 또는 `403`을 반환합니다.
- bad-token mutating request는 `401` 또는 `403`을 반환합니다.
- valid bearer token dry-run은 `200`을 반환합니다.
- valid localhost CSRF dry-run은 `200`을 반환합니다.
- raw state endpoint는 unauthenticated access를 거부합니다.
- Discord relay mutation endpoint는 unauthenticated access를 거부합니다.

## 공개 규칙

커밋 금지:

- filled `.env`
- 실제 API key, OAuth token, cookie, session, Discord bot token
- 실제 Discord user, channel, server ID
- raw Hermes session, checkpoint, DB, log, gateway state
- private memory, prompt, workspace path, personal identifier

placeholder 예시:

- `<YOUR_DISCORD_BOT_TOKEN>`
- `<YOUR_DISCORD_CHANNEL_ID>`
- `<GENERATE_WITH_PASSWORD_MANAGER>`
- `${HERMES_MODEL}`

## 배포 메모

`ops/`의 파일은 공개 안전 운영 소스입니다. live VM 상태를 그대로 복사한 것이 아닙니다.

배포 시 원칙:

1. runtime 파일을 VM dashboard directory로 복사합니다.
2. 채워진 env 파일은 VM-local로만 유지합니다.
3. env 파일 권한은 `600`으로 둡니다.
4. dashboard directory 권한은 `750` 이하로 둡니다.
5. 관련 user service만 재시작합니다.
6. dashboard smoke test를 실행합니다.

rollback은 service restart 전에 만든 timestamp backup에서 복구하는 방식으로 수행합니다.

## 현재 상태

이 README 기준 저장소는 현재 VM dashboard 운용 상태를 source level로 반영했습니다.
live secret과 private runtime state는 git에 포함하지 않았습니다.
