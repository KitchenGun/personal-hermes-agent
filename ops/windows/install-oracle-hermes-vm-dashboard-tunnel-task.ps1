$ErrorActionPreference = "Stop"

$TaskName = "OracleHermesDashboardTunnel"
$RepoScript = Join-Path (Get-Location) "ops\windows\oracle-hermes-vm-dashboard-tunnel-supervisor.ps1"
$RuntimeDir = Join-Path $env:USERPROFILE ".hermes\scripts"
$RuntimeScript = Join-Path $RuntimeDir "oracle-hermes-vm-dashboard-tunnel-supervisor.ps1"

if (-not (Test-Path $RepoScript)) {
    throw "Repo supervisor script not found: $RepoScript"
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
Copy-Item -Force -Path $RepoScript -Destination $RuntimeScript

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $RuntimeScript)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Keeps Oracle Hermes VM dashboard SSH tunnels available on Windows localhost." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
