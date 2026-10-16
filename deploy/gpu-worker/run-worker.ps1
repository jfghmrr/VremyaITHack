# Запуск GPU-воркера Перепева. Его вызывает задача планировщика PerepevWorker от имени SYSTEM
# (её регистрирует setup.ps1): скрипт расшифровывает токен, задаёт окружение и перезапускает
# воркер, если тот завершился. Журнал: C:\Perepev\worker.log.
$ErrorActionPreference = 'Stop'
$Root = 'C:\Perepev'
$Log = "$Root\worker.log"

Add-Type -AssemblyName System.Security
$config = Get-Content -Raw "$Root\worker.json" | ConvertFrom-Json
$blob = [IO.File]::ReadAllBytes("$Root\token.dat")
$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)

$env:PEREPEV_SERVER = $config.server
$env:PEREPEV_WORKER_NAME = $config.worker
$env:PEREPEV_WORKER_TOKEN = [Text.Encoding]::UTF8.GetString($plain)
$env:PEREPEV_MODELS_DIR = "$Root\models"
$env:PYTHONUTF8 = '1'
Set-Location "$Root\gpu-worker"

while ($true) {
    if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 10MB) { Move-Item -Force $Log "$Log.1" }
    # cmd.exe appends both output streams to the log; the paths contain no spaces.
    cmd.exe /d /c "$Root\gpu-worker\.venv\Scripts\python.exe -m perepev_worker.main --workdir $Root\work >> $Log 2>&1"
    $code = $LASTEXITCODE
    # Exit code 2: the server rejected the token, so retry rarely.
    $delay = if ($code -eq 2) { 300 } else { 15 }
    Add-Content -Path $Log -Value "$(Get-Date -Format s) worker exited with code $code, restarting in $delay s"
    Start-Sleep -Seconds $delay
}
