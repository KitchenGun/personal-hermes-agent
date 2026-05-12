# 02. 설정 모델

설정은 세 계층으로 분리합니다.

1. `config/hermes.example.yaml`: agent 기능 및 안전 기본값
2. `config/provider-routing.example.yaml`: provider 선택 정책 예시
3. `config/example.env`: 환경변수 placeholder

## 원칙

- repository에는 example 파일만 커밋
- 실제 값은 `.env`, CI secret, secret manager에서 주입
- 공개 예시는 가짜 값과 설명 주석만 포함
