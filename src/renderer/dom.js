'use strict';
/**
 * DOM 翻译引擎（运行在 Antigravity 页面的隔离世界中）。
 *
 * - 只原地修改 Text 节点的 nodeValue 和少量白名单属性，绝不增删/包裹节点（React 安全）。
 * - 原文记录在 WeakMap 中，不往 DOM 写任何 data-* 痕迹；切回英文时逐节点还原。
 * - 代码、编辑器、终端、输入框、聊天正文（Markdown）、对话标题等区域整体跳过。
 * - 变更通过微任务批处理，在浏览器绘制前完成，首屏几乎看不到英文闪烁。
 */

// 整个子树都不翻译的区域
const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'template',
  'code', 'pre', 'kbd', 'samp', 'var',
  'textarea', 'input',
  '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
  '[data-lexical-editor="true"]',
  '.monaco-editor', '.monaco-diff-editor', '.xterm', '.cm-editor',
  // 聊天正文 / AI 回复 / 用户消息（Markdown 渲染区）
  '.prose', '.markdown', '.markdown-body', '[data-markdown-root]',
  '[data-testid="user-message-content"]',
  // 用户自己的数据：对话标题、面包屑、对话导航
  '[data-testid="conversation-row-sidebar"] a[href^="/c/"]',
  '[data-testid="conversation-row-sidebar"] .truncate',
  '[data-testid="conversation-row-history"] a[href^="/c/"]',
  '[data-testid="conversation-row-history"] .truncate',
  '[data-testid="conversation-navigator-turn"]',
  '[data-testid="breadcrumb-segment"]',
  // 模型名
  '[data-model-selector-badge]', '[data-testid="model-selector-item"]',
  // 本扩展自己的界面 & 显式退出标记
  '[data-agy-i18n]', '[translate="no"]', '.notranslate',
].join(',');

// "正文"语境：允许精确词条，但禁用自由文本模板，避免把句子开头的动词翻掉
const PROSE_SELECTOR = 'p, li, blockquote, td, th, dd, dt, figcaption, article';

const ATTRS = ['title', 'placeholder', 'aria-label', 'aria-description'];

// 用于"缺失词条收集"的 UI 控件语境
const UI_CONTROL_SELECTOR = 'button, label, h1, h2, h3, h4, h5, h6, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], summary, legend, th';

const adoptedSheets = new WeakMap(); // Document -> Map(id -> CSSStyleSheet)

/**
 * 插入/更新/删除一段 CSS。
 * 页面若有严格 CSP（禁止内联样式），<style> 会被阻止（sheet 为 null），
 * 此时改用可构造样式表（adoptedStyleSheets 不受 style-src 'unsafe-inline' 限制）。
 */
function upsertStyle(doc, id, css) {
  let el = doc.getElementById(id);
  const view = doc.defaultView;
  const map = adoptedSheets.get(doc);
  if (!css) {
    if (el) el.remove();
    if (map && map.has(id)) {
      const sh = map.get(id);
      map.delete(id);
      try {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sh);
      } catch (_) {
        /* ignore */
      }
    }
    return;
  }
  if (!el) {
    el = doc.createElement('style');
    el.id = id;
    el.setAttribute('data-agy-i18n', 'style');
  }
  if (el.textContent !== css) el.textContent = css;
  if (!el.isConnected) (doc.head || doc.documentElement).appendChild(el);
  if (!el.sheet && view && typeof view.CSSStyleSheet === 'function' && 'adoptedStyleSheets' in doc) {
    try {
      let m = map;
      if (!m) {
        m = new Map();
        adoptedSheets.set(doc, m);
      }
      let sh = m.get(id);
      if (!sh) {
        sh = new view.CSSStyleSheet();
        m.set(id, sh);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sh];
      }
      sh.replaceSync(css);
    } catch (_) {
      /* 两种方式都不可用时放弃样式（只是少了字体微调，不影响翻译） */
    }
  }
}

