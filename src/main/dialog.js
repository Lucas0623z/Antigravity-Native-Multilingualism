'use strict';
/** 原生对话框汉化：只翻译显示文字，按钮顺序与返回值完全不变。 */

function installDialogHooks(electron, getTranslate, log) {
  const { dialog } = electron;
  if (!dialog || dialog.__agyI18nHooked) return;
  dialog.__agyI18nHooked = true;

  const tr = (s) => {
    const t = getTranslate();
    if (!t || typeof s !== 'string' || !s) return s;
    const out = t(s);
    return out == null ? s : out;
  };

  function mapOptions(opts) {
    if (!opts || typeof opts !== 'object' || !getTranslate()) return opts;
    try {
      const o = Object.assign({}, opts);
      for (const k of ['title', 'message', 'detail', 'checkboxLabel', 'buttonLabel', 'nameFieldLabel']) {
        if (typeof o[k] === 'string') o[k] = tr(o[k]);
      }
      if (Array.isArray(o.buttons)) o.buttons = o.buttons.map(tr);
      if (Array.isArray(o.filters)) o.filters = o.filters.map((f) => (f && typeof f.name === 'string' ? Object.assign({}, f, { name: tr(f.name) }) : f));
      return o;
    } catch (e) {
      log('dialog translate failed', e);
      return opts;
    }
  }

  // (window?, options) 两种调用形式
  function wrap(name) {
    const orig = dialog[name];
    if (typeof orig !== 'function') return;
    dialog[name] = function wrapped(a, b) {
      const hasWindow = b !== undefined || (a && typeof a === 'object' && typeof a.isDestroyed === 'function');
      if (hasWindow) return orig.call(dialog, a, mapOptions(b));
      return orig.call(dialog, mapOptions(a));
    };
  }

  ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync'].forEach(wrap);

  const origErr = dialog.showErrorBox;
  if (typeof origErr === 'function') {
    dialog.showErrorBox = function showErrorBox(title, content) {
      return origErr.call(dialog, tr(title), tr(content));
    };
  }
}

module.exports = { installDialogHooks };
