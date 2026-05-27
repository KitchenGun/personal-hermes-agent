# Spark 프로필 선택 적용 운영 정책 (2026-05-27)

## 변경 목적

- 전역 기본 모델은 `gpt-5.5`로 유지한다.
- 빠른 조사, 계획, 편집, 가벼운 운영 점검 역할만 `gpt-5.3-codex-spark`로 분리한다.
- 코드 수정, 장애 복구, 테스트, 리뷰 역할은 정확도 우선으로 `gpt-5.5`를 유지한다.

## 적용 내용

- Spark 적용: `researcher`, `planner`, `editor`, `devops_fast`
- `gpt-5.5` 유지: `devops`, `coder`, `fixer`, `tester`, `reviewer`
- `devops_fast`는 기존 `devops`의 `config.yaml`만 복제하고 모델만 Spark로 바꾼 가벼운 점검 전용 프로필이다.
- `QUEUE_SPAWNABLE_PROFILES`에 `devops_fast`를 추가했다.
- `/home/ubuntu/.hermes/config.yaml` 전역 기본 모델은 변경하지 않았다.
- Hermes gateway와 실행 중 worker는 재시작하지 않았다.

## 운영 메모

- 백업 위치: `/home/ubuntu/.hermes/backups/spark-profile-policy-20260527-050509`
- 반영을 위해 `codex-control-api.service`만 재시작했다.
- 신규 dispatch부터 변경된 프로필 모델이 적용된다.
- 장애 복구나 코드 변경이 필요한 작업에는 기존 `devops`, `coder`, `fixer`, `tester`, `reviewer`를 사용한다.
- `devops_fast`는 명시적으로 배정된 가벼운 운영 점검 작업에만 사용한다.

## 검증 결과

- 수정 프로필 YAML 파싱 성공
- `researcher/planner/editor/devops_fast` 모델이 `gpt-5.3-codex-spark`임을 확인
- `devops/coder/fixer/tester/reviewer` 모델이 `gpt-5.5`임을 확인
- `devops_fast` 디렉터리가 `config.yaml`만 가진 config 전용 프로필임을 확인
- `QUEUE_SPAWNABLE_PROFILES`에 `devops_fast` 포함 확인
- supervisor concurrency `4` 유지 확인
- `codex-control-api.service` active 확인
- `hermes-gateway.service` active 및 gateway PID 유지 확인
- 대시보드 API `/api/supervisor`에서 board `codex-control`, concurrency `4`, interval `15000ms`, blocked recovery enabled 확인

## 주의

- `hermes -p <profile> -z` 직접 smoke 호출은 90초 내 모델 헤더를 남기지 못해 중단했다.
- 실제 worker 로그의 Spark 표기는 다음 신규 dispatch 이후 `/home/ubuntu/.hermes/profiles/<profile>/logs/agent.log`에서 확인한다.
