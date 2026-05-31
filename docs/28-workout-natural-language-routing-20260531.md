# 운동 자연어 입력 라우팅 개선 - 2026-05-31

## 원인
- pending workout draft thread에서 플러그인이 메시지를 먼저 가로채고, deterministic parser가 실패하면 일반 Hermes agent로 넘기지 않고 고정 실패 응답을 보냈다.
- `화목토`처럼 붙어 있는 요일 축약 표현은 기존 정규식이 한글 단어 내부 문자로 판단해 무시했다.
- `화요일 목요일 토요일 운동 날짜로 변경`은 의미상 요일 배치 변경이지만, 기존 트리거가 `예정/할/이렇게` 쪽에 치우쳐 `변경/날짜` 표현을 놓쳤다.

## 처리
- workout runtime의 pending draft revision parser가 `화목토`, `화/목/토`, `화요일 목요일 토요일`을 모두 화요일/목요일/토요일 배치 변경으로 해석하도록 했다.
- deterministic parser가 해석하지 못한 pending draft thread 메시지는 고정 실패 응답 대신 Hermes agent로 통과시킨다.
- Calendar write는 기존처럼 명시적 confirm/apply 경로에서만 실행된다.
- startup guard 검증에 대표 요일 변경 문장을 추가해 재시작 시 회귀를 잡도록 했다.

## 검증
- gateway와 같은 Python venv에서 runtime/plugin py_compile 통과.
- `운동 일정 화목토로 변경`, `화요일 목요일 토요일 운동 날짜로 변경`, `운동 루틴 화/목/토로 바꿔라`가 모두 화/목/토 운동 배치로 변환됨을 확인.
- `ensure_workout_weekly_plugin.py` startup guard 통과.
