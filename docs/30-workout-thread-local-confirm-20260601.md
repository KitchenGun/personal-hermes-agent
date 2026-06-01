# 운동 thread-local confirm 및 draft 갱신 개선 - 2026-06-01

## 문제

- pending draft thread에서 사용자가 `workout confirm`을 입력하면 token 없는 명령이라 confirm parser가 처리하지 못하고 Hermes agent rewrite로 넘어갔다.
- 자연어로 "토요일 에어소프트가 아닌 운동 루틴으로 교체"를 요청하면 agent가 제안은 했지만 pending draft JSON은 계속 에어소프트 상태로 남았다.
- 이 상태에서 token confirm이 성공해도 Calendar에는 사용자가 의도한 하체/코어 + 유산소가 아니라 기존 에어소프트 draft가 저장될 위험이 있었다.

## 수정 정책

- 자유문장 `확정`, `좋아`, `캘린더 등록`은 계속 Calendar write 승인이 아니다.
- matching pending draft thread 안에서 정확한 `workout confirm`, `/workout confirm`, `workout deny`, `/workout deny`만 thread state의 token으로 해석한다.
- 지원되는 결정적 수정 요청은 agent rewrite 전에 pending draft JSON을 갱신한다.
- 현재 지원 예시는 에어소프트를 하체/코어 + 유산소 루틴으로 교체하는 요청이다.

## 운영 결과

- 2026-06-01 주차 pending draft의 토요일은 `에어소프트/컨디셔닝`에서 `하체/코어 + 유산소` 60분으로 갱신했다.
- Calendar/Sheets write는 아직 수행하지 않았다. 사용자가 pending thread에서 `workout confirm`을 다시 보내야 저장된다.

## 검증

- `python3 -m py_compile` 통과.
- `HERMES_HOME=/home/ubuntu/.hermes python3 /home/ubuntu/.hermes/scripts/ensure_workout_weekly_plugin.py` 통과.
- thread-local confirm smoke 통과: matching thread에서만 `workout confirm`이 token으로 해석되고, `확정`은 계속 무시된다.
- `hermes-gateway.service` 재시작 후 active/running 확인.
