# Hermes Operation Project

## 1. 프로젝트 목적

이 repo는 Hermes VM 운영을 위한 public-safe source/profile repo이다.

- 실제 Hermes Agent 실행 환경은 VM이다.
- repo는 job, skill, prompt, docs, ops source를 관리한다.
- repo에는 공개 가능한 운영 소스, placeholder 설정, 검증 스크립트, 문서만 둔다.
- VM live runtime/state/secrets는 repo 밖에 둔다.

## 2. 운영 원칙

- Hermes Agent, gateway, dashboard runtime은 VM에서만 실행한다.
- 로컬 Windows/WSL/Codex 프로젝트는 소스 편집, 문서화, 검증, 배포 준비용이다.
- 로컬에서 Hermes Agent, gateway, dashboard runtime을 직접 실행하지 않는다.
- secret, token, session, cookie, raw log, state, DB, private path는 저장하지 않는다.
- live VM state는 repo 밖에 둔다.
- VM의 운영 경로와 source repo 경로를 명확히 분리한다.
- dashboard/control API 보안은 필수 acceptance condition이다.
- 반복 탐색, 검증, 리뷰는 sub-agent 병렬 처리를 우선 활용한다.
- 단순 탐색, 분류, 검증은 빠른 모델, 특히 `gpt-5.3-codex-spark`를 우선 사용한다.
- 최종 판단, 위험 작업, 운영 반영, 실패 반복 분석은 상위 모델 또는 main agent가 수행한다.

## 3. 경로 구분

| 경로 | 용도 | 수정 가능 여부 | Codex 작업 루트 | 주의사항 |
| --- | --- | --- | --- | --- |
| `C:\Users\kang9\Documents\Codex\2026-05-26\hermes\personal-hermes-agent` | Windows source repo. docs, jobs, skills, config, ops source 편집 및 검증 | 가능 | 가능. Codex Desktop 프로젝트 root로 사용 | live VM state/secrets를 복사하지 않는다 |
| `/home/ubuntu/.hermes/hermes-agent` | VM live Hermes agent 핵심 실행 repo/runtime/source | SSH 운영 절차로만 가능 | 금지 | 진짜 Hermes Agent 운영 변경의 기준 경로다. 수정 전 `git status --short`와 `git diff --stat`를 확인한다 |
| `/home/ubuntu/.hermes/codex-control-dashboard` | VM live dashboard/control API runtime | 배포 절차로만 가능 | 금지 | 일반 개발 root로 쓰지 않는다. `.env`와 runtime state를 repo로 복사하지 않는다 |
| `/home/ubuntu/.hermes` | VM runtime root | 직접 수정 최소화 | 금지 | secrets, sessions, memories, logs, state가 섞일 수 있다 |
| `/home/ubuntu/.hermes/backups/*` | VM backup/archive | 수정 금지 | 금지 | timestamp backup/archive는 복구용으로만 사용한다 |

## 4. Codex 프로젝트 사용 방식

- Codex Desktop 프로젝트 root는 Windows source repo로 잡는다.
- VM live path를 Codex Desktop 기존 폴더로 직접 지정하지 않는다.
- VM live 수정은 SSH 배포/운영 절차로만 한다.
- `/mnt/c/...` WSL mount에서 Git 작업하지 않는 것을 권장한다.
- 로컬에서는 source edit, docs update, validation, deploy preparation만 수행한다.

## 5. 병렬 sub-agent 운영 원칙

- 큰 작업은 main agent가 먼저 범위와 위험도를 나누고 sub-agent를 병렬 배치한다.
- sub-agent는 서로 다른 책임 범위를 가져야 한다.
- 여러 writer가 같은 파일을 동시에 수정하지 않는다.
- 탐색, 검증, 리뷰는 병렬화하고 최종 적용은 main agent 또는 단일 fixer가 수행한다.
- sub-agent 결과는 main agent가 통합 판단한다.
- sub-agent도 secret, token, key, session, raw log를 출력하지 않는다.

권장 역할:

| 역할 | 책임 | 수정 권한 |
| --- | --- | --- |
| `hermes_explorer` | read-only 탐색. repo 구조, docs, jobs, skills, ops, VM service 상태 확인 | 금지 |
| `hermes_reviewer` | 보안/운영 리스크 검토. secret 노출, live runtime 오염, 잘못된 경로 사용 위험 확인 | 금지 |
| `hermes_fixer` | main agent가 승인한 최소 수정만 수행. 변경 파일 목록과 검증 결과 보고 | 단일 writer로만 허용 |
| `hermes_verifier` | 테스트, validation, smoke 명령 검증 | destructive command 금지 |

## 6. 모델 사용 원칙

| 모델 | 용도 |
| --- | --- |
| `gpt-5.3-codex-spark` | 기본 병렬 sub-agent 모델. 빠른 탐색, 파일 분류, 경로 확인, 단순 검증, 반복 체크. 저위험 read-only 작업 |
| `gpt-5.3-codex` | 코드 변경, 구조 이해가 필요한 구현, 중간 난이도 수정 |
| `gpt-5.4` 또는 그 이상 | 운영 리스크 판단, 복잡한 장애 분석, 배포 판단, 보안 민감 변경 |
| 최고 성능 모델 | 최종 판단, 위험 작업 승인, 반복 실패 분석, 되돌리기 어려운 운영 변경 검토에만 최소 사용 |

