#!/bin/bash
# 双击运行：卸载 Antigravity 原生语言包（macOS）
cd "$(dirname "$0")" && bash scripts/macos/uninstall.sh "$@"
echo
read -n 1 -s -r -p "按任意键关闭此窗口…"
