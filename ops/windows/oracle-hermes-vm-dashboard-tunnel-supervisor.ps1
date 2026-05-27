$ErrorActionPreference = "Stop"

$Name = "OracleHermesDashboardTunnel"
$HealthPort = 17640
$HealthUrl = "http://127.0.0.1:$HealthPort/api/health"
$WslExe = Join-Path $env:WINDIR "System32\wsl.exe"
$LogDir = Join-Path $env:USERPROFILE ".hermes\logs"
$LogFile = Join-Path $LogDir "oracle-hermes-vm-dashboard-tunnel-supervisor.log"
$StdoutFile = Join-Path $LogDir "oracle-hermes-vm-dashboard-tunnel.out.log"
$StderrFile = Join-Path $LogDir "oracle-hermes-vm-dashboard-tunnel.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-TunnelLog {
    param([string] $Message)
    Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date -Format o), $Message)
}

function Test-DashboardHealth {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $HealthPort -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) {
        return $false
    }

    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 -Uri $HealthUrl
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$sshArgs = @(
    "--exec", "ssh", "-N",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UpdateHostKeys=no",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-i", "/home/kang/.ssh/oracle_hermes_vm_ed25519",
    "-L", "127.0.0.1:9119:127.0.0.1:9119",
    "-L", "127.0.0.1:19119:127.0.0.1:9119",
    "-L", "127.0.0.1:17640:127.0.0.1:17640",
    "ubuntu@168.107.10.142"
)

Write-TunnelLog "$Name supervisor started"

while ($true) {
    try {
        Write-TunnelLog "starting tunnel process"
        $process = Start-Process -FilePath $WslExe -ArgumentList $sshArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $StdoutFile -RedirectStandardError $StderrFile
        $startedAt = Get-Date
        $failedChecks = 0

        while (-not $process.HasExited) {
            Start-Sleep -Seconds 10
            if (((Get-Date) - $startedAt).TotalSeconds -lt 20) {
                continue
            }

            if (Test-DashboardHealth) {
                $failedChecks = 0
                continue
            }

            $failedChecks += 1
            Write-TunnelLog "dashboard health failed count=$failedChecks"
            if ($failedChecks -ge 2) {
                Write-TunnelLog "restarting tunnel process after repeated health failures"
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                break
            }
        }

        if ($process.HasExited) {
            Write-TunnelLog "tunnel process exited code=$($process.ExitCode)"
        }
    } catch {
        Write-TunnelLog "supervisor error: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds 5
}
