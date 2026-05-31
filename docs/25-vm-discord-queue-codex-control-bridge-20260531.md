# Discord /queue Codex Control bridge - 2026-05-31

## 결정

공식 Hermes `/queue`는 원래 현재 세션의 다음 턴 예약이다. VM 운영에서는 작업큐 채널의 `/queue`를 Codex Control 단일 작업큐로 써야 하므로, `DISCORD_GATEWAY_QUEUE_CHANNEL_IDS`에 포함된 채널에서만 Hermes Discord adapter가 `/queue`를 `http://127.0.0.1:17640/api/discord/task`로 전달한다.

## 변경 사항

- Hermes Discord adapter에 Codex Control queue bridge를 적용한다.
- bridge는 `/home/ubuntu/.hermes/codex-control.env`를 읽어 endpoint, shared secret, queue channel 목록을 얻는다.
- 지정 채널 밖의 `/queue`는 기존 Hermes next-turn queue 동작을 유지한다.
- `codex-discord-relay`는 `/queue` slash interaction만 무시하여 Hermes gateway와 Discord interaction callback 경합을 만들지 않는다. `/codex`, `/task` 같은 보조 slash는 relay 처리 경로를 유지한다.
- relay는 기존처럼 메시지 기반 큐 등록, resume, task 상태 알림을 유지한다.
- gateway 재시작 때 bridge가 유지되도록 `ops/systemd/system/hermes-gateway-codex-control-queue-bridge.conf` 내용을 `/etc/systemd/system/hermes-gateway.service.d/20-codex-control-queue-bridge.conf`에 반영했다.

## 운영 의미

이제 작업큐 채널에서 `/queue`를 사용하면 Discord 응답에 `[대기열 등록]`, 작업 ID, board가 표시되어야 한다. 해당 작업은 `http://127.0.0.1:17640/`의 `codex-control` board에서 추적된다.

## 검증

- `node --check ops/codex-control-dashboard/discord-relay.js`
- `python3 -m py_compile /home/ubuntu/.hermes/hermes-agent/plugins/platforms/discord/adapter.py`
- `/api/discord/task` dry smoke로 `codex-control` 작업 생성 확인
- `codex-discord-relay.service`와 `hermes-gateway.service` 재시작 후 active 확인
- `DISCORD_RELAY_IGNORED_SLASH_COMMANDS=queue`로 relay가 `/queue` callback을 잡지 않는지 확인

## 재발 방지 추가

- Discord slash command ID가 재시작 때마다 흔들리지 않도록 `DISCORD_COMMAND_SYNC_POLICY=off`를 적용한다. 새 slash command를 추가할 때만 임시로 safe/bulk sync를 켠다.
- `/queue`가 Discord client cache 때문에 일시적으로 `더는 사용할 수 없는 명령`을 내면 `[queue] 제목\n상세내용` 일반 메시지 fallback을 사용한다. relay는 이 prefix를 queue 전용 채널에서도 허용한다.
