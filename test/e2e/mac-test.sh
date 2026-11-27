#!/usr/bin/env bash
# macOS 脚本全流程测试（可在 Linux 上用 bash 运行；模拟 Antigravity.app 目录结构）
# 用法：bash test/e2e/mac-test.sh   （可设 PKG=解压后的发布包目录）
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG="${PKG:-$ROOT}"
W="$(mktemp -d)"
export HOME="$W/home"; mkdir -p "$HOME"
export AGY_DATA_DIR="$HOME/Library/Application Support/agy-i18n"
APP="$W/Applications/Antigravity.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks/Electron Framework.framework"
pass=0; fail=0
ok() { echo "✔ $1"; pass=$((pass+1)); }
bad() { echo "✘ $1"; fail=$((fail+1)); }
sha() { sha256sum "$1" | cut -d' ' -f1; }
make_asar() {
  local s="$W/src-$1"; mkdir -p "$s/dist"
  echo "{\"name\":\"antigravity\",\"version\":\"$1\",\"main\":\"dist/main.js\"}" > "$s/package.json"
  printf '"use strict";\nconsole.log("app %s");\n' "$1" > "$s/dist/main.js"
  node -e "require('$ROOT/node_modules/@electron/asar').createPackage('$s','$APP/Contents/Resources/app.asar')"
}
cat > "$APP/Contents/MacOS/Antigravity" <<EOF
#!/usr/bin/env bash
if [ "\${ELECTRON_RUN_AS_NODE:-}" = "1" ]; then exec node "\$@"; fi
echo launched >> "$W/launched.txt"
EOF
chmod +x "$APP/Contents/MacOS/Antigravity"
printf 'framework... dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\x01\x09100r00001 ...' > "$APP/Contents/Frameworks/Electron Framework.framework/Electron Framework"
make_asar 2.35.2
ORIG=$(sha "$APP/Contents/Resources/app.asar")

bash "$PKG/scripts/macos/install.sh" --app "$APP" --non-interactive > "$W/i1.txt" 2>&1; c=$?
[ $c -eq 0 ] && grep -q '安装完成' "$W/i1.txt" && ok "install.sh 安装成功" || { bad "install.sh (exit $c)"; cat "$W/i1.txt"; }
[ -f "$AGY_DATA_DIR/cli.js" ] && [ -x "$AGY_DATA_DIR/scripts/macos/repatch-after-update.sh" ] && ok "语言包已复制到 ~/Library/Application Support/agy-i18n" || bad "数据目录"
[ "$(sha "$APP/Contents/Resources/app.asar")" != "$ORIG" ] && ok "app.asar 已打补丁" || bad "未打补丁"
S=$(node "$ROOT/cli.js" status --app-dir "$APP" --json)
echo "$S" | grep -q '"patched":true' && echo "$S" | grep -q '"RunAsNode":true' && ok "status：已安装，并从 Electron Framework 读到 Fuse" || { bad "status"; echo "$S"; }
node "$ROOT/cli.js" status --app-dir "$APP" --json | grep -q '"platform":"darwin"' && ok "install.json 记录 platform=darwin" || bad "platform 记录"
[ ! -e "$APP/Contents/_CodeSignature.tmp" ] && ! ls "$APP/Contents/Resources/" | grep -q 'agy-i18n.tmp' && ok "没有残留临时文件" || bad "残留临时文件"

bash "$PKG/scripts/macos/install.sh" --app "$APP" --non-interactive > "$W/i2.txt" 2>&1
grep -q '无需改动' "$W/i2.txt" && ok "重复安装幂等" || { bad "重复安装"; cat "$W/i2.txt"; }

cp "$(command -v node)" "$APP/Contents/MacOS/helper"; "$APP/Contents/MacOS/helper" -e "setTimeout(()=>{},30000)" & SP=$!; sleep 1
before=$(sha "$APP/Contents/Resources/app.asar")
bash "$AGY_DATA_DIR/scripts/macos/uninstall.sh" --app "$APP" --non-interactive > "$W/u0.txt" 2>&1; c=$?
[ $c -eq 3 ] && [ "$(sha "$APP/Contents/Resources/app.asar")" = "$before" ] && kill -0 $SP 2>/dev/null && ok "Antigravity 运行中：拒绝修改且未结束其进程" || { bad "运行中处理 (exit $c)"; cat "$W/u0.txt"; }
kill $SP 2>/dev/null; wait $SP 2>/dev/null; rm -f "$APP/Contents/MacOS/helper"

PATCHED=$(sha "$APP/Contents/Resources/app.asar")
make_asar 2.36.0
NEWORIG=$(sha "$APP/Contents/Resources/app.asar")
bash "$AGY_DATA_DIR/scripts/macos/repatch-after-update.sh" --app "$APP" --data-dir "$AGY_DATA_DIR" --old-hash "$PATCHED" --parent-pid 0 --timeout-min 1 > "$W/r.txt" 2>&1
S=$(node "$ROOT/cli.js" status --app-dir "$APP" --json)
echo "$S" | grep -q '"patched":true' && echo "$S" | grep -q '"appVersion":"2.36.0"' && ok "Squirrel 更新后自动重新打补丁（2.36.0）" || { bad "更新衔接"; cat "$W/r.txt"; echo "$S"; cat "$AGY_DATA_DIR/logs/update.log"; }
grep -q 'repatch: ok=true status=patched' "$AGY_DATA_DIR/logs/update.log" && ok "update.log 记录了衔接过程" || { bad "update.log"; cat "$AGY_DATA_DIR/logs/update.log"; }
[ ! -f "$W/launched.txt" ] && ok "macOS 上衔接脚本不自行启动应用（由 ShipIt 负责）" || bad "不应自行启动"

bash "$AGY_DATA_DIR/scripts/macos/uninstall.sh" --app "$APP" --non-interactive > "$W/u1.txt" 2>&1; c=$?
[ $c -eq 0 ] && [ "$(sha "$APP/Contents/Resources/app.asar")" = "$NEWORIG" ] && ok "uninstall.sh 逐字节还原原版（签名随之恢复有效）" || { bad "卸载 (exit $c)"; cat "$W/u1.txt"; }
[ ! -d "$AGY_DATA_DIR" ] && ok "已删除数据目录" || bad "数据目录仍在"

echo; echo "$pass 通过, $fail 失败"
rm -rf "$W"
[ $fail -eq 0 ]
