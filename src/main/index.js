'use strict';
/**
 * 主进程入口（由 boot.js 在 Antigravity 自己的 main.js 之前加载）。
 *
 * 职责：
 *  - 读取语言设置（userData/agy-i18n.json），加载词典
 *  - 为每个 session 注册翻译 preload（不开调试端口、不 executeJavaScript）
 *  - 用 IPC 回答 preload 的"我该不该翻译、用什么语言"，只对 Antigravity 自己的界面启用
 *  - 汉化原生菜单 / 托盘 / 对话框
 *  - 衔接自动更新
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CONFIG_NAME = 'agy-i18n.json';
const SUPPORTED_FALLBACK = 'en';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function createLogger(dir) {
  return function log(msg, err) {
    try {
      const line = `[${new Date().toISOString()}] ${msg}${err ? `: ${err && err.stack ? err.stack : err}` : ''}\n`;
      if (dir) {
        fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
        fs.appendFileSync(path.join(dir, 'logs', 'runtime.log'), line);
      }
    } catch (_) {
      /* 日志失败不能影响应用 */
    }
  };
}

function loadLocales() {
  const dir = path.join(ROOT, 'locales');
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (_) {
    names = [];
  }
  for (const n of names) {
    const data = readJson(path.join(dir, n), null);
    if (data && data.meta && data.meta.code) out.set(data.meta.code, data);
  }
  return out;
}

/** 把系统语言映射到我们支持的语言 */
function resolveSystemLocale(app, locales) {
  let prefs = [];
  try {
    prefs = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
  } catch (_) {
    prefs = [];
  }
  try {
    prefs.push(app.getLocale());
  } catch (_) {
    /* ignore */
  }
  for (const raw of prefs) {
    if (!raw) continue;
    const tag = String(raw);
    if (locales.has(tag)) return tag;
    const lower = tag.toLowerCase();
    if (/^zh(-hans)?(-cn|-sg|-my)?$/.test(lower) || lower.startsWith('zh-hans')) return locales.has('zh-CN') ? 'zh-CN' : SUPPORTED_FALLBACK;
    if (/^zh-(hant|tw|hk|mo)/.test(lower)) return locales.has('zh-TW') ? 'zh-TW' : locales.has('zh-CN') ? 'zh-CN' : SUPPORTED_FALLBACK;
    const base = lower.split('-')[0];
    for (const code of locales.keys()) if (code.toLowerCase().split('-')[0] === base) return code;
  }
  return SUPPORTED_FALLBACK;
}

