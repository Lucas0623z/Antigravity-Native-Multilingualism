# Antigravity 原生语言包（agy-i18n）

为 **Google Antigravity 桌面端（Windows / macOS）** 提供界面语言切换：在 **设置 → 外观 → 显示语言** 里，用 Antigravity 自己的下拉框选择语言，**立即生效、无需重启**。

- 支持语言：English / 简体中文 / 繁體中文 / 跟随系统
- 词典：4,100+ 条精确词条 + 120+ 条动态文案模板（数量、时长、限额、步骤……）
- 覆盖：主界面、设置页、原生菜单栏、托盘菜单、右键菜单、系统对话框
- 社区非官方项目，与 Google 无关

## 安装（Windows）

1. 下载 `agy-i18n-<版本>-windows.zip`。若开启了"智能应用控制"，先右键 zip → 属性 → 勾选"解除锁定"再解压

2. **完全退出 Antigravity**（包括右下角托盘图标）
3. 双击 `安装.cmd`
4. 启动 Antigravity → 设置 → 外观 → **显示语言**

不需要安装 Node.js（会借用 Antigravity 自带的运行时），不需要管理员权限。

可选参数（在 PowerShell 中运行 `scripts\install.ps1`）：

| 参数 | 说明 |
|---|---|
| `-Locale zh-CN` / `zh-TW` / `en` / `system` | 首次安装时的默认语言（之后在设置里随时改），默认 `zh-CN` |
| `-AppDir "D:\Apps\Antigravity"` | Antigravity 不在默认位置时指定安装目录 |
| `-NonInteractive` | 不询问（Antigravity 在运行时直接退出，返回码 3） |

## 安装（macOS）

1. 下载并解压 `agy-i18n-<版本>-macos.zip`
2. **退出 Antigravity**（⌘Q）
3. 双击 `安装.command`（首次若被阻止：右键 → 打开；或在终端运行 `bash 安装.command`）
4. 若提示"终端被阻止修改 App"：打开 **系统设置 → 隐私与安全性 → App 管理**，允许"终端"，再运行一次
5. 打开 Antigravity → 设置 → 外观 → **显示语言**

macOS 版**不重新签名**（Google 的签名保持原样）、不注册 LaunchAgent、不常驻后台。卸载时逐字节还原，应用签名随之完全恢复有效。数据目录：`~/Library/Application Support/agy-i18n`。

## 卸载

Windows：双击 `%LOCALAPPDATA%\agy-i18n\卸载.cmd`；macOS：双击 `~/Library/Application Support/agy-i18n/卸载.command`。原版 `app.asar` 会被**逐字节重建并用 SHA-256 校验**，然后删除 `%LOCALAPPDATA%\agy-i18n`。

## 与现有方案的对比

| | **本项目** | CDP 调试端口注入型 | 改 app.asar + 词典替换型 |
|---|---|---|---|
| 设置里切换语言 | 支持：克隆原生下拉行，外观与原生完全一致 | 支持：手写仿制 UI | 不支持：只能运行脚本 |
| 切换无需重启 | 是 | 是 | 否 |
| 远程调试端口 | **不开** | 常开（本机任何程序可控制 AI 智能体） | 不开 |
| 常驻后台进程 / 开机自启 / 计划任务 | **无** | 守护进程 + 开机自启 | 有的有 30 分钟计划任务 |
| 启动后强制重启 Antigravity | **从不** | 会 | 部分会强杀进程 |
| 运行时从外部目录加载代码 | **否**（全部封装在 app.asar 内） | 是 | 是 |
| 把聊天内容发到本地端口 | **否** | 否 | 有方案会 |
| 误翻聊天 / 代码 / 对话标题 | 整块跳过 + 正文语境禁用模糊模板 | 较少 | 常见（"Read the README" → "已读取 the README"） |
| 原生菜单 / 托盘 / 对话框 | 支持：影子菜单，不破坏按英文 label 的查找 | 不支持 | 支持 |
| 自动更新后 | 更新瞬间一次性衔接，自动重新打补丁并重启 | 不受影响 | 需手动重打或依赖计划任务 |
| 卸载 | 逐字节还原 + SHA-256 校验 | 删守护进程 | 恢复备份 / 剥离注入 |
| 中文字体 | 设置 `lang` + 仅对汉字区段回退到微软雅黑，拉丁字母保持原生字体 | 无 | 无 |

