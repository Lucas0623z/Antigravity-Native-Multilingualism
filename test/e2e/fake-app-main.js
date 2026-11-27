"use strict";
/*
 * 模拟 Antigravity 桌面端主进程（用于真实 Electron 端到端测试）。
 * 特意复现真实应用的几个"坑"：
 *  - 渲染进程 sandbox + contextIsolation
 *  - 界面由本地 HTTP 服务（127.0.0.1:端口）提供
 *  - 主进程按英文 label 查找菜单项（'File' / 'View' / 'Help'），并用 label 查表路由更新操作
 *  - 运行中改写菜单项 label（"Check for Updates" → "Checking for Updates..."）
 */
const { app, BrowserWindow, Menu } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const results = { checks: [], errors: [] };
const check = (name, ok, detail) => results.checks.push({ name, ok: !!ok, detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath("userData", process.env.E2E_USERDATA);

const updateActions = { "Check for Updates": () => (results.updateClicked = (results.updateClicked || 0) + 1) };

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Settings", id: "settings", click: () => (results.settingsClicked = true) },
      { label: "Check for Updates", id: "check-for-updates", click: (item) => { results.clickedLabel = item.label; const fn = updateActions[item.label]; if (fn) fn(); } },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ] },
    { label: "View", submenu: [ { label: "Toggle Full Screen", type: "checkbox", checked: false, id: "fs-toggle", click: (item) => (results.toggleChecked = item.checked) } ] },
    { label: "Help", submenu: [ { label: "About", click() {} } ] },
  ]);
}

const PAGE = fs.readFileSync(path.join(__dirname, "page.html"), "utf8");

function serve(host, csp) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); if (csp) res.setHeader("content-security-policy", csp); res.end(PAGE); });
    s.listen(0, host, () => resolve(s.address().port));
  });
}

