# 安装 / 更新 Antigravity 原生语言包
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-AppDir <目录>] [-Locale zh-CN|zh-TW|en|system] [-NonInteractive]
[CmdletBinding()]
param(
    [string]$AppDir,
    [ValidatePattern('^(system|en|zh-CN|zh-TW)$')]
    [string]$Locale = 'zh-CN',
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$PackageRoot = Split-Path -Parent $PSScriptRoot
$DataDir = $script:AgyDataDir

try {
    Write-Info '== Antigravity 原生语言包 安装 =='
    $AppDir = Find-AntigravityDir $AppDir
    Write-Info "Antigravity 安装目录：$AppDir"

    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot 'dist\payload\boot.js'))) {
        throw '安装包不完整：缺少 dist\payload（请使用发布的 zip，或先运行 npm run build）。'
    }

    # 1) 把语言包复制到 %LOCALAPPDATA%\agy-i18n（更新衔接脚本需要它；备份与日志也在这里）
    $samePlace = [string]::Equals((Resolve-Path -LiteralPath $PackageRoot).Path.TrimEnd('\'), $DataDir.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $samePlace) {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        foreach ($d in @('src', 'dist', 'locales', 'scripts')) {
            $target = Join-Path $DataDir $d
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
            Copy-Item -LiteralPath (Join-Path $PackageRoot $d) -Destination $target -Recurse -Force
        }
        foreach ($f in @('cli.js', 'package.json', 'README.md', 'LICENSE')) {
            $p = Join-Path $PackageRoot $f
            if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $DataDir $f) -Force }
        }
        foreach ($f in @('安装.cmd', '卸载.cmd')) {
            $p = Join-Path $PackageRoot $f
            if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $DataDir $f) -Force }
        }
    }
    @{ locale = $Locale; appDir = $AppDir } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataDir 'settings.json') -Encoding UTF8

    # 2) 需要 Antigravity 处于关闭状态（不会强制结束它）
    if (-not (Wait-AppClosed $AppDir -NonInteractive:$NonInteractive)) {
        Write-Warn2 '已取消：Antigravity 仍在运行，没有做任何修改。'
        exit 3
    }

    # 3) 打补丁
    $r = Invoke-AgyCli $DataDir $AppDir @('apply', '--locale', $Locale)
    if (-not $r.ok) { throw $r.message }
    if ($r.status -eq 'already') { Write-Ok "已经是最新版本（v$($r.version)），无需改动。" }
    else { Write-Ok "安装完成（v$($r.version)）。" }
    Write-Info ''
    Write-Info '打开 Antigravity → 设置 → 外观 → 显示语言，即可随时切换语言（立即生效，无需重启）。'
    Write-Info "卸载：运行 $DataDir\卸载.cmd，会逐字节还原原版文件。"
    Write-AgyLog $DataDir 'install.log' "installed v$($r.version) locale=$Locale app=$AppDir"

    if (-not $NonInteractive) {
        $ans = Read-Host '现在启动 Antigravity 吗？[Y/n]'
        if ($ans -ne 'n' -and $ans -ne 'N') {
            $exe = Get-AntigravityExe $AppDir
            if ($exe) { Start-Process -FilePath $exe }
        }
    }
    exit 0
} catch {
    Write-Err2 "安装失败：$($_.Exception.Message)"
    Write-Info '没有对 Antigravity 做任何不可恢复的修改。'
    exit 1
}