## 工作原理

```
app.asar（只追加，不移动任何原始字节）
├── 原版全部文件 …………………………………… 逐字节不变
├── dist/main.js ………………………………… 仅在首行插入 1 行 require（"use strict" 之后）
└── agy-i18n/
    ├── boot.js、main/*.js ……………………… 主进程：菜单 / 对话框 / 更新衔接 / IPC
    ├── preload.bundle.js ……………………… 会话级 preload（隔离世界）：DOM 翻译 + 设置页下拉框
    ├── locales/*.json ………………………… 词典
    └── marker.json …………………………… 原版头部字节、原版长度、原版 SHA-256（用于还原）
```

- **注入方式**：主进程用 `session.registerPreloadScript` 注册 preload。preload 在页面脚本之前、在隔离世界中运行，首屏几乎看不到英文闪烁；页面脚本无法访问它（不使用 contextBridge）。
- **只翻译 Antigravity 自己的界面**：主进程根据 webContents 类型与来源判断，内置浏览器（`<webview>`）和外部网页一律不处理。
- **React 安全**：只改 Text 节点的 `nodeValue` 与 `title / placeholder / aria-label`，不增删节点；原文存在 WeakMap 中，切回英文时逐节点还原。
- **不误翻**：代码块、编辑器、终端、输入框、聊天正文（Markdown）、用户消息、对话标题、模型名整块跳过；`<p>/<li>` 等正文语境中禁用自由文本模板。
- **原生下拉框**：克隆设置页里 "Theme" 行（或任意原生下拉行），因此字体、间距、颜色、圆角、图标、深浅色主题都与原生一致；弹出列表会"学习"你打开过的原生下拉弹层样式并复用。
- **原生菜单**：不改 Antigravity 的 MenuItem（它的代码按英文 label 查找菜单、路由更新操作），而是提交给系统显示时生成翻译后的影子菜单，点击转发回原菜单项。
- **自动更新**：Windows 在 electron-updater 安装更新的那一刻启动一次性 PowerShell 脚本：等安装器换完文件 → 重新打补丁 → 重启 Antigravity。macOS 在"已下载更新"且应用退出时启动一次性 bash 脚本：等 Squirrel/ShipIt 换上新版 → 重新打补丁（若已被自动重新打开，只发系统通知提示重新打开）。脚本完成即退出，任何一步失败都不影响官方更新本身。
- **安全检查**：打补丁前读取 Electron Fuses；若开启了 ASAR 完整性校验则拒绝修改（否则 Antigravity 会无法启动）。

## 安全阀

- 以环境变量 `AGY_I18N=off` 启动 Antigravity，可完全跳过本扩展。
- 任何异常都被捕获，最坏情况是界面保持英文，不会影响 Antigravity 启动。
- 兜底：从官网重新安装 Antigravity 覆盖即可回到原版。

## 帮忙补全词典

Antigravity 更新频繁，新文案会显示为英文。开启收集：编辑 Antigravity 用户数据目录下的 `agy-i18n.json`，加上 `"collectMissing": true`，重启后使用一段时间，未翻译的**界面短文本**（只收集按钮、菜单、标签、标题等控件内的文字，不收集聊天内容）会写入同目录的 `agy-i18n-missing.json`，仅保存在本机。

## 开发

```bash
npm install
npm test                                  # 单元测试（词典、补丁器、DOM 翻译、设置页下拉框、钩子）
ELECTRON_BIN=/path/to/electron node test/e2e/run.js   # 真实 Electron 端到端测试（需 xvfb）
PWSH=/path/to/pwsh bash test/e2e/ps-test.sh           # Windows 安装/更新/卸载脚本全流程测试
bash test/e2e/mac-test.sh                             # macOS 安装/更新/卸载脚本全流程测试（模拟 .app）
npm run release                           # 生成 release/agy-i18n-<版本>-windows.zip 与 -macos.zip
```

## 已知限制

- macOS 版尚未在真实 Mac 上运行过（脚本已在模拟 .app 结构上完整测试）。已在 Electron 28 / 36 / 44 上做端到端测试；真实 Antigravity 2.35.2 使用 Electron 44.9.1。
- 只适用于 **Antigravity 桌面端**（`resources\app.asar`）；Antigravity IDE（VS Code 分支）请使用 IDE 的语言包扩展。
- 新版本新增的文案在词典更新前显示英文。
