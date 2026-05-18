# 04. Skills

Skill은 Hermes가 반복 작업을 더 안정적으로 수행하도록 돕는 절차 문서입니다.

## 구조

```text
skills/
  README.md
  examples/
    research-skill/SKILL.md
    code-review-skill/SKILL.md
```

Hermes에서 실제 탐색 대상이 되려면 `~/.hermes/config.yaml`의 `skills.external_dirs`에 이 저장소의 `skills/` 경로를 추가합니다.

## 작성 원칙

- 명확한 목적, 입력, 단계, 출력, 안전 제한을 포함합니다.
- `SKILL.md`에는 `name`, `description`, `version`, `metadata.hermes.category` frontmatter를 둡니다.
- 실제 credential이나 private endpoint는 포함하지 않습니다.
- Job에서 필요한 경우 `tools`와 함께 참조합니다.

## 탐색 우선 규칙

- 새 skill을 만들기 전에 Hermes Skills Hub, agentskills.io, MCP 서버 목록을 확인합니다.
- 기존 skill이 있으면 그대로 쓰거나 필요한 부분만 공개-safe 형태로 이식합니다.
- 외부 skill을 참고할 때는 출처, 라이선스, 필요한 도구 범위를 기록합니다.
