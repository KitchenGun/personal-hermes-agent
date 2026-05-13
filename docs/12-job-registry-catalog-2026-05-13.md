# 12. Job Registry 카탈로그 (2026-05-13)

이 문서는 2026-05-13 기준 공개 저장소에 반영된 Job Registry 항목 13개를 sanitized 형태로 설명합니다. 모든 입력값과 출력 대상은 실제 운영 값이 아닌 placeholder 또는 sanitized 예시로만 표기합니다.

## 한눈에 보기

| # | Job | 파일 | 분류 | 실행 주기 | 상태 | 요약 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `daily_calendar_briefing` | [`jobs/daily/daily_calendar_briefing.yaml`](../jobs/daily/daily_calendar_briefing.yaml) | daily | 매일 07:30 | enabled | 승인된 캘린더 소스 placeholder에서 당일 일정을 읽어 private 세부 정보를 제거한 브리핑을 만듭니다. |
| 2 | `daily_weather_report` | [`jobs/daily/daily_weather_report.yaml`](../jobs/daily/daily_weather_report.yaml) | daily | 매일 08:00 | enabled | 공개 날씨 정보를 요약해 일일 리포트 채널 placeholder로 전달합니다. |
| 3 | `memory_candidate_extractor` | [`jobs/maintenance/memory_candidate_extractor.yaml`](../jobs/maintenance/memory_candidate_extractor.yaml) | maintenance | 매일 21:00 | enabled | sanitized 요약에서 장기 기억 후보를 추출하고 승인 전 쓰기를 금지합니다. |
| 4 | `mail_notify_discord` | [`jobs/monitoring/mail_notify_discord.yaml`](../jobs/monitoring/mail_notify_discord.yaml) | monitoring | 5분 간격 | enabled | 승인된 메일함 placeholder를 점검해 새 메일 알림을 sanitized 형태로 전달합니다. |
| 5 | `repo_health_check` | [`jobs/monitoring/repo_health_check.yaml`](../jobs/monitoring/repo_health_check.yaml) | monitoring | 매주 월요일 10:00 | enabled | secret scan, Job Registry 필드 검증, 문서 신선도를 점검합니다. |
| 6 | `ai_trend_collector` | [`jobs/research/ai_trend_collector.yaml`](../jobs/research/ai_trend_collector.yaml) | research | 월/수/금 09:00 | enabled | 공개 AI 트렌드 자료를 수집·중복 제거·출처 포함 요약합니다. |
| 7 | `daily_game_jobs_crawl_to_sheets` | [`jobs/research/daily_game_jobs_crawl_to_sheets.yaml`](../jobs/research/daily_game_jobs_crawl_to_sheets.yaml) | research | 매일 08:00 | enabled | 공개 게임 업계 채용 소스를 수집해 새 항목을 spreadsheet placeholder에 추가합니다. |
| 8 | `job_posting_collector` | [`jobs/research/job_posting_collector.yaml`](../jobs/research/job_posting_collector.yaml) | research | 화/목 08:00 | enabled | 역할·지역 placeholder에 맞는 공개 채용 정보를 요약합니다. |
| 9 | `weekly_game_jobs_digest` | [`jobs/research/weekly_game_jobs_digest.yaml`](../jobs/research/weekly_game_jobs_digest.yaml) | research | 매주 월요일 09:00 | enabled | 정제된 공개 게임 업계 채용 목록에서 주간 매칭 digest를 생성합니다. |
| 10 | `self_review_generator` | [`jobs/weekly/self_review_generator.yaml`](../jobs/weekly/self_review_generator.yaml) | weekly | 매주 일요일 20:00 | enabled | 주간 작업 요약에서 성과, 막힘, 다음 행동을 정리합니다. |
| 11 | `weekly_github_summary` | [`jobs/weekly/weekly_github_summary.yaml`](../jobs/weekly/weekly_github_summary.yaml) | weekly | 매주 금요일 18:00 | enabled | 허가된 저장소의 커밋, PR, 이슈, 릴리스를 주간 요약합니다. |
| 12 | `daily-brief-example` | [`jobs/examples/daily-brief.job.yaml`](../jobs/examples/daily-brief.job.yaml) | examples | 매일 09:00 | draft | 캘린더·작업·날씨 입력을 합성/익명화해 일일 브리핑 예시를 만듭니다. |
| 13 | `repo-maintenance-example` | [`jobs/examples/repo-maintenance.job.yaml`](../jobs/examples/repo-maintenance.job.yaml) | examples | 수동 실행 | draft | 문서 링크, 예시 설정, secret hygiene를 점검하는 저장소 유지보수 예시입니다. |

## 새로 반영된 운영 패턴

### `daily_calendar_briefing`

- **목적**: 승인된 캘린더 소스 placeholder에서 당일 일정 요약을 생성합니다.
- **입력**: `<YOUR_CALENDAR_SOURCE>` 및 `today` date window.
- **주요 단계**: 일정 읽기, 시간·제목·준비 메모 요약, 참석자·비공개 장소·회의 링크 redaction.
- **출력**: `<YOUR_DAILY_BRIEFING_CHANNEL>` placeholder 대상으로 markdown 브리핑 생성.
- **안전 기준**: 실제 캘린더 ID, 계정, 회의 링크, 참석자 정보는 포함하지 않습니다.

