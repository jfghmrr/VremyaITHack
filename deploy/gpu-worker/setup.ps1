<#
.SYNOPSIS
    Установка GPU-воркера Перепева на Windows-ПК с видеокартой NVIDIA.
.DESCRIPTION
    Ставит uv, копирует gpu-worker в C:\Perepev, устанавливает зависимости с PyTorch CUDA,
    скачивает модели, сохраняет токен воркера в зашифрованном виде (DPAPI), проверяет
    конвейеры и регистрирует задачу планировщика PerepevWorker: запуск при старте Windows
    от имени SYSTEM. Входящие порты не открываются: воркер сам обращается к серверу.
    Подробности: README.md рядом с этим файлом.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -ServerUrl https://perepev.lumnex.ru
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -DryRun
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$Token,
    [switch]$DryRun,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$Root = 'C:\Perepev'
$WorkerDir = "$Root\gpu-worker"
$TokenFile = "$Root\token.dat"
$ConfigFile = "$Root\worker.json"
$RunScript = "$Root\run-worker.ps1"
$LogFile = "$Root\worker.log"
$TaskName = 'PerepevWorker'
$Source = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'gpu-worker'
$TotalSteps = 10
$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
$script:StepNo = 0
$script:Uv = $null
$script:Problems = @()

function Write-Step([string]$Title) {
    $script:StepNo++
    Write-Host ''
    Write-Host "[$script:StepNo/$TotalSteps] $Title" -ForegroundColor Cyan
}

function Write-Info([string]$Text) { Write-Host "    $Text" }

function Write-Warn([string]$Text) {
    Write-Host "    ВНИМАНИЕ: $Text" -ForegroundColor Yellow
    $script:Problems += $Text
}

function Stop-Setup([string]$Text) {
    Write-Host "ОШИБКА: $Text" -ForegroundColor Red
    exit 1
}

# Runs a change, or with -DryRun only prints it.
function Invoke-Change([string]$Description, [scriptblock]$Action) {
    if ($DryRun) {
        Write-Host "    [DryRun] $Description" -ForegroundColor DarkGray
        return
    }
    Write-Host "    $Description"
    & $Action
}

# Runs an external program; stderr is progress output, so only the exit code decides.
function Invoke-Native([string]$File, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $File @Arguments | Out-Host } finally { $ErrorActionPreference = $saved }
    if ($LASTEXITCODE -ne 0) { Stop-Setup "$(Split-Path -Leaf $File) $($Arguments -join ' '): код выхода $LASTEXITCODE" }
}

function Find-Uv {
    $cmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if ($OnWindows) {
        foreach ($path in @("$env:LOCALAPPDATA\Microsoft\WinGet\Links\uv.exe", "$env:ProgramFiles\WinGet\Links\uv.exe",
                            "$env:USERPROFILE\.local\bin\uv.exe")) {
            if (Test-Path $path) { return $path }
        }
    }
    return $null
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-Worker {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    Get-Process -Name python, pythonw -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2  # let cmd.exe release worker.log before files are replaced or removed
}

# A pasted token often ends with a space or a line break; its SHA-256 would then differ from
# WORKER_TOKEN_SHA256 and the server would answer 401. Whitespace at both ends is dropped.
function Format-Token([string]$Value) {
    if ($null -eq $Value) { return '' }
    return $Value.Trim()
}

# Plain text of a typed SecureString; the unmanaged BSTR copy is zeroed and freed at once.
function Read-SecureToken([securestring]$Secure) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return Format-Token ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# First 8 hex characters of the token's SHA-256: compare with WORKER_TOKEN_SHA256 on the server
# without showing the token itself.
function Get-TokenFingerprint([string]$Plain) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Plain)) } finally { $sha.Dispose() }
    return -join ($hash[0..3] | ForEach-Object { $_.ToString('x2') })
}

# The task runs as SYSTEM, which cannot read a user-scoped DPAPI blob (ConvertFrom-SecureString),
# so the token is encrypted for this computer. The file inherits the folder ACL set in step 4
# (SYSTEM and Administrators only) from the moment it is created.
function Protect-Token([string]$Plain) {
    Add-Type -AssemblyName System.Security
    $blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($Plain), $null,
        [Security.Cryptography.DataProtectionScope]::LocalMachine)
    [IO.File]::WriteAllBytes($TokenFile, $blob)
}

