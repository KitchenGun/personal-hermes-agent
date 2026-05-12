# 04. Jobs and Automation

`jobs/examples`에는 반복 업무를 선언형으로 표현하는 예시를 둡니다.

## Job 구성 요소

- `name`: 공개 가능한 일반명
- `schedule`: cron 또는 수동 실행
- `prompt_template`: 사용할 프롬프트 템플릿
- `inputs`: placeholder 입력
- `outputs`: 공개 가능한 산출물 경로
- `safety`: 네트워크, 파일쓰기, 개인정보 처리 기준