### `mail_notify_discord`

- **목적**: 승인된 메일함 placeholder를 주기적으로 점검하고 새 메일 알림을 전달합니다.
- **입력**: `<YOUR_MAILBOX_SOURCE>`, `<YOUR_DEDUPLICATION_STATE_PATH>` placeholder.
- **주요 단계**: 새 메시지 확인, 중복 제거, 발신자 label·제목·수신 시각 요약, 알림 생성.
- **출력**: `<YOUR_MAIL_NOTIFICATION_CHANNEL>` placeholder 대상으로 markdown 알림 생성.
- **안전 기준**: 메일 본문, credential, 원본 계정 식별자, webhook URL은 공개 예시에 포함하지 않습니다.

### `daily_game_jobs_crawl_to_sheets`

- **목적**: 승인된 공개 게임 업계 채용 소스를 매일 수집하고 새 항목을 spreadsheet placeholder에 누적합니다.
- **입력**: `<YOUR_PUBLIC_JOB_SOURCE>`, `<YOUR_CANONICAL_JOB_POSTINGS_SOURCE>`, `<YOUR_SPREADSHEET_TARGET>` placeholder.
- **주요 단계**: 공개 채용 소스 수집, 제목·회사·지역·직무·공개 링크 정규화, 중복 제거, 새 항목 append.
- **출력**: `<YOUR_JOB_PIPELINE_STATUS_CHANNEL>` placeholder 대상으로 markdown 상태 요약 생성.
- **안전 기준**: 공개 채용 정보만 다루며, 지원자 개인정보나 실제 spreadsheet ID/API key는 포함하지 않습니다.

### `weekly_game_jobs_digest`

- **목적**: 정제된 공개 채용 목록과 target profile placeholder를 기준으로 주간 digest를 생성합니다.
- **입력**: `<YOUR_CANONICAL_JOB_POSTINGS_SOURCE>`, `<YOUR_TARGET_ROLE_PROFILE>`, `<YOUR_TARGET_REGION>` placeholder.
- **주요 단계**: 승인된 canonical postings 읽기, 역할·연차·기술·지역 기준 필터링, 회사/직무/우선순위별 그룹화.
- **출력**: `<YOUR_WEEKLY_JOB_DIGEST_CHANNEL>` placeholder 대상으로 markdown digest 생성.
- **안전 기준**: 공개 posting 링크만 사용하며, 개인 후보자 정보를 추론하지 않습니다.

## 기존 항목 중 갱신된 내용

### `daily_weather_report`

- 공개용 schedule을 매일 08:00 기준으로 갱신했습니다.
- 실제 위치나 좌표를 노출하지 않고 `<YOUR_CITY_OR_REGION>` placeholder만 사용합니다.
- 출력 대상 역시 `<YOUR_DAILY_REPORT_CHANNEL>` placeholder로 유지합니다.

## 기존 항목 요약

- `memory_candidate_extractor`: sanitized 요약에서 장기 기억 후보를 추출하고 승인 전 쓰기를 금지합니다.
- `repo_health_check`: 공개 저장소의 secret scan, Job Registry 검증, 문서 신선도를 점검합니다.
- `ai_trend_collector`: 공개 AI 트렌드 자료를 수집하고 출처 포함 digest로 정리합니다.
- `job_posting_collector`: 역할·지역 placeholder에 맞는 공개 채용 정보를 요약합니다.
- `self_review_generator`: 주간 작업 요약을 바탕으로 회고와 다음 행동을 정리합니다.
- `weekly_github_summary`: 허가된 저장소의 GitHub 활동을 주간 요약합니다.
- `daily-brief-example`: 합성/익명화된 일일 브리핑 Job 예시입니다.
- `repo-maintenance-example`: 문서 링크와 공개 예시 hygiene를 점검하는 수동 유지보수 Job 예시입니다.

## 운영 메모

- enabled 항목은 실제 자동화 구조를 반영한 sanitized Job 예시이고, draft 항목은 공개 샘플/템플릿 성격입니다.
- schedule은 cron 문자열, interval 표현, 또는 `manual`로 표현하며 timezone은 `${HERMES_TIMEZONE}` placeholder를 사용합니다.
- 모든 대상 채널, 계정, 캘린더, 메일함, spreadsheet, 지역, 역할, 모델명은 실제 값을 넣지 않고 `<YOUR_...>` 또는 `${...}` placeholder로 유지합니다.
- live runtime의 token, OAuth secret, Discord ID, 로그, 세션, DB, gateway state, 개인 메모리 원문은 이 카탈로그에 포함하지 않습니다.
- 변경 후에는 `scripts/examples/validate-job-registry.sh`와 `scripts/examples/scan-for-secrets.sh`로 검증합니다.