// 实测 Antigravity 2.35：主界面由 language_server 以 https://127.0.0.1:<端口> 提供（自签证书）
function serveHttps() {
  return new Promise((resolve) => {
    const s = https.createServer({ key: fs.readFileSync(process.env.E2E_TLS_KEY), cert: fs.readFileSync(process.env.E2E_TLS_CERT) }, (req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
    s.listen(0, "127.0.0.1", () => resolve(s.address().port));
  });
}
app.on("certificate-error", (event, _wc, url, _err, _cert, cb) => {
  if (url.startsWith("https://127.0.0.1:")) { event.preventDefault(); cb(true); } else cb(false);
});

async function q(win, js) { return (win.webContents || win).executeJavaScript(js, true); }

app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(buildMenu());
    // 真实应用的查找方式：按英文 label
    const appMenu = Menu.getApplicationMenu();
    const file = appMenu.items.find((i) => i.label === "File");
    check("按英文 label 查找 File 菜单", !!file);
    check("按英文 label 查找 View / Help", !!appMenu.items.find((i) => i.label === "View") && !!appMenu.items.find((i) => i.label === "Help"));

    const dbg = global.__agyI18nDebug;
    check("运行时已从 app.asar 内加载", !!dbg);
    const shadow = dbg.menus._shadowAppMenu();
    check("系统显示的菜单已翻译", shadow && shadow.items[0].label === "文件" && shadow.items[0].submenu.items[0].label === "设置", shadow && shadow.items.map((i) => i.label));
    // 点击翻译后的菜单项 → 回调收到原始菜单项（英文 label）
    shadow.items[0].submenu.items[1].click();
    check("点击转发到原始菜单项，label 查表路由仍有效", results.updateClicked === 1 && results.clickedLabel === "Check for Updates", { updateClicked: results.updateClicked, clickedLabel: results.clickedLabel });
    // 复选框状态同步
    shadow.items[1].submenu.items[0].click();
    check("复选框点击后原始与影子状态一致", results.toggleChecked === true && Menu.getApplicationMenu().items[1].submenu.items[0].checked === true);
    // 运行中改写 label
    const item = Menu.getApplicationMenu().getMenuItemById("check-for-updates");
    item.label = "Restart to Update";
    await wait(50);
    const shadow2 = dbg.menus._shadowAppMenu();
    check("原始菜单项改 label 后，显示菜单自动更新并翻译", shadow2.items[0].submenu.items[1].label === "重启以更新", shadow2.items[0].submenu.items[1].label);

    const port = await serve("127.0.0.1");
    const win = new BrowserWindow({ show: true, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL(`http://127.0.0.1:${port}/`);
    await wait(800);

    const r1 = await q(win, `({
      nav: document.querySelector('nav button').textContent,
      h3: document.querySelector('#appearance h3').textContent,
      lang: document.documentElement.lang,
      prose: document.querySelector('.prose p').textContent,
      code: document.querySelector('code').textContent,
      title: document.querySelector('nav button[title]').getAttribute('title'),
      row: !!document.querySelector('[data-agy-i18n="language-row"]'),
      rowLabel: document.querySelector('[data-agy-i18n="language-row"] span') && document.querySelector('[data-agy-i18n="language-row"] span').textContent,
      rowValue: document.querySelector('[data-agy-i18n="language-row"] [role=combobox] .truncate') && document.querySelector('[data-agy-i18n="language-row"] [role=combobox] .truncate').textContent,
      sameClass: (() => { const r = document.querySelector('[data-agy-i18n="language-row"]'); return !!r && r.className === r.nextElementSibling.className; })(),
      pageSeesBridge: typeof window.__agyI18n !== 'undefined' || typeof window.agyI18n !== 'undefined',
      dynamic: (() => { const b = document.createElement('button'); b.id = 'dyn'; b.textContent = 'Cancel'; document.body.appendChild(b); return true; })(),
    })`);
    await wait(50);
    const dyn = await q(win, "document.getElementById('dyn').textContent");
    check("沙盒页面中界面文字已翻译", r1.nav === "设置" && r1.h3 === "外观" && r1.title === "关闭", r1);
    check("html lang = zh-CN", r1.lang === "zh-CN", r1.lang);
    check("聊天正文与代码未被翻译", r1.prose === "Read the README and fix the bug" && r1.code === "Settings", r1);
    check("设置→外观 出现原生样式的显示语言行", r1.row && r1.rowLabel === "显示语言" && r1.rowValue === "简体中文" && r1.sameClass, r1);
    check("页面脚本无法访问扩展（无 contextBridge 暴露）", r1.pageSeesBridge === false);
    check("动态插入的元素被翻译", dyn === "取消", dyn);

    // 用户在原生下拉框中选择 English
    await q(win, `document.querySelector('[data-agy-i18n="language-row"] [role=combobox]').click()`);
    await wait(50);
    const opts = await q(win, `Array.from(document.querySelectorAll('[data-agy-i18n="language-popover"] [role=option]')).map(o => o.dataset.code)`);
    check("下拉列表列出 跟随系统 / English / 简体中文 / 繁體中文", JSON.stringify(opts.slice(0, 3)) === JSON.stringify(["system", "en", "zh-CN"]) && (opts.length === 3 || opts[3] === "zh-TW"), opts);
    await q(win, `document.querySelector('[data-agy-i18n="language-popover"] [data-code="en"]').click()`);
    await wait(500);
    const r2 = await q(win, `({ nav: document.querySelector('nav button').textContent, h3: document.querySelector('#appearance h3').textContent, lang: document.documentElement.getAttribute('lang'), rowLabel: document.querySelector('[data-agy-i18n="language-row"] span') && document.querySelector('[data-agy-i18n="language-row"] span').textContent, dyn: document.getElementById('dyn').textContent })`);
    check("切换到 English：无需重启即时还原英文", r2.nav === "Settings" && r2.h3 === "Appearance" && r2.dyn === "Cancel" && r2.lang === null, r2);
    check("切换到 English：语言行自身也变成英文", r2.rowLabel === "Display Language", r2.rowLabel);
    const shadow3 = dbg.menus._shadowAppMenu();
    check("切换到 English：系统菜单同步还原", shadow3 && shadow3.items[0].label === "File", shadow3 && shadow3.items[0].label);
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.E2E_USERDATA, "agy-i18n.json"), "utf8"));
    check("语言选择已保存到 userData/agy-i18n.json", cfg.locale === "en", cfg);

    // 切回中文
    await q(win, `document.querySelector('[data-agy-i18n="language-row"] [role=combobox]').click()`);
    await wait(50);
    await q(win, `document.querySelector('[data-agy-i18n="language-popover"] [data-code="zh-CN"]').click()`);
    await wait(500);
    const r3 = await q(win, `document.querySelector('nav button').textContent`);
    check("再切回简体中文", r3 === "设置", r3);

    // 非 Antigravity 来源的页面（模拟外部网页）不应被处理
    const port2 = await serve("127.0.0.2");
    const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await other.loadURL(`http://127.0.0.2:${port2}/`);
    await wait(500);
    const r4 = await q(other, `({ nav: document.querySelector('nav button').textContent, row: !!document.querySelector('[data-agy-i18n]') })`);
    check("外部来源页面完全不处理", r4.nav === "Settings" && r4.row === false, r4);

    // 严格 CSP（禁止内联样式）的页面：翻译照常，字体回退改用可构造样式表
    const port3 = await serve("127.0.0.1", "default-src 'self'; style-src 'self'; script-src 'self'");
    const strict = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await strict.loadURL(`http://127.0.0.1:${port3}/`);
    await wait(800);
    const r6 = await q(strict, `({ nav: document.querySelector('nav button').textContent, font: getComputedStyle(document.body).fontFamily, adopted: document.adoptedStyleSheets.length, row: !!document.querySelector('[data-agy-i18n="language-row"]') })`);
    check("严格 CSP 页面：翻译与设置行正常，字体回退经可构造样式表生效", r6.nav === "设置" && r6.row && /agy-i18n-cjk/.test(r6.font) && r6.adopted > 0, r6);

    // 重新加载后仍保持中文（preload 每次导航都会执行）
    await win.webContents.reload();
    await wait(800);
    const r5 = await q(win, `document.querySelector('nav button').textContent`);
    check("刷新页面后仍为中文", r5 === "设置", r5);

    // ---- 实测结构：窗口内嵌 WebContentsView（hubWcv）加载 https://127.0.0.1 ----
    const { WebContentsView } = require("electron");
    if (WebContentsView && parseInt(process.versions.electron, 10) >= 30 && process.env.E2E_TLS_KEY) {
      const hubPort = await serveHttps();
      const shell = new BrowserWindow({ show: true, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
      await shell.loadURL("data:text/html,<title>shell</title>");
      const hubWcv = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
      shell.contentView.addChildView(hubWcv);
      hubWcv.setBounds({ x: 0, y: 0, width: 1100, height: 800 });
      await hubWcv.webContents.loadURL(`https://127.0.0.1:${hubPort}/`);
      await wait(900);
      const h1 = await q(hubWcv, `({ nav: document.querySelector('nav button').textContent, row: !!document.querySelector('[data-agy-i18n="language-row"]'), prose: document.querySelector('.prose p').textContent, lang: document.documentElement.lang })`);
      check("内嵌 WebContentsView（https://127.0.0.1）中界面已翻译、出现显示语言行", h1.nav === "设置" && h1.row && h1.prose === "Read the README and fix the bug" && h1.lang === "zh-CN", h1);
      await q(hubWcv, `document.querySelector('[data-agy-i18n="language-row"] [role=combobox]').click()`);
      await wait(50);
      await q(hubWcv, `document.querySelector('[data-agy-i18n="language-popover"] [data-code="zh-TW"]').click()`);
      await wait(500);
      const h2 = await q(hubWcv, `({ nav: document.querySelector('nav button').textContent, h3: document.querySelector('#appearance h3').textContent, lang: document.documentElement.lang })`);
      const w2 = await q(win, `document.querySelector('nav button').textContent`);
      check("在内嵌视图里切到繁體中文，所有页面同步切换", h2.nav === "設定" && h2.h3 === "外觀" && h2.lang === "zh-TW" && w2 === "設定", { h2, w2 });
      const shadow4 = dbg.menus._shadowAppMenu();
      check("繁體中文：系统菜单同步", shadow4 && shadow4.items[0].label === "檔案", shadow4 && shadow4.items[0].label);
    } else {
      results.skipped = "WebContentsView 需要 Electron ≥30";
    }
  } catch (e) {
    results.errors.push(String(e && e.stack || e));
  }
  process.stdout.write(`E2E_RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
});
