# 13. VM Source Commit Prep

VM에서 운영 중 쌓인 변경은 live runtime/state를 그대로 복사하지 않고, public-safe source 후보만 분리해 검토한 뒤 커밋한다. 실제 Hermes Agent 핵심 실행 repo는 `/home/ubuntu/.hermes/hermes-agent`이다.

## 원칙

- VM live runtime은 source of truth이지만, repo에는 sanitized source/profile만 커밋한다.
- `/home/ubuntu/.hermes/hermes-agent`의 변경 목록을 기준으로 기능군을 분류한다.
- `.env`, `auth.json`, DB, memories, sessions, logs, backups, raw gateway state는 복사하지 않는다.
- import 후보는 `.hermes-import/`에만 둔다. 이 디렉터리는 git ignore 대상이다.
- tracked repo 반영은 사람이 검토한 최소 source 변경만 수행한다.

## 1. VM 상태 확인

```bash
scripts/examples/prepare-vm-source-commit.sh <ssh-target> report
```

확인 대상:

- `/home/ubuntu/.hermes/hermes-agent`의 `git status --short`
- public-safe source path의 `git diff --stat`
- dashboard source 후보 목록
- 관련 user service 상태

## 2. 후보 가져오기

```bash
scripts/examples/prepare-vm-source-commit.sh <ssh-target> import
```

가져오는 위치:

```text
.hermes-import/<timestamp>/
```

가져오는 대상은 allowlist source 후보뿐이다.

- Hermes source 후보: `README.md`, `HERMES.md`, `PROJECT.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/`, `jobs/`, `skills/`, `prompts/`, `scripts/`, `diagrams/`, `ops/`, `.gitignore`, placeholder config
- dashboard 후보: `server.js`, `discord-relay.js`, `dashboard-smoke.sh`, `codex-control.env.example`, `public/`
- systemd 후보: `codex-control-api.service`, `codex-discord-relay.service`, `hermes-gateway.service`, `hermes-dashboard.service`

## 3. 반영

1. `.hermes-import/<timestamp>/MANIFEST.txt`를 확인한다.
2. 필요한 변경만 tracked repo 경로로 수동 반영한다.
3. private path, token, raw logs, DB/state reference가 섞였는지 확인한다.
4. 검증을 실행한다.

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
git diff --check
git status --short
```

## 4. 커밋 전 기준

- import directory는 커밋하지 않는다.
- VM live secret이나 runtime state가 diff에 없어야 한다.
- dashboard/control API 변경은 `dashboard-smoke.sh` 기준을 만족해야 한다.
- Hermes agent/gateway 변경은 VM 반영 전 `git status --short`와 `git diff --stat`를 다시 확인한다.

## 5. Daily change curator

매일 저녁 Codex 자동화는 다음 역할을 수행한다.

1. `/home/ubuntu/.hermes/hermes-agent`의 `git status --short`, `git diff --stat`, untracked 목록을 read-only로 확인한다.
2. 변경이 없으면 종료한다.
3. 변경이 있으면 기능군, 위험도, 검증 명령, 커밋 후보 메시지를 작성한다.
4. secret/token/session/log/state/db/private path는 값 없이 위험만 보고한다.
5. `personal-hermes-agent`에는 public-safe 기능 요약과 운영 문서만 반영한다.
6. 실제 commit/push는 main agent가 검토 후 수행한다.
