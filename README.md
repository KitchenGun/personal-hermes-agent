# Personal Hermes Agent (Sanitized Operations Profile)

이 저장소는 공개 가능한 형태로 정리한 **개인 Hermes Agent 운영 프로필 및 Job Registry** 예시입니다. 실제 운영 토큰, OAuth 정보, Discord 채널 ID, 개인 메모리 원문, 로그, 세션, DB, gateway state는 포함하지 않습니다.

## 목적

- 성장하는 개인 AI 에이전트의 운영 구조를 문서화합니다.
- Hermes와 대화하며 Job을 추가하면 `jobs/.../*.yaml`이 생성/갱신되는 **Job Registry** 패턴을 제시합니다.
- Memory, Skills, Tools, Gateway, Cron, Delegation, Provider Routing을 공개용/sanitized 예제로 설명합니다.

## 핵심 구성

| 영역 | 요약 |
| --- | --- |
| Memory | 대화/작업 결과에서 장기 기억 후보를 추출하고 승인 후 저장하는 흐름 |
| Skills | 반복 업무를 `SKILL.md` 단위로 캡슐화하는 확장 구조 |
| Tools | 파일, Git, 웹, 스크립트 등 도구 사용 경계와 안전 규칙 |
| Gateway | Discord/API 등 외부 입력을 Hermes 명령으로 라우팅하는 경계 |
| Cron | Job Registry의 schedule을 기준으로 자동 실행 계획 생성 |
| Delegation | coder/researcher/reviewer 같은 하위 역할 위임 패턴 |
| Provider Routing | 작업 성격, 비용, 지연시간, 안전도에 따른 모델 선택 규칙 |


## 문서 목차

Canonical 문서는 아래 00~10 세트입니다. 과거 초안/보조 문서는 `docs/archive/`에 보존합니다.

1. [Overview](docs/00-overview.md)
2. [Architecture](docs/01-architecture.md)
3. [Jobs / Job Registry](docs/02-jobs.md)
4. [Memory](docs/03-memory.md)
5. [Skills](docs/04-skills.md)
6. [Tools](docs/05-tools.md)
7. [Gateway](docs/06-gateway.md)
8. [Cron Automation](docs/07-cron-automation.md)
9. [Provider Routing](docs/08-provider-routing.md)
10. [Delegation](docs/09-delegation.md)
11. [Operation Guide](docs/10-operation-guide.md)

## 디렉터리

```text
config/      공개용 예시 설정과 환경 변수 템플릿
diagrams/    Mermaid 아키텍처/Job/Gateway 흐름
docs/        운영 가이드 문서
jobs/        Hermes가 갱신하는 Job Registry
prompts/     system/agent/workflow/template prompt 예시
scripts/     validator/sync/security scan 예시
skills/      공개용 skill 예시
```

## Job Registry 방식

이 저장소의 `jobs/`는 사람이 수동으로만 YAML을 추가하는 폴더가 아닙니다. 운영자는 Hermes에게 “매주 GitHub 요약 Job을 추가해줘”처럼 요청하고, Hermes가 `prompts/workflows/add-job-to-repo.md` 절차에 따라 적절한 하위 디렉터리에 YAML을 생성/수정합니다. 변경 전후에는 secret scan과 schema validation을 수행합니다.

## 보안 원칙

- 모든 값은 `<YOUR_...>` 또는 `${...}` placeholder만 사용합니다.
- 실제 secret-like 값, API key, OAuth token, channel ID, 개인 식별 정보는 금지합니다.
- 실제 운영 파일을 복사하지 않고 synthetic/sanitized 예시만 작성합니다.

## 빠른 검증

```bash
scripts/examples/scan-for-secrets.sh
scripts/examples/validate-examples.sh
scripts/examples/validate-job-registry.sh
```
