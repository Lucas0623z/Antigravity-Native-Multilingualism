#!/usr/bin/env bash
# 安装 / 更新 Antigravity 原生语言包（macOS）
#   bash install.sh [--app /Applications/Antigravity.app] [--locale zh-CN|zh-TW|en|system] [--non-interactive]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
. "$HERE/common.sh"

APP_ARG=""; LOCALE="zh-CN"; NONINT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_ARG="$2"; shift 2 ;;
    --locale) LOCALE="$2"; shift 2 ;;
    --non-interactive) NONINT=1; shift ;;
    *) err "未知参数：$1"; exit 2 ;;
  esac
done
case "$LOCALE" in system|en|zh-CN|zh-TW) ;; *) err "无效的语言：$LOCALE"; exit 2 ;; esac

info '== Antigravity 原生语言包 安装（macOS）=='
APP="$(find_app "$APP_ARG")" || exit 1
info "Antigravity：$APP"
if [ ! -f "$PKG/dist/payload/boot.js" ]; then err '安装包不完整：缺少 dist/payload（请使用发布的 zip，或先运行 npm run build）。'; exit 1; fi

# 1) 复制语言包到 ~/Library/Application Support/agy-i18n（更新衔接需要它；备份与日志也在这里）
if [ "$PKG" != "$AGY_DATA_DIR" ]; then
  mkdir -p "$AGY_DATA_DIR"
  for d in src dist locales scripts; do rm -rf "${AGY_DATA_DIR:?}/$d"; cp -R "$PKG/$d" "$AGY_DATA_DIR/$d"; done
  for f in cli.js package.json README.md LICENSE 安装.command 卸载.command; do
    [ -f "$PKG/$f" ] && cp "$PKG/$f" "$AGY_DATA_DIR/$f"
  done
fi
chmod +x "$AGY_DATA_DIR"/scripts/macos/*.sh "$AGY_DATA_DIR"/*.command 2>/dev/null || true
printf '{"locale":"%s","appDir":"%s"}\n' "$LOCALE" "$APP" > "$AGY_DATA_DIR/settings.json"

# 2) 需要 Antigravity 处于退出状态（不会强制结束它）
if ! wait_app_closed "$APP" "$NONINT"; then warn '已取消：Antigravity 仍在运行，没有做任何修改。'; exit 3; fi

# 3) 打补丁（不重新签名：Google 的签名保持原样，卸载后逐字节恢复即重新完全有效）
R="$(run_cli "$AGY_DATA_DIR" "$APP" apply --locale "$LOCALE")"
if [ "$(json_get "$R" ok)" != "true" ]; then
  err "安装失败：$(json_get "$R" message)"
  info '没有对 Antigravity 做任何不可恢复的修改。'
  exit 1
fi
if [ "$(json_get "$R" status)" = "already" ]; then ok "已经是最新版本（v$(json_get "$R" version)），无需改动。"; else ok "安装完成（v$(json_get "$R" version)）。"; fi
log_to install.log "installed v$(json_get "$R" version) locale=$LOCALE app=$APP"
info ''
info '打开 Antigravity → 设置 → 外观 → 显示语言，即可随时切换语言（立即生效，无需重启）。'
info "卸载：双击 $AGY_DATA_DIR/卸载.command，会逐字节还原原版文件。"

if [ "$NONINT" != "1" ]; then
  printf '现在打开 Antigravity 吗？[Y/n] '; read -r a
  if [ "$a" != "n" ] && [ "$a" != "N" ]; then open "$APP" 2>/dev/null || true; fi
fi
exit 0