모델 선택 규칙:

1. 먼저 spark로 병렬 탐색한다.
2. spark 결과가 불충분하거나 상충되면 main agent가 재검토한다.
3. 운영 반영 전에는 main agent가 최종 판단한다.
4. 위험한 작업을 sub-agent에게 위임하지 않는다.

## 7. 표준 작업 흐름

1. source repo에서 변경한다.
2. secret scan과 validation을 실행한다.
3. commit/push한다.
4. VM에 접속한다.
5. 배포 대상을 timestamp backup한다.
6. 필요한 파일만 VM target에 반영한다.
7. 해당 systemd user service만 restart한다.
8. smoke test와 status를 확인한다.

VM에서 운영 중 쌓인 변경을 커밋 후보로 만들 때는 `scripts/examples/prepare-vm-source-commit.sh <ssh-target> report`로 먼저 상태를 확인하고, 필요할 때만 `import` 모드로 `.hermes-import/`에 allowlist source 후보를 가져온다. `.hermes-import/`는 검토용이며 커밋 대상이 아니다.

매일 저녁 자동 점검은 `/home/ubuntu/.hermes/hermes-agent`를 기준으로 한다. 전담 change curator는 read-only로 변경 목록을 기능군별로 분류하고, main agent가 위험도와 secret hygiene을 최종 판단한 뒤 커밋/푸시 또는 `personal-hermes-agent` 문서 반영을 수행한다.

## 8. 병렬 작업 흐름 예시

큰 변경 요청을 받으면 다음 순서로 진행한다.

1. main agent가 작업 범위와 위험도를 분류한다.
2. `hermes_explorer`를 spark로 실행해 read-only 구조/경로를 확인한다.
3. `hermes_reviewer`를 spark 또는 상위 모델로 실행해 보안/운영 리스크를 확인한다.
4. main agent가 두 결과를 통합한다.
5. 수정이 필요하면 `hermes_fixer` 하나만 사용하거나 main agent가 직접 최소 변경한다.
6. `hermes_verifier`를 spark로 실행해 validation을 병렬 확인한다.
7. main agent가 최종 보고와 배포 판단을 한다.

동시 수정 금지:

- 같은 파일을 두 sub-agent가 수정하지 않는다.
- live VM runtime 파일은 sub-agent가 직접 수정하지 않는다.
- 배포는 main agent가 명시적으로 수행한다.

## 9. 배포 대상별 절차

### dashboard/control API 변경

- source: `ops/codex-control-dashboard/`
- target: `/home/ubuntu/.hermes/codex-control-dashboard`
- services:
  - `codex-control-api.service`
  - `codex-discord-relay.service`
- acceptance:
  - dashboard는 `127.0.0.1`에 bind한다.
  - mutating endpoint는 `CONTROL_SHARED_SECRET` 또는 localhost CSRF를 요구한다.
  - Discord relay endpoint는 `DISCORD_SHARED_SECRET`을 요구한다.
  - `/api/summary`는 allowlist DTO만 반환한다.
  - raw `/api/state`는 unauthenticated access를 거부한다.
  - `dashboard-smoke.sh`가 통과한다.

### Hermes agent/gateway 변경

- target repo: `/home/ubuntu/.hermes/hermes-agent`
- services:
  - `hermes-gateway.service`
  - `hermes-dashboard.service`
- 주의:
  - 현재 dirty change가 있을 수 있으므로 수정 전 반드시 `git status --short`와 `git diff --stat`를 확인한다.
  - 운영 중 서비스는 필요한 경우에만 해당 service 단위로 restart한다.

### jobs/skills/config 변경

- source repo에 먼저 기록한다.
- validation과 secret scan을 실행한다.
- 필요한 경우 VM에 최소 파일만 반영한다.
- live secrets, state, memory, session, raw log는 반영 대상이 아니다.

## 10. 금지 사항

- 로컬에서 Hermes Agent 실행 금지
- 로컬에서 gateway/dashboard runtime 직접 실행 금지
- VM `.env`, `auth.json`, `state.db`, `memories`, `sessions`, `logs`, raw gateway state 복사 금지
- `/home/ubuntu/.hermes/codex-control-dashboard`를 일반 개발 root로 사용 금지
- backup/archive/timestamp directory 수정 금지
- 운영 중 서비스 무단 중지 금지
- `git reset --hard`, checkout으로 기존 dirty 변경 삭제 금지
- sub-agent 여러 개가 같은 파일을 동시에 수정하는 방식 금지
- spark를 위험한 운영 반영 판단에 단독 사용 금지

## 11. 확인 명령

Windows:

```powershell
git status --short
git remote -v
git branch --show-current
```

Source validation:

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
```

VM pre-change:

```bash
cd /home/ubuntu/.hermes/hermes-agent
git status --short
git diff --stat
systemctl --user status hermes-gateway.service
systemctl --user status hermes-dashboard.service
```

Dashboard smoke on VM:

```bash
set -a
. ~/.hermes/codex-control.env
set +a
PATH="$HOME/.local/bin:$PATH" bash ~/.hermes/codex-control-dashboard/dashboard-smoke.sh
systemctl --user status codex-control-api.service
systemctl --user status codex-discord-relay.service
```
