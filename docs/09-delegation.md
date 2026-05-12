# 09. Delegation

Hermes는 작업을 하위 역할로 위임할 수 있습니다.

## 예시 역할

- `coder`: 코드/파일 수정, 검증, git status 보고
- `researcher`: 웹/문서 조사, 출처 요약
- `reviewer`: 변경사항 검토, 리스크 식별
- `operator`: Cron/Job 상태 확인

## 원칙

- 위임 결과는 최종 응답에서 통합합니다.
- 하위 역할도 secret/publication 규칙을 지켜야 합니다.
- destructive action은 명확한 scope에서만 수행합니다.
