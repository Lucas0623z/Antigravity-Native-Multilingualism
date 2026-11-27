# 交接说明（云端会话 → 本地会话）

本项目在云端容器里开发和测试，**还没有在真实的 Antigravity 上运行过**。本地会话已只读核对了真实环境（Antigravity 2.35.2，Electron 44.9.1，ASAR 完整性校验关闭，主界面是窗口内嵌的 WebContentsView，加载 `https://127.0.0.1:<端口>`，设置 → 外观里"主题"是图标按钮组、"字体 / 字号"是原生下拉组件），并据此做了修改。

## 已根据真机核对结果修改

- 设置页语言行改为优先克隆 **"Font" / "Font size"** 下拉行（`src/renderer/picker.js` 的 `PREFERRED_TEMPLATES`），并新增对应单元测试。
- 端到端测试新增"窗口内嵌 WebContentsView + https://127.0.0.1（自签证书）"场景；在 **Electron 44.11.6** 上 26/26 通过。

## 当前测试状态

| 测试 | 结果 |
|---|---|
| `npm test`（单元测试） | 44/44 |
| `test/e2e/run.js`（真实 Electron 44.11.6 / 36.9.5） | 26/26 |
| `test/e2e/run.js`（Electron 28.3.3，旧版 setPreloads 路径） | 23/23（WebContentsView 场景跳过） |
| `test/e2e/ps-test.sh`（PowerShell 7 安装/更新/卸载流程） | 11/11 |

## 在真机上需要验证的事（按优先级）

1. **"Font" 行的真实 DOM**：控件是否是 `button[role=combobox]` / `button[aria-haspopup]` / `<select>` 之一（见 `picker.js` 的 `DROPDOWN_SEL`）。若不是，把实际选择器加进去。可在 `%APPDATA%\Antigravity\Cache\Cache_Data` 里的界面代码中确认。
2. **外观标题**：`findAppearance()` 找英文原文为 `Appearance` 的 `h1–h4 / [role=heading]`。确认真实标题的标签。
3. **聊天区域选择器**：`src/renderer/dom.js` 的 `SKIP_SELECTOR`（`.prose`、`[data-testid="user-message-content"]`、对话标题等）是否覆盖真实的聊天正文、AI 回复、对话标题。
4. **安装**：完全退出 Antigravity → 双击 `安装.cmd`（或 `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`）。安装器会用 Antigravity 自带的 Electron（`ELECTRON_RUN_AS_NODE`）运行补丁器，不需要 Node.js。
5. **启动后检查**：界面是否变成中文；设置 → 外观是否出现"显示语言"；切换 English / 繁體中文 是否即时生效；菜单栏、托盘菜单是否翻译；`%LOCALAPPDATA%\agy-i18n\logs\runtime.log` 有无报错。
6. **卸载**：`%LOCALAPPDATA%\agy-i18n\卸载.cmd`，确认 `app.asar` 与安装前 SHA-256 一致（`Get-FileHash`）。
7. **出问题时的安全阀**：以环境变量 `AGY_I18N=off` 启动 Antigravity 可完全跳过本扩展。

## 调试技巧

- 设置 `AGY_I18N_DEBUG=1` 启动时，主进程会暴露 `global.__agyI18nDebug`。
- 在 `%APPDATA%\Antigravity\agy-i18n.json` 加 `"collectMissing": true`，未翻译的界面短文本会写入同目录 `agy-i18n-missing.json`，可据此补词典（`locales/zh-CN.json`、`locales/zh-TW.json`）。

## 目录

```
src/boot.js                 主进程引导（被插入 main.js 首行 require）
src/main/                   主进程：index（IPC/preload 注册/页面准入）、menu、dialog、updater
src/renderer/               preload：dom（翻译引擎）、picker（设置页下拉框）、preload（入口）
src/shared/matcher.js       词典 + 模板匹配
src/patcher/                asar 读写、fuse 读取、打补丁/还原
cli.js                      apply / remove / status
scripts/*.ps1               安装、卸载、更新衔接（UTF-8 BOM，勿去掉）
locales/                    zh-CN / zh-TW 词典
tools/                      build（打包 preload）、release（生成 zip）、make-locale、diagnose.ps1
test/                       单元测试；test/e2e/ 真实 Electron 与 PowerShell 流程测试
docs/                       术语表、模板源文件
```
