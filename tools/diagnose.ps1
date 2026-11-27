# Antigravity 只读诊断：核对语言包所需的关键信息。
# 不修改任何文件、不联网、不影响正在运行的 Antigravity。结果保存到桌面 agy-diagnose.txt。
#   右键 → 使用 PowerShell 运行；或：powershell -ExecutionPolicy Bypass -File diagnose.ps1 [-AppDir <目录>]
param([string]$AppDir)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$out = New-Object System.Collections.Generic.List[string]
function W([string]$s) { $out.Add($s); Write-Host $s }
$latin1 = [System.Text.Encoding]::GetEncoding(28591)

# ---------- 找安装目录 ----------
$cands = @()
if ($AppDir) { $cands += $AppDir }
if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\antigravity'); $cands += (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity') }
foreach ($r in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*') {
    Get-ItemProperty $r -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like '*Antigravity*' } | ForEach-Object {
        W ("[注册表] {0} | {1} | {2}" -f $_.DisplayName, $(if ($_.PSObject.Properties['DisplayVersion']) { $_.DisplayVersion }), $(if ($_.PSObject.Properties['InstallLocation']) { $_.InstallLocation }))
        if ($_.PSObject.Properties['InstallLocation'] -and $_.InstallLocation) { $cands += $_.InstallLocation.Trim('"') }
    }
}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*ntigravity*' } | Select-Object -First 1 | ForEach-Object {
    try { $cands += (Split-Path $_.Path -Parent); W "[运行中] $($_.Path)" } catch { }
}
$App = $null
foreach ($c in $cands) { if ($c -and (Test-Path (Join-Path $c 'resources'))) { $App = (Resolve-Path $c).Path; break } }
if (-not $App) { W '没有找到 Antigravity 安装目录，请用 -AppDir 指定。'; return }
W "== 安装目录: $App"
$res = Join-Path $App 'resources'
W ("resources 内容: " + ((Get-ChildItem $res | ForEach-Object { if ($_.PSIsContainer) { $_.Name + '\' } else { '{0} ({1:N0} KB)' -f $_.Name, ($_.Length / 1KB) } }) -join ', '))
$exe = Get-ChildItem $App -Filter '*.exe' | Where-Object { $_.Name -notmatch '^(uninstall|elevate)' } | Select-Object -First 1
if ($exe) { W ("主程序: {0}  文件版本 {1}  产品版本 {2}" -f $exe.Name, $exe.VersionInfo.FileVersion, $exe.VersionInfo.ProductVersion) }

# ---------- 扫描大文件（流式） ----------
function Find-InFile([string]$Path, [string[]]$Needles, [int]$Context = 160, [int]$MaxHits = 3) {
    $hits = @{}; foreach ($n in $Needles) { $hits[$n] = New-Object System.Collections.Generic.List[string] }
    $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        $chunk = 32MB; $ov = 4096
        $buf = New-Object byte[] ($chunk + $ov); $carry = 0
        while ($true) {
            $n = $fs.Read($buf, $carry, $chunk); if ($n -le 0) { break }
            $len = $carry + $n; $text = $latin1.GetString($buf, 0, $len)
            foreach ($nd in $Needles) {
                if ($hits[$nd].Count -ge $MaxHits) { continue }
                $i = 0
                while ($hits[$nd].Count -lt $MaxHits) {
                    $i = $text.IndexOf($nd, $i, [System.StringComparison]::Ordinal); if ($i -lt 0) { break }
                    $s = [Math]::Max(0, $i - $Context); $e = [Math]::Min($len, $i + $nd.Length + $Context)
                    $snip = ($text.Substring($s, $e - $s) -replace '[^\x20-\x7E]', '.')
                    if (-not $hits[$nd].Contains($snip)) { $hits[$nd].Add($snip) }
                    $i += $nd.Length
                }
            }
            $carry = [Math]::Min($ov, $len); [Array]::Copy($buf, $len - $carry, $buf, 0, $carry)
        }
    } finally { $fs.Dispose() }
    return $hits
}

# ---------- Fuses 与 Electron 版本 ----------
if ($exe) {
    $h = Find-InFile $exe.FullName @('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'Electron/') 40 2
    $f = $h['dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX']
    if ($f.Count) {
        $s = $f[0]; $k = $s.IndexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX') + 32
        $fuseChars = $s.Substring($k + 2, [Math]::Min(12, $s.Length - $k - 2))
        $names = 'RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges', 'WasmTrapHandlers'
        W '== Electron Fuses（1=开 0=关 r=移除）'
        for ($i = 0; $i -lt $names.Count -and $i -lt $fuseChars.Length; $i++) { W ("  {0} = {1}" -f $names[$i], $fuseChars[$i]) }
    } else { W '== 未找到 Fuse 区块' }
    foreach ($snip in $h['Electron/']) { if ($snip -match 'Electron/(\d+\.\d+\.\d+)') { W "== Electron 版本: $($Matches[1])"; break } }
}

# ---------- app.asar ----------
$asar = Join-Path $res 'app.asar'
if (Test-Path $asar) {
    $fs = [System.IO.File]::OpenRead($asar)
    try {
        $b = New-Object byte[] 16; [void]$fs.Read($b, 0, 16)
        $hsize = [BitConverter]::ToUInt32($b, 4); $slen = [BitConverter]::ToUInt32($b, 12)
        $hb = New-Object byte[] $slen; $fs.Position = 16; [void]$fs.Read($hb, 0, $slen)
        $json = [System.Text.Encoding]::UTF8.GetString($hb); $dataOff = 8 + $hsize
        $header = $json | ConvertFrom-Json
        function Get-Entry($node, [string]$p) { foreach ($part in $p.Split('/')) { if (-not $node.files -or -not $node.files.PSObject.Properties[$part]) { return $null }; $node = $node.files.$part }; return $node }
        function Read-Entry([string]$p) {
            $e = Get-Entry $header $p; if (-not $e -or $e.PSObject.Properties['files']) { return $null }
            if ($e.PSObject.Properties['unpacked'] -and $e.unpacked) { return '(unpacked)' }
            $buf = New-Object byte[] ([int]$e.size); $fs.Position = $dataOff + [long]$e.offset; [void]$fs.Read($buf, 0, $buf.Length)
            return [System.Text.Encoding]::UTF8.GetString($buf)
        }
        W "== app.asar：头部 $slen 字节，含 integrity 字段：$($json.Contains('""integrity""'))"
        W ("  已安装 agy-i18n 补丁：" + [bool](Get-Entry $header 'agy-i18n/marker.json'))
        $pkg = Read-Entry 'package.json'
        if ($pkg) { $p = $pkg | ConvertFrom-Json; W ("  package.json: name={0} version={1} main={2} type={3}" -f $p.name, $p.version, $p.main, $(if ($p.PSObject.Properties['type']) { $p.type } else { '-' })) }
        W ("  顶层: " + (($header.files.PSObject.Properties.Name) -join ', '))
        if ($header.files.PSObject.Properties['dist']) { W ("  dist/: " + (($header.files.dist.files.PSObject.Properties.Name | Select-Object -First 60) -join ', ')) }
        $nm = Get-Entry $header 'node_modules'
        if ($nm) { W ("  node_modules: " + (($nm.files.PSObject.Properties.Name | Select-Object -First 80) -join ', ')) }
        $up = Read-Entry 'node_modules/electron-updater/package.json'
        if ($up -and $up -ne '(unpacked)') { W ("  electron-updater 版本: " + ($up | ConvertFrom-Json).version) }

        # 主进程关键代码片段
        $mainPath = if ($p -and $p.main) { $p.main -replace '^\./', '' } else { 'dist/main.js' }
        $files = @($mainPath) + @($header.files.dist.files.PSObject.Properties.Name | Where-Object { $_ -like '*.js' } | ForEach-Object { "dist/$_" }) | Select-Object -Unique
        $pat = 'new\s+(?:electron_\d+\.)?(BrowserWindow|BaseWindow|WebContentsView|BrowserView)\b|webPreferences|sandbox\s*:|contextIsolation\s*:|nodeIntegration\s*:|preload\s*:|loadURL\(|registerPreloadScript|setPreloads|fromPartition|webviewTag|setApplicationMenu|Tray\(|autoUpdater|quitAndInstall|electron-updater|protocol\.(handle|register)|userData|setPath\('
        W '== 主进程关键代码（每个文件最多 15 处）'
        foreach ($f in $files) {
            $src = Read-Entry $f; if (-not $src -or $src -eq '(unpacked)') { continue }
            $ms = [regex]::Matches($src, $pat); if ($ms.Count -eq 0) { continue }
            W "  -- $f ($($src.Length) 字符，命中 $($ms.Count))"
            $shown = 0; $last = -1000
            foreach ($m in $ms) {
                if ($m.Index - $last -lt 120) { continue }
                $s = [Math]::Max(0, $m.Index - 80); $e = [Math]::Min($src.Length, $m.Index + 160)
                W ('     ' + ($src.Substring($s, $e - $s) -replace '\s+', ' '))
                $last = $m.Index; $shown++; if ($shown -ge 15) { break }
            }
        }
    } finally { $fs.Dispose() }
} else { W '== 没有 resources\app.asar（可能是 IDE 版本）' }

# ---------- 界面代码：设置页结构 ----------
$ui = @(Get-ChildItem $res -Recurse -File -ErrorAction SilentlyContinue | Where-Object { ($_.Name -like 'language_server*') -or ($_.Extension -eq '.js' -and $_.Length -gt 500KB) } | Sort-Object Length -Descending | Select-Object -First 3)
foreach ($u in $ui) {
    W "== 扫描界面代码: $($u.FullName) ($([Math]::Round($u.Length / 1MB)) MB)，请稍候…"
    $needles = @('"Appearance"', '"Theme"', 'agy-card', 'agy-select-trigger', 'role:"combobox"', 'data-radix-popper', '"Display Language"', 'data-testid":"user-message-content', 'prose ')
    $hits = Find-InFile $u.FullName $needles 140 2
    foreach ($n in $needles) {
        W "  [$n] 命中 $($hits[$n].Count)"
        foreach ($s in $hits[$n]) { W ('     ' + $s) }
    }
}

$file = Join-Path ([Environment]::GetFolderPath('Desktop')) 'agy-diagnose.txt'
$out | Set-Content -LiteralPath $file -Encoding UTF8
Write-Host ''
Write-Host "已保存到 $file ，请把这个文件发给我。" -ForegroundColor Green
