# DF Trainer: starts the panel with Dauntless Forever's own Node.js (hidden) and opens its window.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Show-Error([string]$msg) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($msg, 'DF Trainer', 'OK', 'Error') | Out-Null
}

# Where the 1.6.2 package is: the folder picked in the panel before, then the usual places
$roots = @()
$settings = Join-Path $here 'trainer-settings.json'
if (Test-Path -LiteralPath $settings) {
    try { $p = (Get-Content -Raw -LiteralPath $settings | ConvertFrom-Json).package; if ($p) { $roots += $p } } catch {}
}
if ($env:LOCALAPPDATA) {
    $roots += (Join-Path $env:LOCALAPPDATA 'DauntlessForever\versions\1.6.2')
    $roots += (Join-Path $env:LOCALAPPDATA 'DauntlessOffline\versions\1.6.2')
}

# Node.js: the package's own (set-up records it in config.json), else one on PATH
$node = $null
foreach ($r in $roots) {
    $cfg = Join-Path $r 'config.json'
    if (Test-Path -LiteralPath $cfg) {
        try {
            $n = (Get-Content -Raw -LiteralPath $cfg | ConvertFrom-Json).Node
            if ($n -and (Test-Path -LiteralPath $n)) { $node = $n; break }
        } catch {}
    }
}
if (-not $node) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
    Show-Error "Node.js was not found.`n`nOpen the Dauntless Forever launcher, pick 1.6.2 and run its Set up once (it installs Node.js), then start the trainer again."
    exit 1
}

$log = Join-Path $here 'trainer.log'
$err = Join-Path $here 'trainer-error.log'
Start-Process -FilePath $node -ArgumentList @("`"$(Join-Path $here 'server.js')`"") -WorkingDirectory $here -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError $err | Out-Null

# The server opens the window itself; if it died straight away, say why
Start-Sleep -Milliseconds 1500
if ((Test-Path -LiteralPath $err) -and (Get-Item -LiteralPath $err).Length -gt 0 -and -not (Select-String -LiteralPath $log -Pattern 'DF Trainer panel' -Quiet)) {
    Show-Error ("The trainer could not start:`n`n" + (Get-Content -Raw -LiteralPath $err))
}
