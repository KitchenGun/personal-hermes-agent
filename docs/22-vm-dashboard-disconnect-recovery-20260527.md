# Dashboard 연결 끊김 근본 원인 및 복구 정책 (2026-05-27)

## 현상

- 로컬 Chrome에서 `http://127.0.0.1:17640` 접속 시 반복적으로 `ERR_CONNECTION_REFUSED`가 발생했다.
- VM의 `codex-control-api.service`는 같은 시각에도 `127.0.0.1:17640`에서 정상 리슨했고 `/api/health`도 정상 응답했다.
- Windows와 WSL 쪽에서만 `127.0.0.1:17640` 리스너가 사라졌다.

## 근본 원인

- 대시보드 백엔드는 VM에서 정상인데, Windows 브라우저가 사용하는 SSH local-forward 터널을 WSL 내부 user-systemd 서비스에 의존하고 있었다.
- WSL journal에서 짧은 간격의 boot 전환과 `oracle-hermes-vm-dashboard-tunnel.service` stop/start가 반복됐다.
- WSL이 종료되면 user-systemd 서비스와 timer도 함께 내려가므로 Windows `127.0.0.1:17640` 리스너가 사라진다.
- 따라서 VM healthcheck나 WSL 서비스 재시작만으로는 부족하다. Windows 브라우저가 쓰는 localhost 포트는 Windows 쪽 long-running process가 붙잡아야 한다.

## 적용한 구조

- 기존 WSL user-systemd dashboard tunnel과 tunnel healthcheck timer는 비활성화했다.
  - `oracle-hermes-vm-dashboard-tunnel.service`
  - `oracle-hermes-vm-dashboard-tunnel-healthcheck.timer`
- Windows Scheduled Task `OracleHermesDashboardTunnel`을 추가했다.
- 이 task는 Windows PowerShell supervisor를 실행하고, supervisor가 `wsl.exe --exec ssh -N -L ...` 프로세스를 유지한다.
- supervisor는 아래 포트를 Windows localhost에 유지한다.
  - `127.0.0.1:9119 -> VM 127.0.0.1:9119`
  - `127.0.0.1:19119 -> VM 127.0.0.1:9119`
  - `127.0.0.1:17640 -> VM 127.0.0.1:17640`
- supervisor는 `http://127.0.0.1:17640/api/health`와 Windows 리스너를 주기적으로 확인한다.
- health가 연속 실패하면 tunnel 프로세스를 종료하고 새로 띄운다.

## 운영 파일

- Windows runtime script: `C:\Users\kang9\.hermes\scripts\oracle-hermes-vm-dashboard-tunnel-supervisor.ps1`
- Windows log: `C:\Users\kang9\.hermes\logs\oracle-hermes-vm-dashboard-tunnel-supervisor.log`
- Versioned source: `ops/windows/oracle-hermes-vm-dashboard-tunnel-supervisor.ps1`
- Installer: `ops/windows/install-oracle-hermes-vm-dashboard-tunnel-task.ps1`

## 검증

- Windows Scheduled Task: `OracleHermesDashboardTunnel` -> `Running`
- Windows listener: `127.0.0.1:9119`, `127.0.0.1:19119`, `127.0.0.1:17640` -> `Listen`
- Windows health: `http://127.0.0.1:17640/api/health` -> HTTP 200
- 75초 대기 후에도 Windows listener와 health 유지 확인
- tunnel child process 강제 종료 후 supervisor가 tunnel을 재시작하고 health를 복구하는 것 확인

## 복구 명령

```powershell
Get-ScheduledTask -TaskName OracleHermesDashboardTunnel
Start-ScheduledTask -TaskName OracleHermesDashboardTunnel
Get-NetTCPConnection -LocalPort 17640 -State Listen
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:17640/api/health
Get-Content $env:USERPROFILE\.hermes\logs\oracle-hermes-vm-dashboard-tunnel-supervisor.log -Tail 20
```

## 판단

- VM API 장애는 VM healthcheck timer로 다룬다.
- 로컬 접속 장애는 Windows Scheduled Task supervisor로 다룬다.
- WSL 내부 user-systemd tunnel은 Windows 브라우저용 진입점으로 쓰지 않는다.
