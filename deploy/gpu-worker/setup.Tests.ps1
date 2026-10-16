# Проверки setup.ps1 без Pester: pwsh deploy/gpu-worker/setup.Tests.ps1
# Запускается только режим -DryRun: в пустой временной папке и с PATH, где вместо winget, uv
# и nvidia-smi лежат подделки, записывающие каждый свой вызов. Ничего не устанавливается.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$Setup = Join-Path $PSScriptRoot 'setup.ps1'
$RunWorker = Join-Path $PSScriptRoot 'run-worker.ps1'
$Pwsh = (Get-Process -Id $PID).Path
$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
$Token = 'test-token-must-not-be-printed'
$script:Passed = 0
$script:Failed = 0

function Assert-True([bool]$Condition, [string]$Name) {
    if ($Condition) {
        $script:Passed++
        Write-Host "  ok    $Name"
    } else {
        $script:Failed++
        Write-Host "  FAIL  $Name" -ForegroundColor Red
    }
}

function New-FakeTool([string]$Dir, [string]$Name, [string]$Log, [string]$Output) {
    if ($OnWindows) {
        $lines = @('@echo off', "echo $Name %*>>`"$Log`"")
        if ($Output) { $lines += "echo $Output" }
        Set-Content -Path (Join-Path $Dir "$Name.cmd") -Value $lines -Encoding ascii
    } else {
        $path = Join-Path $Dir $Name
        $lines = @('#!/bin/sh', "echo `"$Name `$*`" >> '$Log'")
        if ($Output) { $lines += "echo '$Output'" }
        Set-Content -Path $path -Value $lines
        chmod +x $path
    }
}

# Runs setup.ps1 in a fresh empty folder with only the fake tools on PATH.
function Invoke-Setup([string[]]$Arguments, [string[]]$Tools = @(), [string]$GpuLine = 'NVIDIA GeForce RTX 3070 Ti, 8192 MiB, 576.02') {
    $sandbox = Join-Path ([IO.Path]::GetTempPath()) ('perepev-setup-' + [guid]::NewGuid().ToString('N'))
    $bin = New-Item -ItemType Directory -Path (Join-Path $sandbox 'bin')
    $cwd = New-Item -ItemType Directory -Path (Join-Path $sandbox 'cwd')
    $log = Join-Path $sandbox 'calls.log'
    foreach ($tool in $Tools) {
        $output = if ($tool -eq 'nvidia-smi') { $GpuLine } else { '' }
        New-FakeTool $bin.FullName $tool $log $output
    }
    $savedPath = $env:PATH
    $env:PATH = if ($OnWindows) { "$bin;$env:SystemRoot\System32" } else { "$($bin):/usr/bin:/bin" }
    Push-Location $cwd
    try {
        $text = & $Pwsh -NoProfile -NonInteractive -File $Setup @Arguments 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        $env:PATH = $savedPath
    }
    $calls = @(if (Test-Path $log) { Get-Content $log })
    $created = @(Get-ChildItem -Force -Recurse $cwd)
    Remove-Item -Recurse -Force $sandbox
    [pscustomobject]@{ Text = $text; Code = $code; Calls = $calls; Created = $created }
}

function Assert-NoChanges($Run, [string]$Case) {
    Assert-True ($Run.Created.Count -eq 0) "$Case`: nothing is created on disk"
    $changing = @($Run.Calls | Where-Object { $_ -notmatch '^nvidia-smi ' })
    Assert-True ($changing.Count -eq 0) "$Case`: only read-only nvidia-smi is called (got: $($changing -join '; '))"
    Assert-True (-not $Run.Text.Contains($Token)) "$Case`: the token is never printed"
}

Write-Host 'Install plan (-DryRun), no GPU, no uv'
$run = Invoke-Setup @('-DryRun', '-ServerUrl', 'https://perepev.example', '-Token', $Token)
Assert-True ($run.Code -eq 0) "exit code 0 (got $($run.Code))"
foreach ($i in 1..10) {
    Assert-True $run.Text.Contains("[$i/10]") "step $i of 10 is printed"
}
$planned = @(
    'администратор', '17763', '64 бит', 'nvidia-smi', 'CPU', 'winget install --id astral-sh.uv',
    'icacls C:\Perepev /inheritance:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', 'PyTorch видит видеокарту',
    'C:\Perepev\gpu-worker', 'uv sync --extra cuda', 'pytorch-cu128',
    'python -m perepev_worker.main --warmup', 'DPAPI', 'C:\Perepev\token.dat',
    'python -m perepev_worker.main --selftest', 'PerepevWorker', 'SYSTEM',
    '1 мин', '999', 'https://perepev.example', 'ничего не изменено'
)
foreach ($fragment in $planned) {
    Assert-True $run.Text.Contains($fragment) "plan mentions '$fragment'"
}
$acl = $run.Text.IndexOf('icacls C:\Perepev /inheritance:r')
$copy = $run.Text.IndexOf('Скопировать')
$token = $run.Text.IndexOf('C:\Perepev\token.dat')
Assert-True (($acl -ge 0) -and ($acl -lt $copy) -and ($copy -lt $token)) "the folder ACL is set before anything is copied or the token is written ($acl < $copy < $token)"
Assert-NoChanges $run 'install'

Write-Host 'Install plan (-DryRun) with an NVIDIA GPU and uv already present'
$run = Invoke-Setup @('-DryRun', '-ServerUrl', 'https://perepev.example', '-Token', $Token) @('nvidia-smi', 'uv', 'winget')
Assert-True ($run.Code -eq 0) "exit code 0 (got $($run.Code))"
Assert-True $run.Text.Contains('RTX 3070 Ti') 'the GPU found by nvidia-smi is shown'
Assert-True (-not $run.Text.Contains('продолжу на CPU')) 'no CPU warning when a GPU is present'
Assert-True (-not $run.Text.Contains('старше 570')) 'no driver warning for driver 576.02'
Assert-True $run.Text.Contains('uv уже установлен') 'an installed uv is reused'
Assert-True (-not $run.Text.Contains('winget install')) 'winget is not planned when uv exists'
Assert-NoChanges $run 'install with GPU'

Write-Host 'Install plan (-DryRun) with an NVIDIA driver older than 570'
$run = Invoke-Setup @('-DryRun', '-ServerUrl', 'https://perepev.example', '-Token', $Token) @('nvidia-smi') 'NVIDIA GeForce RTX 3070 Ti, 8192 MiB, 531.79'
Assert-True ($run.Code -eq 0) "exit code 0 (got $($run.Code))"
Assert-True $run.Text.Contains('драйвер NVIDIA 531.79 старше 570') 'warns about the old driver'
Assert-NoChanges $run 'old driver'

Write-Host 'Install plan (-DryRun) without -ServerUrl and -Token'
$run = Invoke-Setup @('-DryRun')
Assert-True ($run.Code -eq 0) "exit code 0 without prompting (got $($run.Code))"
Assert-True $run.Text.Contains('будут запрошены') 'says the server URL and token will be asked for'
Assert-NoChanges $run 'install without parameters'

Write-Host 'A server URL that is not http(s) is rejected'
$run = Invoke-Setup @('-DryRun', '-ServerUrl', 'perepev.example', '-Token', $Token)
Assert-True ($run.Code -ne 0) "non-zero exit code (got $($run.Code))"
Assert-True $run.Text.Contains('https://') 'the error shows the expected form'
Assert-NoChanges $run 'bad URL'

Write-Host 'A pasted token with spaces or a line break is trimmed (otherwise its SHA-256 differs and the server answers 401)'
function Get-Fingerprint([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))[0..3] | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}
$run = Invoke-Setup @('-DryRun', '-ServerUrl', 'https://perepev.example', '-Token', " $Token`r`n")
Assert-True ($run.Code -eq 0) "exit code 0 (got $($run.Code))"
Assert-True $run.Text.Contains((Get-Fingerprint $Token)) "the SHA-256 fingerprint of the trimmed token is shown ($(Get-Fingerprint $Token))"
Assert-True (-not $run.Text.Contains((Get-Fingerprint " $Token`r`n"))) 'not the fingerprint of the raw paste'
Assert-NoChanges $run 'padded token'
$run = Invoke-Setup @('-DryRun', '-ServerUrl', 'https://perepev.example', '-Token', "  `t ")
Assert-True ($run.Code -eq 0) "exit code 0 (got $($run.Code))"
Assert-True $run.Text.Contains('будут запрошены') 'a whitespace-only token counts as not given'
$source = Get-Content -Raw $Setup
Assert-True ($source -match 'finally\s*\{\s*\[Runtime\.InteropServices\.Marshal\]::ZeroFreeBSTR\(') 'the BSTR copy of the typed token is zeroed and freed in a finally block'

