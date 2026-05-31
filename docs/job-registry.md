# Job Registry 카탈로그

이 문서는 공개 저장소에 반영된 Job Registry 항목을 하나의 기준 문서로 정리합니다. 날짜별 스냅샷 문서를 별도로 유지하지 않고, 현재 `jobs/` 디렉터리의 sanitized Job YAML을 기준으로 갱신합니다.

모든 입력값과 출력 대상은 실제 운영 값이 아닌 placeholder 또는 sanitized 예시로만 표기합니다. 실제 token, OAuth secret, Discord ID, 로그, 세션, DB, gateway state, 개인 메모리 원문은 포함하지 않습니다.

## 한눈에 보기

| # | Job | 파일 | 분류 | 실행 주기 | 상태 | 요약 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `daily_calendar_briefing` | [`jobs/daily/daily_calendar_briefing.yaml`](../jobs/daily/daily_calendar_briefing.yaml) | daily | 매일 07:30 | enabled | 승인된 캘린더 소스 placeholder에서 당일 일정을 읽어 private 세부 정보를 제거한 브리핑을 만듭니다. |
| 2 | `daily_weather_report` | [`jobs/daily/daily_weather_report.yaml`](../jobs/daily/daily_weather_report.yaml) | daily | 매일 08:00 | enabled | 공개 날씨 정보를 요약해 일일 리포트 채널 placeholder로 전달합니다. |
| 3 | `memory_candidate_extractor` | [`jobs/maintenance/memory_candidate_extractor.yaml`](../jobs/maintenance/memory_candidate_extractor.yaml) | maintenance | 매일 21:00 | enabled | sanitized 요약에서 장기 기억 후보를 추출하고 승인 전 쓰기를 금지합니다. |
| 4 | `reuse_first_audit` | [`jobs/maintenance/reuse_first_audit.yaml`](../jobs/maintenance/reuse_first_audit.yaml) | maintenance | 매주 금요일 17:00 | enabled | 최근 작업에서 기존 코드, skill, MCP, 공식 문서, 공개 구현 재사용 기회를 놓쳤는지 점검합니다. |
| 5 | `mail_notify_discord` | [`jobs/monitoring/mail_notify_discord.yaml`](../jobs/monitoring/mail_notify_discord.yaml) | monitoring | 5분 간격 | enabled | 승인된 메일함 placeholder를 점검해 새 메일 알림을 sanitized 형태로 전달합니다. |
| 6 | `repo_health_check` | [`jobs/monitoring/repo_health_check.yaml`](../jobs/monitoring/repo_health_check.yaml) | monitoring | 매주 월요일 10:00 | enabled | secret scan, Job Registry 필드 검증, 문서 신선도를 점검합니다. |
| 7 | `ai_trend_collector` | [`jobs/research/ai_trend_collector.yaml`](../jobs/research/ai_trend_collector.yaml) | research | 월/수/금 09:00 | enabled | 공개 AI 트렌드 자료를 수집·중복 제거·출처 포함 요약합니다. |
| 8 | `daily_game_jobs_crawl_to_sheets` | [`jobs/research/daily_game_jobs_crawl_to_sheets.yaml`](../jobs/research/daily_game_jobs_crawl_to_sheets.yaml) | research | 매일 08:00 | enabled | 공개 게임 업계 채용 소스를 수집해 새 항목을 spreadsheet placeholder에 추가합니다. |
| 9 | `job_posting_collector` | [`jobs/research/job_posting_collector.yaml`](../jobs/research/job_posting_collector.yaml) | research | 화/목 08:00 | enabled | 역할·지역 placeholder에 맞는 공개 채용 정보를 요약합니다. |
| 10 | `weekly_game_jobs_digest` | [`jobs/research/weekly_game_jobs_digest.yaml`](../jobs/research/weekly_game_jobs_digest.yaml) | research | 매주 월요일 09:00 | enabled | 정제된 공개 게임 업계 채용 목록에서 주간 매칭 digest를 생성합니다. |
| 11 | `self_review_generator` | [`jobs/weekly/self_review_generator.yaml`](../jobs/weekly/self_review_generator.yaml) | weekly | 매주 일요일 20:00 | enabled | 주간 작업 요약에서 성과, 막힘, 다음 행동을 정리합니다. |
| 12 | `weekly_github_summary` | [`jobs/weekly/weekly_github_summary.yaml`](../jobs/weekly/weekly_github_summary.yaml) | weekly | 매주 금요일 18:00 | enabled | 허가된 저장소의 커밋, PR, 이슈, 릴리스를 주간 요약합니다. |
| 13 | `daily-brief-example` | [`jobs/examples/daily-brief.job.yaml`](../jobs/examples/daily-brief.job.yaml) | examples | 매일 09:00 | draft | 캘린더·작업·날씨 입력을 합성/익명화해 일일 브리핑 예시를 만듭니다. |
| 14 | `repo-maintenance-example` | [`jobs/examples/repo-maintenance.job.yaml`](../jobs/examples/repo-maintenance.job.yaml) | examples | 수동 실행 | draft | 문서 링크, 예시 설정, secret hygiene를 점검하는 저장소 유지보수 예시입니다. |
| 15 | `workout_automation_safeguards` | [`jobs/maintenance/workout_automation_safeguards.yaml`](../jobs/maintenance/workout_automation_safeguards.yaml) | maintenance | 수동 승인 명령 | enabled | 운동 일정 자동화의 Calendar write를 확인 토큰, gid 검증, idempotent upsert 뒤에만 허용합니다. |

