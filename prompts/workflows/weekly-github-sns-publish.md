# Weekly GitHub SNS Publish Workflow

Use this workflow when Hermes needs to draft weekly SNS updates from GitHub activity and hand them to logged-in browser sessions.

## Inputs

- Fixed `scheduled_at` timestamp.
- Repository allowlist.
- Target platforms, normally `linkedin,x,facebook,instagram`.
- VM-local state directory.
- No platform OAuth token requirement for browser handoff.

## Required Steps

1. Compute the scheduled window from the persisted cursor, not wall-clock "last 7 days".
2. Collect GitHub commit metadata with the GitHub API first and metadata-only `git` fallback.
3. Run sanitization before any SNS draft generation.
4. Generate platform drafts and risk report.
5. Store pending review state with approval token hash only.
6. Accept posting only through the approval state machine.
7. Run `compose` after approval to open platform browser handoff.
8. Let the user click the final platform Post button.
9. Mark the target with `confirm-posted` only after user confirmation.

## Queue Prompt

```text
[queue] 주간 GitHub 커밋 기반 SNS 브라우저 handoff 실행

목표:
고정 scheduled_window의 GitHub commit metadata를 sanitized SNS 초안으로 만들고, 승인된 경우에만 로그인된 브라우저 작성창으로 넘긴다. 플랫폼 OAuth token은 저장하거나 요청하지 않는다.

실행:
- node scripts/weekly_github_sns_publish.js --mode draft --scheduled-at <ISO> --targets linkedin,x,facebook,instagram --manual-handoff
- draft 결과의 run_id, draft_hash, risk_report, approval token을 리뷰 채널에 보고한다.
- 사용자가 /sns confirm <token> 또는 /sns deny <token>으로 승인/거부하도록 안내한다.
- 승인 후 node scripts/weekly_github_sns_publish.js --mode compose --run-id <RUN_ID> --targets linkedin,x,facebook,instagram 를 실행한다.
- X는 intent/tweet URL을 연다.
- LinkedIn은 feed 작성 화면을 열고 draft를 로컬 클립보드에 복사한다.
- Facebook은 feed/Page 작성 화면을 열고 draft를 로컬 클립보드에 복사한다.
- Instagram은 create 화면을 열고 caption을 로컬 클립보드에 복사한다. 사용자가 직접 media를 선택한다.
- 최종 Post 클릭은 사용자가 직접 한다.
- 사용자가 게시 완료를 확인하면 --mode confirm-posted 를 실행한다.

금지:
- OAuth token, cookie, session 값을 요청하거나 출력하지 않는다.
- raw diff, patch, private path, stdout/stderr, raw task body를 SNS 초안이나 audit에 넣지 않는다.
- 브라우저 UI에서 최종 Post 버튼을 자동 클릭하지 않는다.
```
