#!/usr/bin/env bash
# 用 PowerShell 7 在 Linux 上跑一遍安装 / 重装 / 运行中拒绝 / 更新衔接 / 卸载 全流程。
# 用法：PWSH=/path/to/pwsh bash test/e2e/ps-test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PWSH="${PWSH:-pwsh}"
W="$(mktemp -d)"
export LOCALAPPDATA="$W/LocalAppData"
APP="$LOCALAPPDATA/Programs/antigravity"
mkdir -p "$APP/resources"
pass=0; fail=0
ok() { echo "✔ $1"; pass=$((pass+1)); }
bad() { echo "✘ $1"; fail=$((fail+1)); }
sha() { sha256sum "$1" | cut -d' ' -f1; }

make_asar() { # $1 = version
  local s="$W/src-$1"; mkdir -p "$s/dist"
  echo "{\"name\":\"antigravity\",\"version\":\"$1\",\"main\":\"dist/main.js\"}" > "$s/package.json"
  printf '"use strict";\nconsole.log("app %s");\n' "$1" > "$s/dist/main.js"
  node -e "require('$ROOT/node_modules/@electron/asar').createPackage('$s','$APP/resources/app.asar').then(()=>{})"
}

# 假 Antigravity.exe：ELECTRON_RUN_AS_NODE=1 时当 node 用；否则记录"被启动"。内含真实格式的 fuse 区块（RunAsNode=1）
cat > "$APP/Antigravity.exe" <<EOF
#!/usr/bin/env bash
# fuse: $(printf 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\x01\x09100r00001')
if [ "\${ELECTRON_RUN_AS_NODE:-}" = "1" ]; then exec node "\$@"; fi
echo launched >> "$W/launched.txt"
EOF
chmod +x "$APP/Antigravity.exe"

make_asar 2.31.2
ORIG=$(sha "$APP/resources/app.asar")

# 1) 安装
"$PWSH" -NoProfile -File "${PKG:-$ROOT}/scripts/install.ps1" -NonInteractive -Locale zh-CN > "$W/i1.txt" 2>&1; c=$?
[ $c -eq 0 ] && grep -q '安装完成' "$W/i1.txt" && ok "install.ps1 安装成功" || { bad "install.ps1 安装 (exit $c)"; cat "$W/i1.txt"; }
[ -f "$LOCALAPPDATA/agy-i18n/cli.js" ] && [ -f "$LOCALAPPDATA/agy-i18n/dist/payload/preload.bundle.js" ] && ok "语言包已复制到 %LOCALAPPDATA%\\agy-i18n" || bad "数据目录缺文件"
[ "$(sha "$APP/resources/app.asar")" != "$ORIG" ] && ok "app.asar 已打补丁" || bad "app.asar 未变化"
node "$ROOT/cli.js" status --app-dir "$APP" --json | grep -q '"patched":true' && ok "status 显示已安装" || bad "status"

# 2) 重复安装：幂等
"$PWSH" -NoProfile -File "${PKG:-$ROOT}/scripts/install.ps1" -NonInteractive > "$W/i2.txt" 2>&1
grep -q '无需改动' "$W/i2.txt" && ok "重复安装幂等" || { bad "重复安装"; cat "$W/i2.txt"; }

# 3) Antigravity 运行中：拒绝修改，绝不结束进程
cp "$(command -v sleep)" "$APP/Antigravity-helper"; "$APP/Antigravity-helper" 30 & SP=$!
before=$(sha "$APP/resources/app.asar")
"$PWSH" -NoProfile -File "$LOCALAPPDATA/agy-i18n/scripts/uninstall.ps1" -NonInteractive > "$W/u0.txt" 2>&1; c=$?
[ $c -eq 3 ] && [ "$(sha "$APP/resources/app.asar")" = "$before" ] && kill -0 $SP 2>/dev/null && ok "Antigravity 运行中：拒绝修改且未结束其进程" || { bad "运行中处理 (exit $c)"; cat "$W/u0.txt"; }
kill $SP 2>/dev/null; wait $SP 2>/dev/null; rm -f "$APP/Antigravity-helper"

# 4) 模拟自动更新：安装器换上新版 app.asar 后，衔接脚本重新打补丁并重启
PATCHED=$(sha "$APP/resources/app.asar")
make_asar 2.32.0
NEWORIG=$(sha "$APP/resources/app.asar")
"$PWSH" -NoProfile -File "$LOCALAPPDATA/agy-i18n/scripts/repatch-after-update.ps1" -AppDir "$APP" -DataDir "$LOCALAPPDATA/agy-i18n" -OldHash "$PATCHED" -ParentPid 0 -Relaunch 1 -TimeoutMinutes 1 > "$W/r.txt" 2>&1
node "$ROOT/cli.js" status --app-dir "$APP" --json > "$W/s.json"
grep -q '"patched":true' "$W/s.json" && grep -q '"appVersion":"2.32.0"' "$W/s.json" && ok "更新后自动重新打补丁（新版本 2.32.0）" || { bad "更新衔接"; cat "$W/r.txt" "$W/s.json"; cat "$LOCALAPPDATA/agy-i18n/logs/update.log" 2>/dev/null; }
[ -f "$W/launched.txt" ] && ok "更新完成后重新启动了 Antigravity" || bad "未重启"
grep -q 'repatch: ok=True' "$LOCALAPPDATA/agy-i18n/logs/update.log" && ok "update.log 记录了衔接过程" || { bad "update.log"; cat "$LOCALAPPDATA/agy-i18n/logs/update.log"; }

# 5) 卸载：逐字节还原（新版本的原版）并删除数据目录
"$PWSH" -NoProfile -File "$LOCALAPPDATA/agy-i18n/scripts/uninstall.ps1" -NonInteractive > "$W/u1.txt" 2>&1; c=$?
[ $c -eq 0 ] && [ "$(sha "$APP/resources/app.asar")" = "$NEWORIG" ] && ok "uninstall.ps1 逐字节还原原版" || { bad "卸载 (exit $c)"; cat "$W/u1.txt"; }
[ ! -d "$LOCALAPPDATA/agy-i18n" ] && ok "已删除数据目录" || bad "数据目录仍在"

echo; echo "$pass 通过, $fail 失败"
rm -rf "$W"
[ $fail -eq 0 ]
