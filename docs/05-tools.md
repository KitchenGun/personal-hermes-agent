# 05. Tools

Tools는 Hermes가 파일, Git, 웹, 스크립트, API를 다루는 실행 경계입니다.

## 안전 규칙

- destructive action은 scope를 확인합니다.
- secret, memory, log, DB 파일을 읽거나 공개 파일로 복사하지 않습니다.
- publish 전 scan script를 실행합니다.
- tools 사용 결과는 Job output에 요약하고 민감 데이터는 redaction합니다.

## 재사용 우선 탐색

- 로컬 repo: README, docs, tests, `rg` 검색을 먼저 사용합니다.
- 도구: 설치된 MCP, connector, plugin, skill을 확인합니다.
- 외부 구현: GitHub, Sourcegraph, grep.app, npm, PyPI, crates.io, Maven Central, pkg.go.dev, Docker Hub를 확인합니다.
- 구현: 검증된 구현의 필요한 부분만 최소 이식합니다.
