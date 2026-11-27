# 卸载语言包：逐字节还原原版 app.asar 并删除 %LOCALAPPDATA%\agy-i18n
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-AppDir <目录>] [-KeepFiles] [-NonInteractive]
[CmdletBinding()]
param(
    [string]$AppDir,
    [switch]$KeepFiles,
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$PackageRoot = Split-Path -Parent $PSScriptRoot
$DataDir = $script:AgyDataDir
if (-not (Test-Path -LiteralPath (Join-Path $DataDir 'cli.js'))) { $DataDir = $PackageRoot }

try {
    Write-Info '== Antigravity 原生语言包 卸载 =='
    if (-not $AppDir) {
        $settings = Join-Path $DataDir 'settings.json'
        if (Test-Path -LiteralPath $settings) {
            try { $AppDir = (Get-Content -LiteralPath $settings -Raw -Encoding UTF8 | ConvertFrom-Json).appDir } catch { }
        }
    }
    $AppDir = Find-AntigravityDir $AppDir
    Write-Info "Antigravity 安装目录：$AppDir"

    if (-not (Wait-AppClosed $AppDir -NonInteractive:$NonInteractive)) {
        Write-Warn2 '已取消：Antigravity 仍在运行，没有做任何修改。'
        exit 3
    }

    $r = Invoke-AgyCli $DataDir $AppDir @('remove')
    if (-not $r.ok) { throw $r.message }
    if ($r.status -eq 'not-patched') { Write-Ok '当前就是原版，无需还原。' }
    elseif ($r.method -eq 'rebuild') { Write-Ok '已还原原版 app.asar（逐字节重建，SHA-256 校验一致）。' }
    else { Write-Ok '已从备份还原原版 app.asar（SHA-256 校验一致）。' }

    if (-not $KeepFiles -and (Test-Path -LiteralPath $script:AgyDataDir)) {
        Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
        Remove-Item -LiteralPath $script:AgyDataDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "已删除 $($script:AgyDataDir)"
    }
    Write-Info '说明：Antigravity 用户数据目录中的 agy-i18n.json（你的语言选择）是几十字节的配置文件，原版不会读取它，可自行删除。'
    exit 0
} catch {
    Write-Err2 "卸载失败：$($_.Exception.Message)"
    Write-Info '兜底办法：从官网重新安装 Antigravity 覆盖，即可恢复原版。'
    exit 1
}
