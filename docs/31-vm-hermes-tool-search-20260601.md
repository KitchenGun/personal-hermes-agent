# VM Hermes Tool Search 적용 - 2026-06-01

## 판단

- VM Hermes는 `v0.15.1`이지만 `origin/main`보다 뒤처져 있어 Tool Search 공식 구현 파일이 runtime에 없었다.
- 공식 문서 기준 Tool Search는 `tools.tool_search` 설정으로 제어되며, MCP 및 non-core plugin 도구를 `tool_search`, `tool_describe`, `tool_call` bridge 뒤로 지연 노출한다.
- core Hermes 도구는 지연 대상이 아니므로 `terminal`, `read_file`, `patch`, `search_files`, `session_search` 등은 계속 직접 노출된다.

## 적용

- 공식 Hermes 커밋 `369075dc9`, `7427b9d58`의 Tool Search 구현을 runtime Hermes에 선별 적용했다.
- `/home/ubuntu/.hermes/config.yaml` 및 `/home/ubuntu/.hermes/profiles/*/config.yaml`에 다음 정책을 적용했다.

```yaml
tools:
  tool_search:
    enabled: on
    threshold_pct: 0
    search_default_limit: 8
    max_search_limit: 30
```

- `enabled: on`으로 두어 deferrable 도구가 하나라도 있으면 적극적으로 bridge를 사용한다.
- gateway 시작 전 정책 복구용 guard를 `/home/ubuntu/.hermes/scripts/ensure_hermes_tool_search_policy.py`로 배치하고 systemd `ExecStartPre`에 추가했다.

## 검증

- `tools/tool_search.py`, `model_tools.py`, `agent/tool_executor.py`, `agent/agent_runtime_helpers.py`, `hermes_cli/config.py` py_compile 통과.
- `tests/tools/test_tool_search.py`: 39 passed.
- `hermes-discord` toolset에서 `tool_search`, `tool_describe`, `tool_call` bridge 노출 확인.
- `hermes-cli` toolset은 현재 deferrable 도구가 없어 core 도구 직접 노출 유지 확인.
- `hermes-gateway.service` 재시작 후 active/running 확인.

## 운영 메모

- Tool Search는 작은 toolset에서는 오히려 왕복이 늘 수 있으나, Discord/gateway처럼 platform/plugin 도구가 붙는 세션에서는 schema 노출량을 줄이는 쪽이 유리하다.
- 향후 Hermes 전체 업데이트 시 official 구현과 중복될 수 있으므로, 업데이트 후 `tests/tools/test_tool_search.py`와 gateway smoke를 다시 확인한다.
