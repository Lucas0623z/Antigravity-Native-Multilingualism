#!/usr/bin/env bash
# Antigravity（macOS）下载了更新并退出时，由语言包启动的一次性衔接脚本，完成即退出：
#   等 Squirrel/ShipIt 换上新版 Antigravity.app → 重新打补丁。
#   若 ShipIt 已自动重新打开 Antigravity：只发一条系统通知"重新打开后恢复中文"，绝不结束进程。
# 不注册 LaunchAgent，不重新签名。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"

APP=""; DATA="$AGY_DATA_DIR"; OLD="unknown"; PARENT=0; TIMEOUT_MIN=15
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --data-dir) DATA="$2"; AGY_DATA_DIR="$2"; shift 2 ;;
    --old-hash) OLD="$2"; shift 2 ;;
    --parent-pid) PARENT="$2"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="$2"; shift 2 ;;
    *) shift ;;
  esac
done
ASAR="$APP/Contents/Resources/app.asar"
log_to update.log "bridge start (parent=$PARENT)"

sig() { if [ "$(uname)" = "Darwin" ]; then stat -f '%z|%m' "$1" 2>/dev/null; else stat -c '%s|%Y' "$1" 2>/dev/null; fi; }

# 1) 等主进程退出（最多 2 分钟）
i=0; while [ "$PARENT" != "0" ] && kill -0 "$PARENT" 2>/dev/null && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done

# 2) 等新版落地：app.asar 内容变化且大小/时间连续 6 秒不变
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 )); last=""; since=0; ready=0; changed=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 2
  [ -f "$ASAR" ] || { since=0; continue; }
  s="$(sig "$ASAR")"
  if [ "$s" != "$last" ]; then last="$s"; since=$(date +%s); continue; fi
  [ $(( $(date +%s) - since )) -lt 6 ] && continue
  if [ "$(sha256 "$ASAR")" != "$OLD" ]; then changed=1; ready=1; break; fi
done

if [ "$ready" = "1" ] && [ "$changed" = "1" ]; then
  LOCALE="$(sed -nE 's/.*"locale":"([^"]*)".*/\1/p' "$DATA/settings.json" 2>/dev/null)"; [ -n "$LOCALE" ] || LOCALE=zh-CN
  R="$(run_cli "$DATA" "$APP" apply --locale "$LOCALE")"
  log_to update.log "repatch: ok=$(json_get "$R" ok) status=$(json_get "$R" status) $(json_get "$R" message)"
  # macOS 上替换 app.asar 是原子 rename，运行中的进程不受影响；重新打开后生效
  if [ "$(json_get "$R" ok)" = "true" ] && [ -n "$(app_pids "$APP")" ]; then
    notify "Antigravity 语言包" "Antigravity 已更新。重新打开后即恢复中文界面。"
  fi
else
  log_to update.log 'app.asar unchanged within timeout (update not installed yet or cancelled)'
fi
exit 0
