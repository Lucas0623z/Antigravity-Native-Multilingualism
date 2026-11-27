# agy-i18n 公共函数（Windows PowerShell 5.1 / PowerShell 7 均可）
# 注意：本文件必须保存为 UTF-8 with BOM，否则中文 Windows 的 PowerShell 5.1 会按 GBK 读取导致乱码。

Set-StrictMode -Version 2.0
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:AgyDataDir = Join-Path $env:LOCALAPPDATA 'agy-i18n'

function Write-Info([string]$Text) { Write-Host $Text }
function Write-Ok([string]$Text) { Write-Host $Text -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host $Text -ForegroundColor Yellow }
function Write-Err2([string]$Text) { Write-Host $Text -ForegroundColor Red }

function Test-AntigravityDir([string]$Dir) {
    if (-not $Dir) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Dir 'resources\app.asar') -PathType Leaf)
}

# 查找 Antigravity 桌面端安装目录：参数 → 默认路径 → 注册表卸载信息
function Find-AntigravityDir([string]$Override) {
    if ($Override) {
        if (Test-AntigravityDir $Override) { return (Resolve-Path -LiteralPath $Override).Path }
        throw "指定的目录不是 Antigravity 桌面端安装目录（缺少 resources\app.asar）：$Override"
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\antigravity')) }
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($r in $roots) {
        try {
            Get-ItemProperty -Path $r -ErrorAction SilentlyContinue |
                Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like '*Antigravity*' -and $_.PSObject.Properties['InstallLocation'] -and $_.InstallLocation } |
                ForEach-Object { $candidates.Add($_.InstallLocation.Trim('"')) }
        } catch { }
    }
    foreach ($c in $candidates) {
        # Antigravity IDE（VS Code 分支）用的是 resources\app 目录，不是 app.asar，会被自然排除
        if (Test-AntigravityDir $c) { return (Resolve-Path -LiteralPath $c).Path }
    }
    throw '没有找到 Antigravity 桌面端。若安装在其它位置，请用 -AppDir "安装目录" 指定。'
}

function Get-AntigravityExe([string]$AppDir) {
    $exe = Join-Path $AppDir 'Antigravity.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
    $found = Get-ChildItem -LiteralPath $AppDir -Filter '*.exe' -File |
        Where-Object { $_.Name -notmatch '^(uninstall|elevate)' } | Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}

# 正在运行的、来自该安装目录的进程
function Get-AppProcesses([string]$AppDir) {
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $prefix = $AppDir.TrimEnd('\', '/') + $sep
    @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
}

# 等用户自己退出 Antigravity——绝不强制结束进程
function Wait-AppClosed([string]$AppDir, [switch]$NonInteractive) {
    while (@(Get-AppProcesses $AppDir).Count -gt 0) {
        if ($NonInteractive) { return $false }
        Write-Warn2 'Antigravity 正在运行。请先完全退出它（包括右下角托盘图标），然后按回车继续；输入 q 取消。'
        $answer = Read-Host
        if ($answer -eq 'q') { return $false }
    }
    return $true
}

# 读取 Electron fuse：RunAsNode 是否可用（$true / $false / $null=无 fuse 区块）
function Get-RunAsNodeFuse([string]$Exe) {
    $sentinel = [System.Text.Encoding]::ASCII.GetBytes('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
    $fs = [System.IO.File]::Open($Exe, 'Open', 'Read', 'ReadWrite')
    try {
        $chunk = 16MB
        $buf = New-Object byte[] ($chunk + 64)
        $carry = 0
        $enc = [System.Text.Encoding]::GetEncoding(28591)  # Latin-1：字节与字符一一对应
        $needle = $enc.GetString($sentinel)
        while ($true) {
            $n = $fs.Read($buf, $carry, $chunk)
            if ($n -le 0) { return $null }
            $len = $carry + $n
            $text = $enc.GetString($buf, 0, $len)
            $idx = $text.IndexOf($needle, [System.StringComparison]::Ordinal)
            if ($idx -ge 0 -and ($idx + $sentinel.Length + 2) -lt $len) {
                $at = $idx + $sentinel.Length
                $first = [char]$buf[$at + 2]   # [版本][数量][fuse0=RunAsNode]...
                if ($first -eq '1') { return $true }
                if ($first -eq '0') { return $false }
                return $null
            }
            $carry = [Math]::Min(64, $len)
            [Array]::Copy($buf, $len - $carry, $buf, 0, $carry)
        }
    } finally { $fs.Dispose() }
}

# 选择运行 cli.js 的 JavaScript 运行时：优先用 Antigravity 自带的 Electron（无需安装 Node.js）
function Get-JsRuntime([string]$AppDir) {
    $exe = Get-AntigravityExe $AppDir
    if ($exe) {
        $fuse = $null
        try { $fuse = Get-RunAsNodeFuse $exe } catch { $fuse = $null }
        if ($fuse -ne $false) { return @{ Path = $exe; RunAsNode = $true } }
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { return @{ Path = $node.Source; RunAsNode = $false } }
    throw '此版本 Antigravity 禁止以 Node 模式运行，且系统中未找到 Node.js。请安装 Node.js 18+ 后重试。'
}

function Quote-Arg([string]$a) {
    if ($a -match '[\s"]') { return '"' + ($a -replace '"', '\"') + '"' }
    return $a
}

# 运行 cli.js，返回解析后的 JSON 结果
function Invoke-AgyCli([string]$DataDir, [string]$AppDir, [string[]]$CliArgs) {
    $rt = Get-JsRuntime $AppDir
    $cli = Join-Path $DataDir 'cli.js'
    $allArgs = @($cli) + $CliArgs + @('--app-dir', $AppDir, '--data-dir', $DataDir, '--json')
    $argLine = ($allArgs | ForEach-Object { Quote-Arg $_ }) -join ' '
    $out = [System.IO.Path]::GetTempFileName()
    $err = [System.IO.Path]::GetTempFileName()
    $prev = $env:ELECTRON_RUN_AS_NODE
    try {
        if ($rt.RunAsNode) { $env:ELECTRON_RUN_AS_NODE = '1' }
        $p = Start-Process -FilePath $rt.Path -ArgumentList $argLine -Wait -NoNewWindow -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err
        $text = (Get-Content -LiteralPath $out -Raw -Encoding UTF8)
        $line = $null
        if ($text) { $line = ($text -split "`r?`n" | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1) }
        if (-not $line) {
            $e = Get-Content -LiteralPath $err -Raw -Encoding UTF8
            throw "补丁程序没有返回结果（退出码 $($p.ExitCode)）：$e"
        }
        return ($line | ConvertFrom-Json)
    } finally {
        if ($null -eq $prev) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $prev }
        Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue
    }
}

# 安全读取 JSON 结果中可能不存在的字段（StrictMode 下直接访问会抛异常）
function Get-Prop($Obj, [string]$Name) {
    if ($null -ne $Obj -and $Obj.PSObject.Properties[$Name]) { return $Obj.$Name }
    return $null
}

function Write-AgyLog([string]$DataDir, [string]$Name, [string]$Text) {
    try {
        $dir = Join-Path $DataDir 'logs'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
        Add-Content -LiteralPath (Join-Path $dir $Name) -Value $line -Encoding UTF8
    } catch { }
}
