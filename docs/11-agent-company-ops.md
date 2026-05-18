# 11. Agent Company Ops

Hermes를 “agent 직원을 둔 1인 운영 조직”처럼 쓰기 위한 기준입니다.

## 운영 모델

```text
요청 → 업무 티켓화 → 담당 agent 배정 → 산출물 → 검토/테스트 → 기록/재사용
```

## 역할

- Hermes: 관리자, 분류, 배정, 품질 기준 유지.
- Skills: 반복 업무 SOP.
- Jobs: 예약/반복 업무 티켓.
- Tools/MCP: 실행 권한과 외부 시스템 경계.
- Docs/Memory: 재사용 가능한 조직 지식.

## 기본 체인

| 업무 | Agent chain |
| --- | --- |
| 개발 | finder → analyst → coder/editor → reviewer → tester |
| 리서치 | finder → researcher → analyst → documenter |
| 문서화 | finder → analyst → documenter → reviewer |
| 자동화 | planner → coder → security → tester |
| 운영점검 | finder → reviewer → documenter |

## 재사용 우선 원칙

새 구현 전에 다음 순서로 확인합니다.

1. 로컬 repo의 README, docs, tests, 기존 코드.
2. 설치된 skills, MCP tools, connectors, plugins.
3. 공식 문서와 SDK.
4. GitHub, Sourcegraph, grep.app, package registry 구현.
5. 필요한 부분만 최소 이식.

## 기록 기준

- 반복 작업은 `jobs/*.yaml`로 남깁니다.
- 반복 절차는 `skills/*/SKILL.md`로 남깁니다.
- 중요한 결정은 docs에 짧게 기록합니다.
- 외부 구현을 참고하면 출처와 라이선스 확인 여부를 남깁니다.
