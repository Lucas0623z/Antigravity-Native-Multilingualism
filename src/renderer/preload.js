'use strict';
/**
 * 会话级 preload：由主进程用 session.registerPreloadScript / setPreloads 注册，
 * 在 Antigravity 每个页面加载前、于隔离世界中运行。
 *
 * - 不暴露任何对象给页面（不使用 contextBridge），页面脚本无法调用我们。
 * - 是否启用、用哪种语言，完全由主进程根据 webContents 类型与来源决定；
 *   内置浏览器（webview）和外部网页收到 enabled:false，什么都不做。
 *
 * 构建时 tools/build.js 会把本文件与 shared/matcher.js、renderer/dom.js、
 * renderer/picker.js 打包成单文件（沙盒 preload 不能 require 本地文件）。
 */
const { ipcRenderer } = require('electron');
const { Matcher } = require('../shared/matcher.js');
const { createDomTranslator } = require('./dom.js');
const { createPicker } = require('./picker.js');

(function main() {
  let init;
  try {
    init = ipcRenderer.sendSync('agy-i18n:init', { href: String(location.href) });
  } catch (_) {
    return;
  }
  if (!init || !init.enabled) return;

  const matcherCache = new Map();
  const toMatcher = (locale) => {
    if (!locale) return null;
    const code = locale.meta && locale.meta.code;
    if (code && matcherCache.has(code)) return matcherCache.get(code);
    const m = new Matcher(locale);
    if (code) matcherCache.set(code, m);
    return m;
  };

  const missingQueue = [];
  let missingTimer = null;
  const dom = createDomTranslator(window, {
    collect: !!init.collectMissing,
    onMissing(text) {
      missingQueue.push(text);
      if (!missingTimer) {
        missingTimer = setTimeout(() => {
          missingTimer = null;
          ipcRenderer.send('agy-i18n:missing', missingQueue.splice(0, missingQueue.length));
        }, 10000);
      }
    },
  });
  dom.setMatcher(toMatcher(init.locale));
  dom.start();

  let picker = null;
  if (init.picker) {
    picker = createPicker(window, {
      dom,
      onSelect(code) {
        ipcRenderer.send('agy-i18n:set-locale', code);
      },
    });
    picker.update({ locales: init.locales, current: init.current, labels: init.labels });
    picker.watch();
  }

  ipcRenderer.on('agy-i18n:locale', (_ev, next) => {
    if (!next) return;
    dom.setMatcher(toMatcher(next.locale));
    if (picker) picker.update({ locales: next.locales, current: next.current, labels: next.labels });
  });
})();
