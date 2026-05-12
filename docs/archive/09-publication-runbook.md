# 09. Publication Runbook

GitHub 공개 전 검수 절차입니다.

1. 새 저장소 경로에서만 작업했는지 확인
2. 원본 운영 파일을 복사하지 않았는지 확인
3. secret-like pattern 스캔 실행
4. `.env`, DB, session, log, memory, gateway state가 없는지 확인
5. README와 docs의 링크 확인
6. GitHub 저장소명을 `personal-hermes-agent`로 생성
7. 공개 전 마지막 diff 검토
