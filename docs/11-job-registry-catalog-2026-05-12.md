# 11. Job Registry 카탈로그 (2026-05-12)

이 문서는 2026-05-12에 생성/정리된 Job Registry 항목 9개를 공개 저장소용으로 설명합니다. 모든 입력값과 출력 대상은 실제 운영 값이 아닌 placeholder 또는 sanitized 예시로만 표기합니다.

## 한눈에 보기

| # | Job | 파일 | 분류 | 실행 주기 | 상태 | 요약 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `daily_weather_report` | [`jobs/daily/daily_weather_report.yaml`](../jobs/daily/daily_weather_report.yaml) | daily | 매일 07:00 | enabled | 공개 날씨 정보를 요약해 일일 리포트 채널 placeholder로 전달합니다. |
| 2 | `memory_candidate_extractor` | [`jobs/maintenance/memory_candidate_extractor.yaml`](../jobs/maintenance/memory_candidate_extractor.yaml) | maintenance | 매일 21:00 | enabled | sanitized 요약에서 장기 기억 후보를 추출하고 승인 전 쓰기를 금지합니다. |
| 3 | `repo_health_check` | [`jobs/monitoring/repo_health_check.yaml`](../jobs/monitoring/repo_health_check.yaml) | monitoring | 매주 월요일 10:00 | enabled | secret scan, Job Registry 필드 검증, 문서 신선도를 점검합니다. |
| 4 | `ai_trend_collector` | [`jobs/research/ai_trend_collector.yaml`](../jobs/research/ai_trend_collector.yaml) | research | 월/수/금 09:00 | enabled | 공개 AI 트렌드 자료를 수집·중복 제거·출처 포함 요약합니다. |
| 5 | `job_posting_collector` | [`jobs/research/job_posting_collector.yaml`](../jobs/research/job_posting_collector.yaml) | research | 화/목 08:00 | enabled | 역할·지역 placeholder에 맞는 공개 채용 공고를 요약합니다. |
| 6 | `self_review_generator` | [`jobs/weekly/self_review_generator.yaml`](../jobs/weekly/self_review_generator.yaml) | weekly | 매주 일요일 20:00 | enabled | 주간 작업 요약에서 성과, 막힘, 다음 행동을 정리합니다. |
| 7 | `weekly_github_summary` | [`jobs/weekly/weekly_github_summary.yaml`](../jobs/weekly/weekly_github_summary.yaml) | weekly | 매주 금요일 18:00 | enabled | 허가된 저장소의 커밋, PR, 이슈, 릴리스를 주간 요약합니다. |
| 8 | `daily-brief-example` | [`jobs/examples/daily-brief.job.yaml`](../jobs/examples/daily-brief.job.yaml) | examples | 매일 09:00 | draft | 캘린더·작업·날씨 입력을 합성/익명화해 일일 브리핑 예시를 만듭니다. |
| 9 | `repo-maintenance-example` | [`jobs/examples/repo-maintenance.job.yaml`](../jobs/examples/repo-maintenance.job.yaml) | examples | 수동 실행 | draft | 문서 링크, 예시 설정, secret hygiene를 점검하는 저장소 유지보수 예시입니다. |

## 항목별 설명

### 1. `daily_weather_report`

- **목적**: 지정 지역 placeholder의 공개 날씨 정보를 매일 아침 짧은 리포트로 정리합니다.
- **입력**: `<YOUR_CITY_OR_REGION>`처럼 실제 위치를 직접 노출하지 않는 지역 placeholder.
- **주요 단계**: 승인된 공개 날씨 소스 조회, 기온·강수·특보 요약, 세부 개인 위치 제거.
- **출력**: `<YOUR_DAILY_REPORT_CHANNEL>` placeholder 대상으로 markdown 형식 전송.
- **안전 기준**: secret 포함 금지, 위치 정보는 coarse-grained 형태로 축약.

### 2. `memory_candidate_extractor`

- **목적**: sanitized 요약에서 장기 기억으로 보관할 만한 선호·프로젝트 맥락 후보만 추출합니다.
- **입력**: `<YOUR_SANITIZED_SUMMARY_SOURCE>` placeholder로 지정된 정제 요약 소스.
- **주요 단계**: 정제 요약만 읽기, durable preference/fact/context 식별, secret·일시적 사실·개인 식별자 거부, 사용자 승인용 후보 출력.
- **출력**: `<YOUR_MEMORY_REVIEW_CHANNEL>` placeholder 대상으로 YAML 형식 후보 제공.
- **안전 기준**: 승인 전 메모리 쓰기 금지, secret 후보 즉시 거부.

### 3. `repo_health_check`