# SYSTEM runs code and reads the server address from $Root at every boot, so only SYSTEM and
# Administrators may write there. A folder pre-created by another user would stay theirs as owner,
# so ownership is taken back and existing children are reset to inherit the new ACL.
function Protect-Root {
    if ((Test-Path $Root) -and ((Get-Item -Force $Root).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Stop-Setup "$Root — ссылка на другую папку. Удалите её и повторите установку."
    }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    Invoke-Native icacls @($Root, '/setowner', '*S-1-5-32-544', '/T', '/C', '/Q')
    Invoke-Native icacls @($Root, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
    if (Get-ChildItem -Force $Root) { Invoke-Native icacls @("$Root\*", '/reset', '/T', '/C', '/Q') }
}

# Asks the installed worker which torch device it will use: cuda or cpu.
function Get-WorkerDevice {
    Push-Location $WorkerDir
    try {
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $out = & $script:Uv run --no-sync python -c 'from perepev_worker.runtime import device; print(device())' 2>$null
        } finally { $ErrorActionPreference = $saved }
        return [string]($out | Select-Object -Last 1)
    } finally {
        Pop-Location
    }
}

function Invoke-Worker([string[]]$Arguments) {
    Push-Location $WorkerDir
    try {
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $script:Uv run --no-sync python -m perepev_worker.main @Arguments | Out-Host } finally { $ErrorActionPreference = $saved }
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

# --- Uninstall -------------------------------------------------------------------------------

if ($Uninstall) {
    Write-Host 'Удаление GPU-воркера Перепева'
    if (-not $OnWindows) {
        if (-not $DryRun) { Stop-Setup 'Удаление работает только в Windows.' }
    } elseif (-not (Test-Admin)) {
        if (-not $DryRun) { Stop-Setup 'Запустите PowerShell от имени администратора.' }
        Write-Warn 'нет прав администратора: для настоящего удаления они понадобятся'
    }
    Invoke-Change "Остановить воркер и удалить задачу планировщика $TaskName" {
        Stop-Worker
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
    }
    Invoke-Change "Удалить папку $Root (код, Python, модели, токен, журнал)" {
        if (Test-Path $Root) { Remove-Item -Recurse -Force $Root }
    }
    if ($DryRun) { Write-Host 'Режим -DryRun: ничего не изменено.' } else { Write-Host 'GPU-воркер удалён.' -ForegroundColor Green }
    exit 0
}

# --- Install ---------------------------------------------------------------------------------

Write-Host 'Установка GPU-воркера Перепева'
if ($DryRun) { Write-Host 'Режим -DryRun: показываю план, ничего не меняю.' -ForegroundColor DarkGray }

$Token = Format-Token $Token
if ($ServerUrl -and $ServerUrl -notmatch '^https?://[^\s/]+') {
    Stop-Setup "адрес сервера должен начинаться с https:// (или http:// для локальной проверки), получено: $ServerUrl"
}
if (-not $DryRun) {
    if (-not $OnWindows) { Stop-Setup 'Установщик работает только в Windows. На другой системе доступен только -DryRun.' }
    if (-not $ServerUrl) {
        $ServerUrl = (Read-Host 'Адрес сервера Перепева (например, https://perepev.lumnex.ru)').Trim()
        if ($ServerUrl -notmatch '^https?://[^\s/]+') { Stop-Setup 'адрес сервера должен начинаться с https://' }
    }
    if (-not $Token) {
        $Token = Read-SecureToken (Read-Host 'Токен воркера (ввод скрыт)' -AsSecureString)
        if (-not $Token) { Stop-Setup 'токен воркера не введён' }
    }
} elseif (-not $ServerUrl -or -not $Token) {
    Write-Info 'Адрес сервера и токен будут запрошены при настоящей установке (токен вводится скрыто).'
}
if ($Token) {
    Write-Info "Отпечаток токена (первые 8 символов SHA-256): $(Get-TokenFingerprint $Token). WORKER_TOKEN_SHA256 на сервере должен начинаться так же."
}
$ServerUrl = if ($ServerUrl) { $ServerUrl.TrimEnd('/') } else { '<адрес сервера>' }
$WorkerName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName }

Write-Step 'Версия Windows и права администратора'
if (-not $OnWindows) {
    Write-Info 'Не Windows: проверки пропущены (нужны Windows 10 или 11, 64 бит, сборка 17763 или новее, и права администратора; здесь доступен только -DryRun).'
} else {
    $os = [Environment]::OSVersion.Version
    $is64 = [Environment]::Is64BitOperatingSystem
    if ($os.Build -ge 17763 -and $is64) {
        Write-Info "Windows $($os.Major).$($os.Minor), сборка $($os.Build), 64 бит."
    } else {
        $message = "нужны Windows 10 или 11, 64 бит, сборка 17763 или новее; здесь сборка $($os.Build), 64 бит: $(if ($is64) { 'да' } else { 'нет' })"
        if ($DryRun) { Write-Warn $message } else { Stop-Setup $message }
    }
    if (Test-Admin) {
        Write-Info 'PowerShell запущен от имени администратора.'
    } elseif ($DryRun) {
        Write-Warn 'нет прав администратора: для настоящей установки они понадобятся'
    } else {
        Stop-Setup 'Запустите PowerShell от имени администратора: правый клик → «Запуск от имени администратора».'
    }
}

Write-Step 'Видеокарта NVIDIA (nvidia-smi)'
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
$gpu = $null
if ($smi) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $gpu = (& $smi.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>$null | Select-Object -First 1) } finally { $ErrorActionPreference = $saved }
}
if ($gpu) {
    Write-Info "Найдена: $gpu"
    $driver = ($gpu -split ',')[-1].Trim()
    $major = 0
    if ([int]::TryParse(($driver -split '\.')[0], [ref]$major) -and $major -lt 570) {
        Write-Warn "драйвер NVIDIA $driver старше 570 (ветка драйвера для CUDA 12.8): PyTorch может не увидеть видеокарту, и оценка пойдёт на CPU. Обновите драйвер."
    }
} else {
    Write-Warn 'nvidia-smi не найден или не видит видеокарту: продолжу на CPU (оценка будет медленной). Установите драйвер NVIDIA версии 570 или новее.'
}
if ($OnWindows) {
    $drive = Get-PSDrive -Name C -ErrorAction SilentlyContinue
    if ($drive) {
        $freeGb = [math]::Round($drive.Free / 1GB)
        Write-Info "Свободно на диске C: $freeGb ГБ (нужно около 15 ГБ)."
        if ($freeGb -lt 15) { Write-Warn "на диске C: меньше 15 ГБ" }
    }
}

