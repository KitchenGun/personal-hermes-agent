# 15. Skill Optimization

이 저장소는 `microsoft/SkillOpt`를 직접 벤더링하지 않고, 스킬 개선 절차만 공개-safe 운영 패턴으로 차용합니다.

## 적용 판단

- 채택: rollout, reflection, candidate patch, validation gate, holdout check 개념.
- 보류: SkillOpt 전체 프레임워크, benchmark adapter, WebUI, 대량 output artifact.
- 이유: 이 저장소는 실행 프레임워크가 아니라 sanitized 운영 프로필이며, raw trajectory와 credential이 공개 repo에 들어오면 안 됩니다.
- 라이선스: SkillOpt는 MIT License입니다. 참고 출처는 `https://github.com/microsoft/SkillOpt`입니다.

## 운영 방식

1. 대상 `SKILL.md`와 sanitized 평가 케이스를 정합니다.
2. train/validation/holdout을 작게 나눕니다.
3. 현재 skill 실행 결과를 sanitized pass/fail로만 기록합니다.
4. spark subagent를 병렬로 써서 실패 패턴, 재사용 가능성, 회귀 위험을 분리 검토합니다.
5. 최소 패치만 제안합니다.
6. validation 개선 또는 명확한 안전 결함 수정이 없으면 폐기합니다.
7. 통과한 경우 holdout 결과와 남은 위험만 기록합니다.

## 산출물 경계

- 공개 repo에 둘 수 있음: 개선된 `SKILL.md`, sanitized 평가 요약, 출처와 라이선스 메모.
- 공개 repo에 두면 안 됨: raw trajectory, private prompt, credential, live VM state, 로그, 세션, DB, 개인 메모리 원문.

## Spark 사용

여기서 spark는 빠른 `gpt-5.3-codex-spark` subagent를 뜻합니다. SkillOpt 자체는 Apache Spark를 요구하지 않으므로 Spark 클러스터나 PySpark 의존성은 추가하지 않습니다.
