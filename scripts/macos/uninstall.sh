#!/usr/bin/env bash
# 卸载语言包（macOS）：逐字节还原原版 app.asar（Google 签名随之完全恢复有效）并删除数据目录
#   bash uninstall.sh [--app /Applications/Antigravity.app] [--keep-files] [--non-interactive]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
. "$HERE/common.sh"

APP_ARG=""; KEEP=0; NONINT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_ARG="$2"; shift 2 ;;
    --keep-files) KEEP=1; shift ;;
    --non-interactive) NONINT=1; shift ;;
    *) err "未知参数：$1"; exit 2 ;;
  esac
done
DATA="$AGY_DATA_DIR"; [ -f "$DATA/cli.js" ] || DATA="$PKG"

info '== Antigravity 原生语言包 卸载（macOS）=='
if [ -z "$APP_ARG" ] && [ -f "$DATA/settings.json" ]; then
  APP_ARG="$(sed -nE 's/.*"appDir":"([^"]*)".*/\1/p' "$DATA/settings.json")"
  is_app "$APP_ARG" || APP_ARG=""
fi
APP="$(find_app "$APP_ARG")" || exit 1
info "Antigravity：$APP"

if ! wait_app_closed "$APP" "$NONINT"; then warn '已取消：Antigravity 仍在运行，没有做任何修改。'; exit 3; fi

R="$(run_cli "$DATA" "$APP" remove)"
if [ "$(json_get "$R" ok)" != "true" ]; then
  err "卸载失败：$(json_get "$R" message)"
  info '兜底办法：从官网重新下载 Antigravity 覆盖到"应用程序"，即可恢复原版。'
  exit 1
fi
case "$(json_get "$R" status)" in
  not-patched) ok '当前就是原版，无需还原。' ;;
  *) ok '已还原原版 app.asar（SHA-256 校验一致，应用签名恢复完全有效）。' ;;
esac

if [ "$KEEP" != "1" ] && [ -d "$AGY_DATA_DIR" ]; then
  cd / && rm -rf "${AGY_DATA_DIR:?}" && ok "已删除 $AGY_DATA_DIR"
fi
info '说明：Antigravity 用户数据目录中的 agy-i18n.json（你的语言选择）只有几十字节，原版不会读取它，可自行删除。'
exit 0