- **목적**: 공개용 저장소가 sanitized 상태를 유지하는지 정기적으로 점검합니다.
- **입력**: `<YOUR_PUBLIC_PROFILE_REPOSITORY_PATH>` placeholder로 지정된 저장소 경로.
- **주요 단계**: secret scan 실행, Job Registry 필수 필드 검증, git 상태와 오래된 문서 노트 확인.
- **출력**: `<YOUR_MAINTENANCE_CHANNEL>` placeholder 대상으로 markdown 리포트 생성.
- **안전 기준**: 기본은 report-only, secret 탐지 시 실패 처리.

### 4. `ai_trend_collector`

- **목적**: AI agents, model routing, developer tools 같은 공개 AI 트렌드를 주기적으로 수집합니다.
- **입력**: 공개 조사 주제 목록.
- **주요 단계**: 승인된 공개 소스 검색, 중복 기사 제거, 출처 링크를 포함한 트렌드 요약.
- **출력**: `<YOUR_RESEARCH_DIGEST_CHANNEL>` placeholder 대상으로 markdown digest 제공.
- **안전 기준**: 공개 소스만 사용하고, 주장에는 출처를 붙입니다.

### 5. `job_posting_collector`

- **목적**: 관심 역할과 지역 placeholder에 맞는 공개 채용 공고를 모아 알림으로 정리합니다.
- **입력**: `<YOUR_TARGET_ROLE>`, `<YOUR_TARGET_REGION>` placeholder.
- **주요 단계**: 승인된 공개 채용 소스 검색, 역할·연차·원격 선호 조건 필터링, 제목·회사·위치·링크 요약.
- **출력**: `<YOUR_JOB_ALERT_CHANNEL>` placeholder 대상으로 markdown 알림 생성.
- **안전 기준**: 공개 소스만 사용하며 개인정보를 추론하지 않습니다.

### 6. `self_review_generator`

- **목적**: 주간 작업 요약과 완료된 Job 결과를 바탕으로 자기 회고 문서를 생성합니다.
- **입력**: `<YOUR_SANITIZED_TASK_SUMMARY_SOURCE>` placeholder로 지정된 정제 작업 요약.
- **주요 단계**: 완료 작업 집계, 성과·막힘·다음 행동 식별, 장기 기억 후보와 즉시 작업 분리.
- **출력**: `<YOUR_SELF_REVIEW_CHANNEL>` placeholder 대상으로 markdown 회고 생성.
- **안전 기준**: 메모리는 후보만 생성하고, PII는 redact합니다.

### 7. `weekly_github_summary`

- **목적**: 공개 또는 권한이 있는 저장소의 주간 GitHub 활동을 요약합니다.
- **입력**: `<YOUR_REPOSITORY_SLUG>` placeholder로 지정된 저장소 목록.
- **주요 단계**: 한 주간 커밋·PR·이슈·릴리스 수집, 저장소와 주제별 그룹화, 토큰을 노출하지 않는 후속 작업 정리.
- **출력**: `<YOUR_WEEKLY_SUMMARY_CHANNEL>` placeholder 대상으로 markdown 요약 제공.
- **안전 기준**: secret은 redact하고, private repository는 승인된 범위에서만 다룹니다.

### 8. `daily-brief-example`

- **목적**: 일일 브리핑 Job의 공개 예시로, 캘린더·작업·날씨 입력을 합성 또는 익명화해 다룹니다.
- **입력**: `example-calendar-feed`, `example-task-list`, `example-weather-provider` 같은 예시 소스.
- **주요 단계**: 허용 소스 수집, 오늘의 일정/작업 요약, markdown 브리핑 생성.
- **출력**: `artifacts/public/daily-brief-example.md` 경로 예시.
- **안전 기준**: 네트워크는 기본 비활성화, PII는 합성 또는 redact, secret 출력 금지.

### 9. `repo-maintenance-example`

- **목적**: 저장소 유지보수 Job의 수동 실행 예시입니다.
- **입력**: 현재 저장소와 `docs_links`, `secret_scan`, `example_config_validation` 체크 목록.
- **주요 단계**: 파일 트리 점검, secret scan 실행, Job Registry 검증, 공개 리포트 작성.
- **출력**: `artifacts/public/repo-maintenance-report.md` 경로 예시.
- **안전 기준**: 쓰기는 review 필요, secret 탐지 시 실패, destructive command 금지.

## 운영 메모

- enabled 항목은 실제 자동화에 가까운 운영 Job 예시이고, draft 항목은 공개 샘플/템플릿 성격입니다.
- schedule은 cron 문자열 또는 `manual`로 표현하며 timezone은 `${HERMES_TIMEZONE}` placeholder를 사용합니다.
- 모든 대상 채널, 저장소, 지역, 역할, 모델명은 실제 값을 넣지 않고 `<YOUR_...>` 또는 `${...}` placeholder로 유지합니다.
- 변경 후에는 `scripts/examples/validate-job-registry.sh`와 `scripts/examples/scan-for-secrets.sh`로 검증합니다.
