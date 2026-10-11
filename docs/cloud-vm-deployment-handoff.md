# 클라우드 개발과 VM 수동 배포 인계

이 문서는 클라우드나 로컬에서 준비한 변경을 VM에 수동으로 반영할 때의 인계
기준입니다. VM은 운영 상태의 단일 source of truth로 유지합니다.

## 배포 경로

코드 배포는 운영자가 승인한 수동 runbook으로만 수행합니다. GitHub push, PR,
release는 VM에 자동으로 반영되지 않습니다. 저장소에 있던 GitHub 기반 자동 배포
구성(deploy control worker/updater, 고정 byte patch recipe, application release
manifest)은 2026-10-11 에 제거했고, VM에 남아 있던 updater 흔적도 같은 날
정리했습니다.

## 역할과 경계

- 클라우드/로컬: 공개 저장소의 코드·문서 수정, 변경 범위에 맞는 검증, 검토용 브랜치 게시
- GitHub: 검토 가능한 diff와 변경 불가능한 전체 커밋 SHA를 통한 인계
- VM: 운영자가 승인한 SHA의 파일만 runbook에 따라 반영
- 로컬 PC/WSL: 사용자가 직접 실행하는 초기 bootstrap과 비상 관리 전용

운영 secret, 채워진 env, raw log/DB, 개인 데이터와 private workspace path는
클라우드나 GitHub로 옮기지 않습니다. VM의 실제 경로와 인증 정보도 이 공개 문서에
기록하지 않습니다.

## 1. 변경 준비

1. 시작 HEAD와 `git status --short`, `git diff --stat`를 확인합니다.
2. `AGENTS.md`와 변경 대상의 지침을 읽고 unrelated dirty change를 보존합니다.
3. 작은 변경 단위와 검증 범위를 정합니다. 자원이 제한된 환경에서 전체 테스트를
   무조건 실행하지 않고, 변경에 필요한 focused test와 정적 검사를 먼저 정합니다.
4. 실행한 명령, 종료 상태, 미실행 항목과 실행 환경 차이를 기록합니다.
5. 공개 안전 검사를 수행한 뒤 검토용 브랜치에 게시하고 GitHub의 전체 SHA를 확인합니다.
   기본 브랜치 직접 push는 명시적 승인이 있을 때만 수행합니다.

문서만 변경했을 때의 공개 전 기본 검증:

```bash
git diff --check
bash scripts/examples/scan-for-secrets.sh
bash scripts/examples/validate-examples.sh
```

`validate-examples.sh`는 job registry 검증도 실행하며 Python의 PyYAML이 필요합니다.
이 검사는 문서·예시의 제한된 정적 검증입니다. dashboard 런타임, 인증, 실제 배포의
정상 동작을 보증하지 않습니다. 변경한 Markdown 링크도 대상 파일이 있는지 확인합니다.

Node 버전이 클라우드와 VM에서 다르면 검증 결과에 두 환경을 구분해서 적습니다.
예를 들어 Node 24에서 통과한 테스트만으로 Node 22 호환성을 확정하지 않습니다.

## 2. SHA 기반 인계

인계에는 다음 정보를 포함합니다.

- 검토용 브랜치/커밋 링크
- 기준 전체 SHA와 배포 대상 전체 SHA
- 변경 파일 목록, 목적, 문서 전용인지 런타임 변경인지
- 실행한 검증 명령과 결과, 미실행 항목 및 환경 차이
- 반영할 VM 파일과 재시작할 서비스, 예상 영향
- 배포 후 확인 기준 및 런타임 변경 시 rollback 기준

브랜치명만으로 배포 대상을 정하지 않습니다. 인계 후 브랜치가 이동해도 대상 SHA는
바뀌지 않습니다.

## 3. VM 수동 반영

아래 항목을 확인할 수 없으면 반영을 멈추고 원인을 보고합니다.

1. 운영자가 이번 반영을 승인했습니다. 거래일 장중과 예약 작업 실행 중에는
   런타임 파일을 바꾸거나 서비스를 재시작하지 않습니다.
2. 대상 SHA의 파일을 git bundle 또는 tar로 VM에 전달하고, 전달받은 내용이 인계된
   SHA와 변경 파일 목록에 맞는지 확인합니다.
3. VM의 현재 파일과 dirty change를 확인했습니다. 기존 변경을 덮어쓰거나 자동으로
   stash/reset/clean하지 않습니다. 예상 기준과 다르면 새 기준으로 재검토합니다.
4. 반영할 파일마다 같은 디렉터리에 timestamp가 붙은 `.before-*` 백업을 만들고
   sha256을 기록합니다.
5. 새 파일은 임시 이름으로 복사한 뒤 rename으로 교체합니다. 실행 중인 import
   경로가 중간 상태를 읽지 않도록 의존 순서대로 교체합니다.
6. `kis-ai-market-open-dry-run-task.js`는 운영 사본과 승인 source 사본
   (`KIS_HERMES_APPROVED_SOURCE_PATH`)을 함께 반영하고 두 파일의 sha256이 같은지
   확인합니다. 다르면 resume/enable-order/cutover가 `runtime_source_parity_failed`로
   막힙니다.
7. env와 운영 상태는 VM-local로 유지하고, 기존 권한과 보안 경계를 보존합니다.

문서 전용 변경은 VM 파일 복사나 서비스 재시작을 하지 않습니다. 런타임 변경은 인계된
파일만 반영하고 필요한 user service만 재시작한 뒤 smoke test를 수행합니다. dashboard
검증은 [운영 안내](../ops/README.md)의 smoke test와
[dashboard 문서](12-codex-control-dashboard.md)를 따릅니다.

검증 실패 시 성공으로 보고하지 않습니다. `.before-*` 백업에서 복구하고 복구한 파일의
sha256과 재검증 결과를 남깁니다. 복구에 추가 권한이 필요하면 중단하고 요청합니다.
`.before-*` 백업은 반영 후 정해진 확인 기간이 끝날 때까지 지우지 않습니다.

## 4. 완료 보고

GitHub 게시, VM 파일 반영, 서비스 재시작, smoke test는 각각 구분해서 보고합니다.
완료 보고에는 확인한 GitHub SHA, 반영한 파일과 sha256, 실행한 검사 결과, 재시작 여부,
남은 제약을 포함합니다. 한 단계의 성공을 다음 단계의 성공으로 대신하지 않습니다.
