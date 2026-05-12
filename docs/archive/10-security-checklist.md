# 10. Security Checklist

## 반드시 제외

- [ ] 실제 secret/token/API key/OAuth credential
- [ ] cookie/session 파일
- [ ] 로그 원문
- [ ] memory 원문
- [ ] gateway state
- [ ] DB/dump/cache
- [ ] 개인 식별 정보
- [ ] private endpoint/project/account identifier

## 공개 전 검사

```bash
bash scripts/examples/scan-for-secrets.sh
bash scripts/examples/validate-examples.sh
```

탐지 결과가 있으면 커밋하지 말고 placeholder로 교체합니다.