function createDomTranslator(win, opts) {
  const doc = win.document;
  const NodeFilter = win.NodeFilter;
  const options = Object.assign({ collect: false, onMissing: null }, opts || {});

  let matcher = null; // null = 英文（不翻译）
  const textRecords = new WeakMap(); // Text -> { orig, tr }
  const attrRecords = new WeakMap(); // Element -> Map(attr -> { orig, tr })
  const skipCache = new WeakMap(); // Element -> boolean
  const proseCache = new WeakMap(); // Element -> boolean
  const pending = new Set();
  const observed = new WeakSet();
  const observers = [];
  let scheduled = false;
  let selfMutating = 0;
  const missing = new Set();
  const listeners = new Set();
  const origLang = { value: null, captured: false };

  function isSkipped(el) {
    if (!el || el.nodeType !== 1) return false;
    let v = skipCache.get(el);
    if (v === undefined) {
      try {
        v = !!el.closest(SKIP_SELECTOR);
      } catch (_) {
        v = false;
      }
      skipCache.set(el, v);
    }
    return v;
  }

  function isProse(el) {
    if (!el) return false;
    let v = proseCache.get(el);
    if (v === undefined) {
      try {
        v = !!el.closest(PROSE_SELECTOR);
      } catch (_) {
        v = false;
      }
      proseCache.set(el, v);
    }
    return v;
  }

  function translateText(node) {
    const parent = node.parentElement;
    if (!parent || isSkipped(parent)) return;
    const value = node.nodeValue;
    const rec = textRecords.get(node);
    if (rec && value === rec.tr) return; // 已是译文
    if (!matcher) return;
    const tr = matcher.translate(value, { prose: isProse(parent) });
    if (tr != null && tr !== value) {
      textRecords.set(node, { orig: value, tr });
      selfMutating++;
      node.nodeValue = tr;
      selfMutating--;
    } else {
      if (rec) textRecords.delete(node);
      if (options.collect && tr == null) noteMissing(value, parent);
    }
  }

  function translateAttrs(el) {
    if (!matcher || isSkipped(el)) return;
    for (const name of ATTRS) {
      if (!el.hasAttribute(name)) continue;
      // 输入框的 placeholder 可以翻译，但输入框本身在 SKIP 中——单独放行
      const value = el.getAttribute(name);
      let recs = attrRecords.get(el);
      const rec = recs && recs.get(name);
      if (rec && value === rec.tr) continue;
      const tr = matcher.translate(value, { prose: false });
      if (tr != null && tr !== value) {
        if (!recs) {
          recs = new Map();
          attrRecords.set(el, recs);
        }
        recs.set(name, { orig: value, tr });
        selfMutating++;
        el.setAttribute(name, tr);
        selfMutating--;
      } else if (rec) {
        recs.delete(name);
      }
    }
  }

  function translatePlaceholder(el) {
    // 输入框/文本域本身被跳过，但它们的 placeholder 是 UI 文案
    if (!matcher) return;
    if (!el.hasAttribute('placeholder')) return;
    if (el.closest('[data-agy-i18n], .monaco-editor, .xterm')) return;
    const value = el.getAttribute('placeholder');
    let recs = attrRecords.get(el);
    const rec = recs && recs.get('placeholder');
    if (rec && value === rec.tr) return;
    const tr = matcher.translate(value, { prose: false });
    if (tr != null && tr !== value) {
      if (!recs) {
        recs = new Map();
        attrRecords.set(el, recs);
      }
      recs.set('placeholder', { orig: value, tr });
      selfMutating++;
      el.setAttribute('placeholder', tr);
      selfMutating--;
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      translateText(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (isSkipped(root)) {
        if (root.matches && root.matches('input, textarea')) translatePlaceholder(root);
        // 跳过区域里仍可能有输入框 placeholder
        if (root.querySelectorAll) root.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(translatePlaceholder);
        return;
      }
      translateAttrs(root);
    }
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (isSkipped(n)) {
            if (n.matches('input, textarea')) translatePlaceholder(n);
            else if (n.querySelectorAll) n.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(translatePlaceholder);
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n = tw.nextNode();
    while (n) {
      if (n.nodeType === 3) translateText(n);
      else {
        translateAttrs(n);
        if (n.tagName === 'IFRAME') attachFrame(n);
      }
      n = tw.nextNode();
    }
  }

  function schedule(node) {
    pending.add(node);
    if (scheduled) return;
    scheduled = true;
    // 微任务：在本轮渲染前完成翻译
    Promise.resolve().then(flush);
  }

  function flush() {
    scheduled = false;
    const nodes = Array.from(pending);
    pending.clear();
    for (const n of nodes) {
      if (!n.isConnected) continue;
      walk(n);
    }
    if (nodes.length) emit('flush');
  }

  function onMutations(records) {
    if (selfMutating) return;
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach((n) => {
          if (n.nodeType === 1) {
            // 元素可能被移动进/出跳过区域，清缓存
            invalidate(n);
          }
          schedule(n);
        });
      } else if (r.type === 'characterData') {
        const rec = textRecords.get(r.target);
        if (rec && r.target.nodeValue === rec.tr) continue;
        schedule(r.target);
      } else if (r.type === 'attributes') {
        const el = r.target;
        const recs = attrRecords.get(el);
        const rec = recs && recs.get(r.attributeName);
        if (rec && el.getAttribute(r.attributeName) === rec.tr) continue;
        if (r.attributeName === 'placeholder' && el.matches && el.matches('input, textarea')) {
          translatePlaceholder(el);
        } else {
          translateAttrs(el);
        }
      }
    }
  }

  function invalidate(el) {
    skipCache.delete(el);
    proseCache.delete(el);
  }

  function observe(target) {
    if (!target || observed.has(target)) return;
    observed.add(target);
    const mo = new win.MutationObserver(onMutations);
    mo.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    observers.push(mo);
  }

  function attachFrame(iframe) {
    // 同源 iframe（如部分设置面板）也纳入翻译；跨源的访问会抛异常，直接忽略
    const tryAttach = () => {
      try {
        const d = iframe.contentDocument;
        if (!d || !d.documentElement) return;
        const sub = iframe.__agyI18n || createDomTranslator(iframe.contentWindow, options);
        iframe.__agyI18n = sub;
        sub.setMatcher(matcher);
        frames.add(sub);
      } catch (_) {
        /* 跨源 */
      }
    };
    tryAttach();
    iframe.addEventListener('load', tryAttach);
  }
  const frames = new Set();

  function restoreAll() {
    const root = doc.documentElement;
    if (!root) return;
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = tw.currentNode;
    selfMutating++;
    try {
      while (n) {
        if (n.nodeType === 3) {
          const rec = textRecords.get(n);
          if (rec) {
            if (n.nodeValue === rec.tr) n.nodeValue = rec.orig;
            textRecords.delete(n);
          }
        } else if (n.nodeType === 1) {
          const recs = attrRecords.get(n);
          if (recs) {
            for (const [name, rec] of recs) {
              if (n.getAttribute(name) === rec.tr) n.setAttribute(name, rec.orig);
            }
            attrRecords.delete(n);
          }
        }
        n = tw.nextNode();
      }
    } finally {
      selfMutating--;
    }
  }

  function applyLang() {
    const html = doc.documentElement;
    if (!html) return;
    if (!origLang.captured) {
      origLang.value = html.getAttribute('lang');
      origLang.captured = true;
    }
    const want = matcher && matcher.meta.htmlLang;
    selfMutating++;
    if (want) html.setAttribute('lang', want);
    else if (origLang.value == null) html.removeAttribute('lang');
    else html.setAttribute('lang', origLang.value);
    selfMutating--;
    applyFont();
  }

  let baseFont = null; // 页面原始字体栈（首次读取后缓存，避免读到我们自己追加的结果）

  function applyFont() {
    // 中文字形回退：拉丁字母仍用 Antigravity 原生字体，汉字落到系统 UI 中文字体
    const fonts = matcher && Array.isArray(matcher.meta.fontFallback) ? matcher.meta.fontFallback : null;
    if (!fonts || !fonts.length || !doc.body) {
      upsertStyle(doc, 'agy-i18n-font', null);
      upsertStyle(doc, 'agy-i18n-font-stack', null);
      return;
    }
    const lang = matcher.meta.htmlLang;
    const quoted = fonts.map((f) => (/^[\w-]+$/.test(f) ? f : JSON.stringify(f))).join(', ');
    // 不覆盖原字体：通过 @font-face 的 unicode-range 只接管 CJK 区段
    const ranges = 'U+2E80-2FDF, U+3000-303F, U+3040-30FF, U+3100-312F, U+3190-31FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF';
    const faces = fonts
      .map((f) => `@font-face{font-family:"agy-i18n-cjk";src:local(${JSON.stringify(f)});unicode-range:${ranges};}`)
      .join('');
    upsertStyle(doc, 'agy-i18n-font', `${faces}\n:root:lang(${lang}){--agy-i18n-cjk:"agy-i18n-cjk", ${quoted};}`);

    // 把 CJK 字体追加到页面根字体栈末尾（只追加，不替换原有字体）
    if (baseFont === null) {
      try {
        baseFont = win.getComputedStyle(doc.body).fontFamily || '';
      } catch (_) {
        baseFont = '';
      }
    }
    if (!baseFont || baseFont.includes('agy-i18n-cjk')) return;
    upsertStyle(doc, 'agy-i18n-font-stack', `:root:lang(${lang}) body{font-family:${baseFont}, var(--agy-i18n-cjk), sans-serif;}`);
  }

  function noteMissing(value, parent) {
    const t = value.trim();
    if (t.length < 2 || t.length > 120 || !/[A-Za-z]{2}/.test(t)) return;
    if (/[\\/]|https?:|@|\.\w{1,5}$/.test(t)) return; // 路径、链接、邮箱、文件名
    if (!parent.closest(UI_CONTROL_SELECTOR) && !parent.closest('[class*="settings"], [class*="Settings"]')) return;
    if (isProse(parent)) return;
    if (missing.size >= 2000 || missing.has(t)) return;
    missing.add(t);
    if (options.onMissing) options.onMissing(t);
  }

  function emit(ev) {
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function start() {
    const begin = () => {
      observe(doc.documentElement || doc);
      if (doc.documentElement) walk(doc.documentElement);
      applyLang();
    };
    if (doc.documentElement) begin();
    else {
      const mo = new win.MutationObserver(() => {
        if (doc.documentElement) {
          mo.disconnect();
          begin();
        }
      });
      mo.observe(doc, { childList: true });
    }
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', () => {
        if (doc.body) walk(doc.body);
        applyLang();
      });
    }
  }

  function setMatcher(next) {
    const prev = matcher;
    if (prev === next) return;
    if (prev) restoreAll();
    matcher = next;
    for (const f of frames) f.setMatcher(next);
    if (doc.documentElement) {
      walk(doc.documentElement);
      applyLang();
    }
    emit('locale');
  }

  function originalText(el) {
    // 读取元素"英文原文"（无论当前是否已被翻译）
    if (!el) return '';
    const tw = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = '';
    let n = tw.nextNode();
    while (n) {
      const rec = textRecords.get(n);
      out += rec && n.nodeValue === rec.tr ? rec.orig : n.nodeValue;
      n = tw.nextNode();
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function stop() {
    observers.forEach((o) => o.disconnect());
    observers.length = 0;
  }

  return {
    start,
    stop,
    setMatcher,
    getMatcher: () => matcher,
    originalText,
    translateNow: () => flush(),
    on: (fn) => listeners.add(fn),
    takeMissing() {
      const list = Array.from(missing);
      missing.clear();
      return list;
    },
    // 供测试使用
    _walk: walk,
  };
}

module.exports = { createDomTranslator, upsertStyle, SKIP_SELECTOR, PROSE_SELECTOR };