Write-Host 'Uninstall plan (-Uninstall -DryRun)'
$run = Invoke-Setup @('-Uninstall', '-DryRun')
Assert-True ($run.Code -eq 0) "exit code 0 (got $($run.Code))"
Assert-True $run.Text.Contains('PerepevWorker') 'the scheduled task is removed'
Assert-True $run.Text.Contains('C:\Perepev') 'the install folder is removed'
Assert-True (-not $run.Text.Contains('[1/10]')) 'no install steps run'
Assert-True $run.Text.Contains('ничего не изменено') 'says nothing was changed'
Assert-NoChanges $run 'uninstall'

Write-Host 'Scripts parse and are UTF-8 with BOM (needed by Windows PowerShell 5.1 for Cyrillic)'
foreach ($file in @($Setup, $RunWorker, $PSCommandPath)) {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$errors)
    Assert-True ($errors.Count -eq 0) "$(Split-Path -Leaf $file) parses without errors"
    $head = [IO.File]::ReadAllBytes($file)[0..2]
    Assert-True (($head[0] -eq 0xEF) -and ($head[1] -eq 0xBB) -and ($head[2] -eq 0xBF)) "$(Split-Path -Leaf $file) starts with a UTF-8 BOM"
}

Write-Host ''
Write-Host "$script:Passed passed, $script:Failed failed"
exit $(if ($script:Failed -eq 0) { 0 } else { 1 })