## 항목별 설명

### `daily_calendar_briefing`

- **목적**: 승인된 캘린더 소스 placeholder에서 당일 일정 요약을 생성합니다.
- **입력**: `<YOUR_CALENDAR_SOURCE>` 및 `today` date window.
- **주요 단계**: 일정 읽기, 시간·제목·준비 메모 요약, 참석자·비공개 장소·회의 링크 redaction.
- **출력**: `<YOUR_DAILY_BRIEFING_CHANNEL>` placeholder 대상으로 markdown 브리핑 생성.
- **안전 기준**: 실제 캘린더 ID, 계정, 회의 링크, 참석자 정보는 포함하지 않습니다.

### `daily_weather_report`

- **목적**: 지정 지역 placeholder의 공개 날씨 정보를 매일 아침 짧은 리포트로 정리합니다.
- **입력**: `<YOUR_CITY_OR_REGION>`처럼 실제 위치를 직접 노출하지 않는 지역 placeholder.
- **주요 단계**: 승인된 공개 날씨 소스 조회, 기온·강수·특보 요약, 세부 개인 위치 제거.
- **출력**: `<YOUR_DAILY_REPORT_CHANNEL>` placeholder 대상으로 markdown 형식 전송.
- **안전 기준**: secret 포함 금지, 위치 정보는 coarse-grained 형태로 축약.
- **현재 공개 schedule**: 매일 08:00 기준으로 정리합니다.

### `memory_candidate_extractor`

- **목적**: sanitized 요약에서 장기 기억으로 보관할 만한 선호·프로젝트 맥락 후보만 추출합니다.
- **입력**: `<YOUR_SANITIZED_SUMMARY_SOURCE>` placeholder로 지정된 정제 요약 소스.
- **주요 단계**: 정제 요약만 읽기, durable preference/fact/context 식별, secret·일시적 사실·개인 식별자 거부, 사용자 승인용 후보 출력.
- **출력**: `<YOUR_MEMORY_REVIEW_CHANNEL>` placeholder 대상으로 YAML 형식 후보 제공.
- **안전 기준**: 승인 전 메모리 쓰기 금지, secret 후보 즉시 거부.

### `reuse_first_audit`

- **목적**: 최근 작업에서 기존 구현, skill, MCP tool, 공식 문서, 공개 구현을 재사용할 기회를 놓쳤는지 점검합니다.
- **입력**: `<YOUR_PUBLIC_PROFILE_REPOSITORY_PATH>` placeholder와 최근 7일 변경 범위.
- **주요 단계**: 최근 변경 검토, 중복 구현 후보 식별, 사용 가능한 재사용 경로 확인, 실행 가능한 권고만 보고.
- **출력**: `<YOUR_MAINTENANCE_CHANNEL>` placeholder 대상으로 markdown 리포트 생성.
- **안전 기준**: report-only로 동작하며 secret은 redact합니다.

### `mail_notify_discord`

