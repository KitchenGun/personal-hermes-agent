# workout_command

Hermes Discord `/workout` command plugin.

Runtime config belongs in `~/.hermes/config.yaml` or environment variables, not in this public repo.

```yaml
plugins:
  enabled:
    - workout_command

workout:
  timezone: Asia/Seoul
  discord:
    channel_allowlist:
      - "${WORKOUT_DISCORD_CHANNEL_ID}"
    register_native_slash: false
  google:
    spreadsheet_id: "${WORKOUT_SPREADSHEET_ID}"
    workout_range: "운동기록!A:H"
    inbody_range: "인바디!A:G"
```

`/workout` is handled as a normal Discord text message through `pre_gateway_dispatch`.
Native Discord slash registration is disabled by default because Discord command sync can lag or keep stale global commands after gateway restarts.

Commands:

- `/workout help`
- `/workout log 날짜: 2026-05-19; 등; 바벨로우 30kg 8회 4세트`
- `/workout inbody 검사일시: 2026-05-19 20:10; 체중: 78.1kg; 골격근량: 30.5kg; 체지방률: 30.7%`
- `/workout today`
- `/workout recent`
- `/workout undo`
- `/workout confirm <token>`
- `/workout deny <token>`