function start(opts) {
  const electron = (opts && opts.electron) || require('electron');
  const { app, ipcMain, session, BrowserWindow } = electron;
  const { Matcher } = require('../shared/matcher.js');
  const { installMenuHooks } = require('./menu.js');
  const { installDialogHooks } = require('./dialog.js');
  const { installUpdaterHook } = require('./updater.js');

  const install = readJson(path.join(ROOT, 'install.json'), {});
  const log = createLogger(install.dataDir);
  const locales = loadLocales();
  const preloadPath = path.join(ROOT, 'preload.bundle.js');

  // ---------- 设置 ----------
  const defaults = { locale: install.defaultLocale || 'system', collectMissing: false };
  let config = Object.assign({}, defaults);
  // 不缓存：Antigravity 可能在自己的 main.js 里调用 app.setPath('userData', …)
  function configPath() {
    try {
      return path.join(app.getPath('userData'), CONFIG_NAME);
    } catch (_) {
      return null;
    }
  }
  function loadConfig() {
    const p = configPath();
    if (p) config = Object.assign({}, defaults, readJson(p, {}));
  }
  function saveConfig() {
    const p = configPath();
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
      fs.renameSync(tmp, p);
    } catch (e) {
      log('save config failed', e);
    }
  }

  // ---------- 语言状态 ----------
  let effective = SUPPORTED_FALLBACK; // 实际生效的语言代码
  let matcher = null;
  function computeEffective() {
    const want = config.locale || 'system';
    if (want === 'system') return app.isReady() ? resolveSystemLocale(app, locales) : SUPPORTED_FALLBACK;
    return want === 'en' || locales.has(want) ? want : SUPPORTED_FALLBACK;
  }
  function applyEffective() {
    effective = computeEffective();
    const data = locales.get(effective);
    matcher = effective !== 'en' && data ? new Matcher(data) : null;
  }
  const getTranslate = () => (matcher ? (s) => matcher.translate(s) : null);

  function uiLabels() {
    const meta = (matcher && matcher.meta) || {};
    return {
      title: meta.pickerTitle || 'Display Language',
      description: meta.pickerDescription || 'Choose the language of the Antigravity interface. Restart is not required.',
    };
  }
  function localeOptions() {
    const meta = (matcher && matcher.meta) || {};
    const sys = resolveSystemLocale(app, locales);
    const sysName = sys === 'en' ? 'English' : (locales.get(sys) && locales.get(sys).meta.name) || sys;
    const opts = [{ code: 'system', name: `${meta.systemOption || 'Use system language'} (${sysName})` }, { code: 'en', name: 'English' }];
    for (const [code, data] of locales) opts.push({ code, name: data.meta.name || code });
    return opts;
  }
  function payload() {
    return {
      locale: effective === 'en' ? null : locales.get(effective) || null,
      current: config.locale || 'system',
      locales: localeOptions(),
      labels: uiLabels(),
    };
  }

  // ---------- 哪些页面可以翻译 ----------
  const trustedOrigins = new Set();
  function originOf(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'data:' || u.protocol === 'about:' ? u.protocol : u.origin;
    } catch (_) {
      return '';
    }
  }
  function isAppUrl(url) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(\/|$)/i.test(url) || /^data:text\/html/i.test(url) || /^file:/i.test(url);
  }
  function isAllowed(wc, url) {
    try {
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return false;
      const type = typeof wc.getType === 'function' ? wc.getType() : 'window';
      if (type === 'webview' || type === 'backgroundPage' || type === 'remote') return false;
      const href = url || (wc.getURL && wc.getURL()) || '';
      const win = BrowserWindow && BrowserWindow.fromWebContents ? BrowserWindow.fromWebContents(wc) : null;
      // Antigravity 自己的窗口主页面
      if (win && win.webContents === wc && isAppUrl(href)) {
        trustedOrigins.add(originOf(href));
        return true;
      }
      // 嵌入视图（WebContentsView）：仅限已在主窗口出现过的同一本地来源
      const o = originOf(href);
      if (o && trustedOrigins.has(o)) return true;
      // 主界面尚未出现时，接受本地 https 界面（Antigravity 语言服务器）
      if (/^https:\/\/(127\.0\.0\.1|localhost):\d+/i.test(href)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function broadcast() {
    const data = payload();
    const all = electron.webContents && electron.webContents.getAllWebContents ? electron.webContents.getAllWebContents() : [];
    for (const wc of all) {
      if (wc.__agyI18nEnabled && !wc.isDestroyed()) {
        try {
          wc.send('agy-i18n:locale', data);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function setLocale(code) {
    if (code !== 'system' && code !== 'en' && !locales.has(code)) return;
    config.locale = code;
    saveConfig();
    applyEffective();
    menus.refresh();
    broadcast();
    log(`locale -> ${code} (${effective})`);
  }

  // ---------- 注册 ----------
  const menus = installMenuHooks(electron, getTranslate, log);
  installDialogHooks(electron, getTranslate, log);
  installUpdaterHook({ install, log });

  const registered = new WeakSet();
  function addPreload(ses) {
    if (!ses || registered.has(ses)) return;
    registered.add(ses);
    try {
      if (typeof ses.registerPreloadScript === 'function') {
        ses.registerPreloadScript({ type: 'frame', id: 'agy-i18n', filePath: preloadPath });
      } else if (typeof ses.setPreloads === 'function') {
        const list = ses.getPreloads ? ses.getPreloads() : [];
        if (!list.includes(preloadPath)) ses.setPreloads(list.concat(preloadPath));
      }
    } catch (e) {
      log('register preload failed', e);
    }
  }

  ipcMain.on('agy-i18n:init', (event, info) => {
    const url = (event.senderFrame && event.senderFrame.url) || (info && info.href) || '';
    const allowed = isAllowed(event.sender, url);
    if (!allowed) {
      event.returnValue = { enabled: false };
      return;
    }
    event.sender.__agyI18nEnabled = true;
    const isMainFrame = !event.senderFrame || !event.senderFrame.parent;
    event.returnValue = Object.assign({ enabled: true, picker: isMainFrame, collectMissing: !!config.collectMissing }, payload());
  });
  ipcMain.on('agy-i18n:set-locale', (event, code) => {
    if (!event.sender.__agyI18nEnabled) return;
    if (typeof code !== 'string' || code.length > 20) return;
    setLocale(code);
  });
  ipcMain.on('agy-i18n:missing', (event, list) => {
    if (!event.sender.__agyI18nEnabled || !config.collectMissing || !Array.isArray(list)) return;
    collectMissing(list);
  });

  const missingSet = new Set();
  function collectMissing(list) {
    const p = configPath();
    if (!p) return;
    const file = path.join(path.dirname(p), 'agy-i18n-missing.json');
    if (!missingSet.size) for (const s of readJson(file, [])) missingSet.add(s);
    for (const s of list.slice(0, 500)) if (typeof s === 'string' && s.length <= 200) missingSet.add(s);
    try {
      fs.writeFileSync(file, JSON.stringify(Array.from(missingSet).sort(), null, 1));
    } catch (_) {
      /* ignore */
    }
  }

  // 尽早读设置，这样启动画面 / 菜单一开始就是目标语言
  loadConfig();
  applyEffective();

  app.on('session-created', addPreload);
  app.whenReady().then(() => {
    loadConfig();
    applyEffective(); // "跟随系统"需要 ready 之后才能读系统语言
    addPreload(session.defaultSession);
    menus.refresh();
  });

  log(`started v${install.version || '?'} locale=${config.locale} effective=${effective}`);
  const api = { setLocale, getEffective: () => effective, payload, isAllowed, menus };
  if (process.env.AGY_I18N_DEBUG === '1') global.__agyI18nDebug = api;
  return api;
}

module.exports = { start, resolveSystemLocale };
