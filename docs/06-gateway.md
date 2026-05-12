# 06. Gateway

Gateway는 Discord, webhook, API 입력을 Hermes가 처리 가능한 command/event로 변환하는 경계입니다.

## 역할

- 인증/인가된 입력만 전달합니다.
- channel/user/server ID는 공개 repo에 저장하지 않습니다.
- 명령 intent를 분류하고 필요한 prompt 또는 Job Registry workflow로 라우팅합니다.
- 실패 시 민감 정보를 제외한 오류 요약만 반환합니다.

흐름은 `diagrams/gateway-flow.mmd`를 참고하세요.
