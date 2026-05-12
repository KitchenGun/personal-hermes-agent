# 05. Tools

Tools는 Hermes가 파일, Git, 웹, 스크립트, API를 다루는 실행 경계입니다.

## 안전 규칙

- destructive action은 scope를 확인합니다.
- secret, memory, log, DB 파일을 읽거나 공개 파일로 복사하지 않습니다.
- publish 전 scan script를 실행합니다.
- tools 사용 결과는 Job output에 요약하고 민감 데이터는 redaction합니다.