- **목적**: 승인된 메일함 placeholder를 주기적으로 점검하고 새 메일 알림을 전달합니다.
- **입력**: `<YOUR_MAILBOX_SOURCE>`, `<YOUR_DEDUPLICATION_STATE_PATH>` placeholder.
- **주요 단계**: 새 메시지 확인, 중복 제거, 발신자 label·제목·수신 시각 요약, 알림 생성.
- **출력**: `<YOUR_MAIL_NOTIFICATION_CHANNEL>` placeholder 대상으로 markdown 알림 생성.
- **안전 기준**: 메일 본문, credential, 원본 계정 식별자, webhook URL은 공개 예시에 포함하지 않습니다.

### `repo_health_check`

- **목적**: 공개용 저장소가 sanitized 상태를 유지하는지 정기적으로 점검합니다.
- **입력**: `<YOUR_PUBLIC_PROFILE_REPOSITORY_PATH>` placeholder로 지정된 저장소 경로.
- **주요 단계**: secret scan 실행, Job Registry 필수 필드 검증, git 상태와 오래된 문서 노트 확인.
- **출력**: `<YOUR_MAINTENANCE_CHANNEL>` placeholder 대상으로 markdown 리포트 생성.
- **안전 기준**: 기본은 report-only, secret 탐지 시 실패 처리.

### `ai_trend_collector`

- **목적**: AI agents, model routing, developer tools 같은 공개 AI 트렌드를 주기적으로 수집합니다.
- **입력**: 공개 조사 주제 목록.
- **주요 단계**: 승인된 공개 소스 검색, 중복 기사 제거, 출처 링크를 포함한 트렌드 요약.
- **출력**: `<YOUR_RESEARCH_DIGEST_CHANNEL>` placeholder 대상으로 markdown digest 제공.
- **안전 기준**: 공개 소스만 사용하고, 주장에는 출처를 붙입니다.

### `daily_game_jobs_crawl_to_sheets`

- **목적**: 승인된 공개 게임 업계 채용 소스를 매일 수집하고 새 항목을 spreadsheet placeholder에 누적합니다.
- **입력**: `<YOUR_PUBLIC_JOB_SOURCE>`, `<YOUR_CANONICAL_JOB_POSTINGS_SOURCE>`, `<YOUR_SPREADSHEET_TARGET>` placeholder.
- **주요 단계**: 공개 채용 소스 수집, 제목·회사·지역·직무·공개 링크 정규화, 중복 제거, 새 항목 append.
- **출력**: `<YOUR_JOB_PIPELINE_STATUS_CHANNEL>` placeholder 대상으로 markdown 상태 요약 생성.
- **안전 기준**: 공개 채용 정보만 다루며, 지원자 개인정보나 실제 spreadsheet ID/API key는 포함하지 않습니다.

### `job_posting_collector`

- **목적**: 관심 역할과 지역 placeholder에 맞는 공개 채용 공고를 모아 알림으로 정리합니다.
- **입력**: `<YOUR_TARGET_ROLE>`, `<YOUR_TARGET_REGION>` placeholder.
- **주요 단계**: 승인된 공개 채용 소스 검색, 역할·연차·원격 선호 조건 필터링, 제목·회사·위치·링크 요약.
- **출력**: `<YOUR_JOB_ALERT_CHANNEL>` placeholder 대상으로 markdown 알림 생성.
- **안전 기준**: 공개 소스만 사용하며 개인정보를 추론하지 않습니다.

### `weekly_game_jobs_digest`

- **목적**: 정제된 공개 채용 목록과 target profile placeholder를 기준으로 주간 digest를 생성합니다.
- **입력**: `<YOUR_CANONICAL_JOB_POSTINGS_SOURCE>`, `<YOUR_TARGET_ROLE_PROFILE>`, `<YOUR_TARGET_REGION>` placeholder.
- **주요 단계**: 승인된 canonical postings 읽기, 역할·연차·기술·지역 기준 필터링, 회사/직무/우선순위별 그룹화.
- **출력**: `<YOUR_WEEKLY_JOB_DIGEST_CHANNEL>` placeholder 대상으로 markdown digest 생성.
- **안전 기준**: 공개 posting 링크만 사용하며, 개인 후보자 정보를 추론하지 않습니다.

### `self_review_generator`

- **목적**: 주간 작업 요약과 완료된 Job 결과를 바탕으로 자기 회고 문서를 생성합니다.
- **입력**: `<YOUR_SANITIZED_TASK_SUMMARY_SOURCE>` placeholder로 지정된 정제 작업 요약.
- **주요 단계**: 완료 작업 집계, 성과·막힘·다음 행동 식별, 장기 기억 후보와 즉시 작업 분리.
- **출력**: `<YOUR_SELF_REVIEW_CHANNEL>` placeholder 대상으로 markdown 회고 생성.
- **안전 기준**: 메모리는 후보만 생성하고, PII는 redact합니다.