Write-Step 'Менеджер Python uv'
$script:Uv = Find-Uv
if ($script:Uv) {
    Write-Info "uv уже установлен: $script:Uv"
} else {
    Invoke-Change 'winget install --id astral-sh.uv -e --accept-package-agreements --accept-source-agreements' {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            Stop-Setup 'winget не найден. Установите «Установщик приложений» (App Installer) из Microsoft Store и повторите.'
        }
        Invoke-Native winget @('install', '--id', 'astral-sh.uv', '-e', '--accept-package-agreements', '--accept-source-agreements')
        $env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        $script:Uv = Find-Uv
        if (-not $script:Uv) { Stop-Setup 'uv установлен, но не найден. Откройте новое окно PowerShell от имени администратора и повторите.' }
        Write-Info "uv: $script:Uv"
    }
}

Write-Step "Копирование воркера в $WorkerDir"
if (-not (Test-Path (Join-Path $Source 'pyproject.toml'))) {
    if (-not $DryRun) { Stop-Setup "не найдена папка gpu-worker рядом со скриптом: $Source. Запускайте setup.ps1 из полной копии репозитория." }
    Write-Warn "не найдена папка gpu-worker: $Source"
}
Invoke-Change 'Остановить прежний воркер, если он запущен' { Stop-Worker }
Invoke-Change "Создать $Root и закрыть доступ до копирования и записи токена: владелец — администраторы, icacls $Root /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F (только SYSTEM и администраторы)" {
    Protect-Root
}
Invoke-Change "Скопировать $Source → $WorkerDir (без .venv и кешей) и run-worker.ps1 → $RunScript" {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { robocopy $Source $WorkerDir /E /NFL /NDL /NJH /NJS /NP /XD .venv __pycache__ .pytest_cache | Out-Null } finally { $ErrorActionPreference = $saved }
    if ($LASTEXITCODE -ge 8) { Stop-Setup "robocopy завершился с кодом $LASTEXITCODE" }
    Copy-Item -Force (Join-Path $PSScriptRoot 'run-worker.ps1') $RunScript
}

