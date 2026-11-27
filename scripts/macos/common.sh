#!/usr/bin/env bash
# agy-i18n macOS 公共函数（bash 3.2 兼容，macOS 自带 bash 即可）
# 设计：不重新签名、不注册 LaunchAgent、不常驻进程、不强制结束 Antigravity。

AGY_DATA_DIR="${AGY_DATA_DIR:-$HOME/Library/Application Support/agy-i18n}"

info() { printf '%s\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

is_app() { [ -f "$1/Contents/Resources/app.asar" ]; }

# 查找 Antigravity 桌面端（Antigravity IDE 使用 Resources/app 目录，不含 app.asar，会被排除）
find_app() {
  if [ -n "${1:-}" ]; then
    if is_app "$1"; then (cd "$1" && pwd); return 0; fi
    err "不是 Antigravity 桌面端（缺少 Contents/Resources/app.asar）：$1"; return 1
  fi
  local c
  for c in "/Applications/Antigravity.app" "$HOME/Applications/Antigravity.app"; do
    if is_app "$c"; then printf '%s\n' "$c"; return 0; fi
  done
  if command -v mdfind >/dev/null 2>&1; then
    while IFS= read -r c; do
      if is_app "$c"; then printf '%s\n' "$c"; return 0; fi
    done < <(mdfind "kMDItemFSName == 'Antigravity*.app'c" 2>/dev/null)
  fi
  err '没有找到 Antigravity 桌面端。若安装在其它位置，请用 --app "/路径/Antigravity.app" 指定。'
  return 1
}

app_exe() {
  local exe="$1/Contents/MacOS/Antigravity"
  if [ -x "$exe" ]; then printf '%s\n' "$exe"; return; fi
  ls -1 "$1/Contents/MacOS/" 2>/dev/null | head -n 1 | sed "s#^#$1/Contents/MacOS/#"
}

# 来自该 .app 的进程 PID
app_pids() { pgrep -f "$1/Contents/MacOS/" 2>/dev/null || true; }

# 等用户自己退出 Antigravity——绝不强制结束
wait_app_closed() { # $1=app $2=noninteractive(0/1)
  while [ -n "$(app_pids "$1")" ]; do
    if [ "${2:-0}" = "1" ]; then return 1; fi
    warn '检测到 Antigravity 正在运行。请先退出它（⌘Q），然后按回车继续；输入 q 取消。'
    local a; read -r a
    [ "$a" = "q" ] && return 1
  done
  return 0
}

sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

# 读取 RunAsNode fuse（Electron Framework 中）：输出 1 / 0 / 空
run_as_node_fuse() {
  local fw="$1/Contents/Frameworks/Electron Framework.framework/Electron Framework"
  [ -f "$fw" ] || return 0
  LC_ALL=C grep -a -o -m1 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX..[01r]' "$fw" 2>/dev/null | head -n1 | tail -c 2 | tr -d '\n'
}

# 运行 cli.js：优先用 Antigravity 自带的 Electron（ELECTRON_RUN_AS_NODE），否则用系统 node
run_cli() { # $1=data $2=app 其余=参数
  local data="$1" app="$2"; shift 2
  local fuse exe
  fuse="$(run_as_node_fuse "$app")"
  exe="$(app_exe "$app")"
  if [ "$fuse" != "0" ] && [ -n "$exe" ] && [ -x "$exe" ]; then
    ELECTRON_RUN_AS_NODE=1 "$exe" "$data/cli.js" "$@" --app-dir "$app" --data-dir "$data" --json
  elif command -v node >/dev/null 2>&1; then
    node "$data/cli.js" "$@" --app-dir "$app" --data-dir "$data" --json
  else
    printf '{"ok":false,"error":"NO_RUNTIME","message":"此版本 Antigravity 禁止以 Node 模式运行，且未找到 Node.js。请安装 Node.js 18+ 后重试。"}\n'
  fi
}

# 从 cli 的单行 JSON 输出里取顶层字段（不依赖 jq / python：新版 macOS 的 /usr/bin/python3 只是安装提示桩）
json_get() { # $1=json $2=key
  local line v
  line="$(printf '%s\n' "$1" | grep '^{' | tail -n 1)"
  v="$(printf '%s' "$line" | sed -nE "s/.*\"$2\":\"([^\"]*)\".*/\1/p")"
  [ -z "$v" ] && v="$(printf '%s' "$line" | sed -nE "s/.*\"$2\":(true|false|[0-9]+).*/\1/p")"
  printf '%s' "$v"
}

log_to() { # $1=文件名 其余=内容
  mkdir -p "$AGY_DATA_DIR/logs" 2>/dev/null
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${*:2}" >> "$AGY_DATA_DIR/logs/$1" 2>/dev/null || true
}

notify() { # 不打扰的系统通知
  command -v osascript >/dev/null 2>&1 && osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}