### `weekly_github_summary`

- **목적**: 공개 또는 권한이 있는 저장소의 주간 GitHub 활동을 요약합니다.
- **입력**: `<YOUR_REPOSITORY_SLUG>` placeholder로 지정된 저장소 목록.
- **주요 단계**: 한 주간 커밋·PR·이슈·릴리스 수집, 저장소와 주제별 그룹화, 토큰을 노출하지 않는 후속 작업 정리.
- **출력**: `<YOUR_WEEKLY_SUMMARY_CHANNEL>` placeholder 대상으로 markdown 요약 제공.
- **안전 기준**: secret은 redact하고, private repository는 승인된 범위에서만 다룹니다.

### `daily-brief-example`

- **목적**: 일일 브리핑 Job의 공개 예시로, 캘린더·작업·날씨 입력을 합성 또는 익명화해 다룹니다.
- **입력**: `example-calendar-feed`, `example-task-list`, `example-weather-provider` 같은 예시 소스.
- **주요 단계**: 허용 소스 수집, 오늘의 일정/작업 요약, markdown 브리핑 생성.
- **출력**: `artifacts/public/daily-brief-example.md` 경로 예시.
- **안전 기준**: 네트워크는 기본 비활성화, PII는 합성 또는 redact, secret 출력 금지.

### `repo-maintenance-example`

- **목적**: 저장소 유지보수 Job의 수동 실행 예시입니다.
- **입력**: 현재 저장소와 `docs_links`, `secret_scan`, `example_config_validation` 체크 목록.
- **주요 단계**: 파일 트리 점검, secret scan 실행, Job Registry 검증, 공개 리포트 작성.
- **출력**: `artifacts/public/repo-maintenance-report.md` 경로 예시.
- **안전 기준**: 쓰기는 review 필요, secret 탐지 시 실패, destructive command 금지.

### `workout_automation_safeguards`

- **목적**: 운동 일정 자동화처럼 Calendar write가 포함될 수 있는 workflow를 명시적 확인 토큰 뒤에만 실행하도록 모델링합니다.
- **입력**: `<YOUR_WORKOUT_SPREADSHEET_URL>`, `<YOUR_WORKOUT_SHEET_RANGE>`, `<YOUR_WORKOUT_CALENDAR_ID>`, `<YOUR_PENDING_WORKOUT_PLAN_SOURCE>` placeholder.
- **주요 단계**: 고엔트로피 확인 토큰 생성, `/workout confirm <token>` 또는 `/workout deny <token>`만 승인 명령으로 인정, Google Sheets `gid` metadata 해석, 확인되지 않은 Calendar write 차단, deterministic event ID와 `hermes_marker`/`spec_hash` 기반 upsert, `화목토`/`화/목/토` 같은 운동 요일 변경 자연어 해석, deterministic parser 실패 시 Hermes agent fallback.
- **출력**: `<YOUR_WORKOUT_REVIEW_CHANNEL>` placeholder 대상으로 승인 대기 또는 결과 markdown 생성.
- **안전 기준**: free-text 승인은 무시하고, token/gid/pending plan 상태가 없으면 fail-closed 처리하며, Google/Discord secret은 공개 예시에 포함하지 않습니다.

## 운영 메모

- enabled 항목은 실제 자동화 구조를 반영한 sanitized Job 예시이고, draft 항목은 공개 샘플/템플릿 성격입니다.
- schedule은 cron 문자열, interval 표현, 또는 `manual`로 표현하며 timezone은 `${HERMES_TIMEZONE}` placeholder를 사용합니다.
- 모든 대상 채널, 계정, 캘린더, 메일함, spreadsheet, 지역, 역할, 모델명은 실제 값을 넣지 않고 `<YOUR_...>` 또는 `${...}` placeholder로 유지합니다.
- 카탈로그는 현재 `jobs/` 구조를 설명하는 단일 기준 문서입니다. 날짜별 변경 이력은 Git history와 `CHANGELOG.md`에서 확인합니다.
- 변경 후에는 `scripts/examples/validate-job-registry.sh`와 `scripts/examples/scan-for-secrets.sh`로 검증합니다.
