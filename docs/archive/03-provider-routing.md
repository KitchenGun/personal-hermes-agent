# 03. Provider Routing

Provider routing은 작업 종류, 비용, 지연 시간, 컨텍스트 길이, 도구 필요 여부를 기준으로 모델을 선택합니다.

## 예시 정책

- 문서 요약: 저비용/긴 컨텍스트 모델
- 코드 수정: 도구 사용과 reasoning이 강한 모델
- 민감 작업: 로그 최소화, 외부 전송 전 redaction

실제 provider 이름, 계정, endpoint, token은 포함하지 않습니다.
