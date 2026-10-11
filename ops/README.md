# Ops

Public-safe operational artifacts derived from the live Hermes VM.

This directory intentionally excludes:

- filled `.env` files
- tokens, cookies, sessions, and DB files
- raw logs and task bodies
- private workspace paths
- live Discord user, channel, or server IDs

## Codex Control Dashboard

`ops/codex-control-dashboard/` contains the versioned source for the VM dashboard/control API.

Deployment boundary:

- VM is the single operating source of truth.
- Local WSL is limited to SSH tunnel and inactive backup/cache roles.
- Dashboard binds to `127.0.0.1`.
- Mutating API endpoints require `CONTROL_SHARED_SECRET` or localhost CSRF.
- Discord relay endpoints require `DISCORD_SHARED_SECRET`.
- `/api/summary` returns an allowlist DTO, not redacted raw task objects.

Smoke test:

```bash
set -a
. ~/.hermes/codex-control.env
set +a
PATH="$HOME/.local/bin:$PATH" bash ~/.hermes/codex-control-dashboard/dashboard-smoke.sh
```

## VM 수동 배포 인계

VM 반영은 GitHub 전체 SHA로 인계한 뒤 운영자가 승인한 수동 runbook으로만 수행합니다.
절차는 [클라우드 개발과 VM 수동 배포 인계](../docs/cloud-vm-deployment-handoff.md)를 따릅니다.
문서 전용 변경은 런타임 파일 복사나 서비스 재시작을 하지 않습니다.