Write-Step 'Зависимости Python с PyTorch CUDA'
Write-Info "Python 3.12 и кеш uv ставятся в $Root\python и $Root\uv-cache; PyTorch 2.11 CUDA 12.8 — из индекса pytorch-cu128, закреплённого в pyproject.toml и uv.lock."
Invoke-Change 'uv sync --extra cuda --frozen --no-dev --managed-python' {
    $env:UV_PYTHON_INSTALL_DIR = "$Root\python"
    $env:UV_CACHE_DIR = "$Root\uv-cache"
    $env:PEREPEV_MODELS_DIR = "$Root\models"
    $env:PYTHONUTF8 = '1'
    Push-Location $WorkerDir
    try { Invoke-Native $script:Uv @('sync', '--extra', 'cuda', '--frozen', '--no-dev', '--managed-python') } finally { Pop-Location }
}

Write-Step 'Загрузка моделей (Demucs, torchcrepe, Whisper)'
Invoke-Change "uv run --no-sync python -m perepev_worker.main --warmup (модели → $Root\models, около 2 ГБ)" {
    $code = Invoke-Worker @('--warmup')
    if ($code -ne 0) { Stop-Setup "загрузка моделей не удалась (код $code). Проверьте интернет и повторите setup.ps1." }
}
Invoke-Change 'Проверить, что PyTorch видит видеокарту: perepev_worker.runtime.device() должно вернуть cuda' {
    $device = Get-WorkerDevice
    Write-Info "Устройство воркера: $device"
    if ($gpu -and $device -ne 'cuda') {
        Write-Host '    !!! Видеокарта NVIDIA найдена, но PyTorch её не видит: воркер будет считать на CPU, и оценка не уложится в 20 секунд.' -ForegroundColor Red
        Write-Host '    !!! Обновите драйвер NVIDIA (570 или новее), перезагрузите ПК и повторите setup.ps1.' -ForegroundColor Red
        $script:Problems += 'PyTorch не видит видеокарту: воркер работает на CPU'
    }
}

Write-Step 'Токен воркера (DPAPI)'
Invoke-Change "Зашифровать токен DPAPI (ключ этого компьютера) → $TokenFile; права папки: читать файл могут только SYSTEM и администраторы" {
    Protect-Token $Token
}
Invoke-Change "Сохранить адрес сервера ($ServerUrl) и имя воркера ($WorkerName) → $ConfigFile" {
    [ordered]@{ server = $ServerUrl; worker = $WorkerName } | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}

Write-Step 'Самопроверка'
Invoke-Change 'uv run --no-sync python -m perepev_worker.main --selftest (разделение, мелодия, слова, просачивание и связь с сервером)' {
    $env:PEREPEV_SERVER = $ServerUrl
    $env:PEREPEV_WORKER_NAME = $WorkerName
    $env:PEREPEV_WORKER_TOKEN = $Token
    try { $code = Invoke-Worker @('--selftest') } finally { Remove-Item Env:\PEREPEV_WORKER_TOKEN -ErrorAction SilentlyContinue }
    if ($code -ne 0) { Write-Warn 'самопроверка не прошла (см. строки FAIL выше); задача всё равно будет зарегистрирована' }
}

Write-Step "Задача планировщика $TaskName"
Invoke-Change "Зарегистрировать ${TaskName}: при старте Windows, от имени SYSTEM, перезапуск каждую 1 мин до 999 раз; запустить сейчас" {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $RunScript"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest  # SYSTEM
    $settings = New-ScheduledTaskSettingsSet -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'GPU-воркер Перепева (deploy/gpu-worker/setup.ps1)' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
}

Write-Step 'Состояние'
if ($DryRun) {
    Write-Info "После установки здесь будет состояние задачи $TaskName и путь к журналу $LogFile."
    if ($script:Problems.Count -gt 0) { Write-Info "Предупреждений: $($script:Problems.Count)." }
    Write-Host 'Режим -DryRun: ничего не изменено.'
    exit 0
}
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $TaskName
$info = $task | Get-ScheduledTaskInfo
Write-Info "Задача ${TaskName}: $($task.State); последний результат: $($info.LastTaskResult)."
Write-Info "Сервер: $ServerUrl; имя воркера: $WorkerName."
Write-Info "Журнал воркера: $LogFile"
Write-Info 'Удаление: powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Uninstall'
if ($script:Problems.Count -gt 0) {
    Write-Host 'Установка завершена с предупреждениями:' -ForegroundColor Yellow
    $script:Problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
} else {
    Write-Host 'GPU-воркер установлен и запущен.' -ForegroundColor Green
}
