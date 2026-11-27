# Antigravity 自动更新时由语言包启动的一次性衔接脚本（隐藏窗口运行，完成即退出）：
#   等 Antigravity 退出、安装器替换完 app.asar → 重新打补丁 → 若原本要重启则启动 Antigravity。
# 不注册任何计划任务 / 自启动项，不强制结束任何进程。
param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [string]$OldHash = 'unknown',
    [int]$ParentPid = 0,
    [string]$Relaunch = '0',
    [int]$TimeoutMinutes = 15
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$log = { param($t) Write-AgyLog $DataDir 'update.log' $t }

try {
    & $log "bridge start (parent=$ParentPid relaunch=$Relaunch)"
    $asar = Join-Path $AppDir 'resources\app.asar'
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)

    # 1) 等主进程退出
    if ($ParentPid -gt 0) {
        try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction SilentlyContinue } catch { }
    }

    # 2) 等安装器写完：Antigravity 不在运行、app.asar 可独占打开、且大小/时间连续 6 秒不变
    $lastSig = $null
    $stableSince = $null
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (-not (Test-Path -LiteralPath $asar)) { $stableSince = $null; continue }
        if (@(Get-AppProcesses $AppDir).Count -gt 0) { $stableSince = $null; continue }
        $item = Get-Item -LiteralPath $asar
        $sig = '{0}|{1}' -f $item.Length, $item.LastWriteTimeUtc.Ticks
        if ($sig -ne $lastSig) { $lastSig = $sig; $stableSince = Get-Date; continue }
        if (((Get-Date) - $stableSince).TotalSeconds -lt 6) { continue }
        try { $h = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None'); $h.Dispose() } catch { continue }
        $ready = $true
        break
    }
    if (-not $ready) { & $log 'timeout waiting for installer' }

    # 3) 新版本 → 重新打补丁（同版本补丁仍在时 cli 会直接返回 already）
    if ($ready) {
        $hash = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -eq $OldHash.ToLowerInvariant()) {
            & $log 'app.asar unchanged (update cancelled or failed)'
        } else {
            $locale = 'zh-CN'
            $settings = Join-Path $DataDir 'settings.json'
            if (Test-Path -LiteralPath $settings) {
                try { $locale = (Get-Content -LiteralPath $settings -Raw -Encoding UTF8 | ConvertFrom-Json).locale } catch { }
            }
            $r = Invoke-AgyCli $DataDir $AppDir @('apply', '--locale', $locale)
            & $log ("repatch: ok={0} status={1} {2}" -f (Get-Prop $r 'ok'), (Get-Prop $r 'status'), (Get-Prop $r 'message'))
        }
    }
} catch {
    & $log "error: $($_.Exception.Message)"
} finally {
    # 4) 无论补丁成功与否，原本要重启就一定重启（最坏情况只是本次显示英文）
    if ($Relaunch -eq '1') {
        try {
            $exe = Get-AntigravityExe $AppDir
            if ($exe) { Start-Process -FilePath $exe; & $log 'relaunched' }
        } catch { & $log "relaunch failed: $($_.Exception.Message)" }
    }
}
