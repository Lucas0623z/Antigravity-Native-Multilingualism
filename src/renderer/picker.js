'use strict';
/**
 * 设置 → 外观（Appearance）里的"显示语言"下拉框。
 *
 * 与其它方案"手写一套长得像的 UI"不同，这里直接克隆 Antigravity 自己的下拉行
 * （优先"Theme"行，否则任何一个原生下拉行），所以字体、字号、间距、颜色、圆角、
 * 箭头图标、悬停态、深浅色主题都和原生完全一致，Antigravity 改样式也会自动跟随。
 *
 * 弹出列表则"学习"原生下拉弹层：用户第一次打开任意原生下拉框时，记录它的
 * listbox / option 的 class，此后我们的弹层直接复用这些 class。
 */

const ROW_ATTR = 'data-agy-i18n';
const POPOVER_STYLE_KEY = 'agy-i18n:native-popover';

function createPicker(win, deps) {
  const doc = win.document;
  const dom = deps.dom; // createDomTranslator 实例
  if (!deps.upsertStyle) deps.upsertStyle = require('./dom.js').upsertStyle;
  const state = {
    locales: [], // [{ code, name }]
    current: 'en',
    labels: { title: 'Display Language', description: 'Choose the language of the Antigravity interface.' },
    onSelect: deps.onSelect || (() => {}),
    popover: null,
  };
  let learned = loadLearned();
  let scheduled = false;

  // ---------- 学习原生弹层样式 ----------
  function loadLearned() {
    try {
      const raw = win.localStorage.getItem(POPOVER_STYLE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function learnFrom(listbox) {
    try {
      if (!listbox || listbox.closest(`[${ROW_ATTR}]`)) return;
      const option = listbox.querySelector('[role="option"]');
      if (!option) return;
      const selected = listbox.querySelector('[role="option"][aria-selected="true"], [role="option"][data-state="checked"]');
      let indicator = null;
      if (selected) {
        const svg = selected.querySelector('svg');
        if (svg && svg.querySelectorAll('script, foreignObject').length === 0) {
          const wrap = svg.parentElement !== selected ? svg.parentElement : null;
          indicator = {
            wrapClass: wrap ? String(wrap.getAttribute('class') || '') : '',
            svg: svg.outerHTML.replace(/\son\w+="[^"]*"/gi, ''),
          };
        }
      }
      const panel = listbox.closest('[data-radix-popper-content-wrapper]') ? listbox : listbox;
      const data = {
        listClass: String(panel.getAttribute('class') || ''),
        optionClass: String(option.getAttribute('class') || ''),
        indicator,
        v: 1,
      };
      if (!data.optionClass && !data.listClass) return;
      learned = data;
      try {
        win.localStorage.setItem(POPOVER_STYLE_KEY, JSON.stringify(data));
      } catch (_) {
        /* 存储不可用时只在本次会话生效 */
      }
    } catch (_) {
      /* ignore */
    }
  }

  // ---------- 找到设置页"外观"卡片与模板行 ----------
  function findAppearance() {
    const headings = doc.querySelectorAll('h1, h2, h3, h4, [role="heading"]');
    for (const h of headings) {
      if (h.closest(`[${ROW_ATTR}]`)) continue;
      if (dom.originalText(h) !== 'Appearance') continue;
      // 从标题向上找，直到容器里出现一行带"控件"的设置行
      let box = h.parentElement;
      for (let i = 0; box && i < 6; i++, box = box.parentElement) {
        const rows = findRows(box);
        if (rows.length) return { heading: h, container: box, rows };
      }
    }
    return null;
  }

  const CONTROL_SEL = 'select, [role="combobox"], button[aria-haspopup], [role="radiogroup"], [role="switch"], input[type="checkbox"], [role="slider"], input[type="range"]';
  const DROPDOWN_SEL = 'select, [role="combobox"], button[aria-haspopup="listbox"], button[aria-haspopup="menu"], button[aria-haspopup="true"]';

  /** 在容器中找"设置行"：含一个标题文本 + 一个控件、且与兄弟元素并列的元素 */
  function findRows(container) {
    const controls = container.querySelectorAll(CONTROL_SEL);
    const rows = [];
    for (const c of controls) {
      if (c.closest(`[${ROW_ATTR}]`)) continue;
      let row = c;
      while (row.parentElement && row.parentElement !== container) {
        const p = row.parentElement;
        // 父元素有多个"行"子元素时停止：row 就是一行
        if (p.children.length >= 2 && Array.from(p.children).filter((ch) => ch.querySelector(CONTROL_SEL) || ch.matches(CONTROL_SEL)).length >= 2) break;
        row = p;
      }
      if (row === c) continue;
      const label = labelOf(row, c);
      if (!label) continue;
      if (!rows.some((r) => r.row === row)) rows.push({ row, control: c, label, text: dom.originalText(label) });
    }
    return rows;
  }

  function labelOf(row, control) {
    const tw = doc.createTreeWalker(row, win.NodeFilter.SHOW_TEXT);
    let n = tw.nextNode();
    while (n) {
      if (n.nodeValue.trim() && !control.contains(n)) return n.parentElement;
      n = tw.nextNode();
    }
    return null;
  }

  // 实测 Antigravity 2.35：外观卡片里"主题"是一排图标按钮，真正的原生下拉组件是"字体"和"字号"
  const PREFERRED_TEMPLATES = ['Font', 'Font size', 'Font Size', 'Theme'];

  function findDropdownTemplate(appearance) {
    const isDropdown = (r) => r.control.matches(DROPDOWN_SEL);
    for (const name of PREFERRED_TEMPLATES) {
      const hit = appearance.rows.find((r) => r.text === name && isDropdown(r));
      if (hit) return hit;
    }
    const local = appearance.rows.find(isDropdown);
    if (local) return local;
    // 外观卡片里没有下拉行：去整个设置页找一个
    const all = findRows(doc.body).filter(isDropdown);
    return all[0] || null;
  }

  // ---------- 构建行 ----------
  function pathTo(root, node) {
    const path = [];
    let cur = node;
    while (cur && cur !== root) {
      const parent = cur.parentNode;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, cur));
      cur = parent;
    }
    return path;
  }

  function follow(root, path) {
    let cur = root;
    for (const i of path) {
      if (!cur) return null;
      cur = cur.childNodes[i];
    }
    return cur;
  }

  function sanitizeClone(el) {
    const strip = ['id', 'for', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant', 'data-state', 'data-radix-collection-item', 'name', 'form'];
    const all = [el, ...el.querySelectorAll('*')];
    for (const n of all) {
      for (const a of strip) n.removeAttribute(a);
      // React 内部属性不在 attributes 里，cloneNode 不会复制事件处理器
    }
  }

  function buildRow(tpl, appearance) {
    const row = tpl.row.cloneNode(true);
    sanitizeClone(row);
    row.setAttribute(ROW_ATTR, 'language-row');
    const labelPath = pathTo(tpl.row, tpl.label);
    const controlPath = pathTo(tpl.row, tpl.control);
    const label = follow(row, labelPath);
    const control = follow(row, controlPath);
    if (!label || !control) return null;

    label.textContent = state.labels.title;
    // 描述文字：模板行里标题之外、控件之外的第二段文字
    const desc = findDescription(row, label, control);
    if (desc) desc.textContent = state.labels.description;

    let api;
    if (control.tagName === 'SELECT') api = bindNativeSelect(control);
    else api = bindTrigger(control);
    if (!api) return null;
    row.__agyApi = api;
    row.__agyPlacedAfter = tpl.row.parentElement === appearance.rows[0].row.parentElement ? null : undefined;
    return row;
  }

  function findDescription(row, label, control) {
    const tw = doc.createTreeWalker(row, win.NodeFilter.SHOW_TEXT);
    let n = tw.nextNode();
    while (n) {
      const p = n.parentElement;
      if (n.nodeValue.trim() && p !== label && !label.contains(p) && !control.contains(n)) return p;
      n = tw.nextNode();
    }
    return null;
  }

  function bindNativeSelect(select) {
    select.disabled = false;
    const render = () => {
      select.textContent = '';
      for (const l of state.locales) {
        const o = doc.createElement('option');
        o.value = l.code;
        o.textContent = l.name;
        if (l.code === state.current) o.selected = true;
        select.appendChild(o);
      }
      select.setAttribute('aria-label', state.labels.title);
    };
    select.addEventListener('change', () => choose(select.value));
    render();
    return { render };
  }

  function bindTrigger(trigger) {
    // 触发按钮里的"当前值"文本节点：第一个非空文本
    const tw = doc.createTreeWalker(trigger, win.NodeFilter.SHOW_TEXT);
    let valueNode = null;
    let n = tw.nextNode();
    while (n) {
      if (n.nodeValue.trim()) {
        valueNode = n;
        break;
      }
      n = tw.nextNode();
    }
    if (!valueNode) {
      valueNode = doc.createTextNode('');
      trigger.insertBefore(valueNode, trigger.firstChild);
    }
    // 清掉同一触发器内其它文本（如模板里的多段文字），保留图标
    let m = tw.nextNode();
    while (m) {
      const next = tw.nextNode();
      if (m.nodeValue.trim()) m.nodeValue = '';
      m = next;
    }
    trigger.removeAttribute('disabled');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (trigger.tagName === 'BUTTON') trigger.type = 'button';
    trigger.setAttribute('aria-label', state.labels.title);

    const render = () => {
      const cur = state.locales.find((l) => l.code === state.current) || state.locales[0];
      valueNode.nodeValue = cur ? cur.name : '';
      trigger.setAttribute('aria-label', state.labels.title);
    };
    trigger.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.popover) closePopover();
      else openPopover(trigger);
    });
    trigger.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        ev.stopPropagation();
        if (!state.popover) openPopover(trigger);
      }
    });
    render();
    return { render };
  }

  // ---------- 弹出列表 ----------
  function openPopover(trigger) {
    closePopover();
    const pop = doc.createElement('div');
    pop.setAttribute(ROW_ATTR, 'language-popover');
    pop.setAttribute('role', 'listbox');
    pop.setAttribute('aria-label', state.labels.title);
    pop.tabIndex = -1;
    const fallbackList = 'agy-i18n-popover';
    pop.className = learned && learned.listClass ? learned.listClass : fallbackList;
    // 定位只用最少的内联样式，外观交给原生 class / 主题变量
    Object.assign(pop.style, { position: 'fixed', zIndex: '2147483646', maxHeight: '320px', overflowY: 'auto' });
    if (!learned) pop.classList.add(fallbackList);
    ensureFallbackCss();

    const items = [];
    for (const l of state.locales) {
      const item = doc.createElement('div');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(l.code === state.current));
      item.setAttribute('data-state', l.code === state.current ? 'checked' : 'unchecked');
      item.tabIndex = -1;
      item.className = learned && learned.optionClass ? learned.optionClass : 'agy-i18n-option';
      const label = doc.createElement('span');
      label.textContent = l.name;
      item.appendChild(label);
      if (l.code === state.current) item.appendChild(checkMark());
      item.addEventListener('mouseenter', () => focusItem(items.indexOf(item)));
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closePopover(true);
        choose(l.code);
      });
      item.dataset.code = l.code;
      items.push(item);
      pop.appendChild(item);
    }

    let active = Math.max(0, state.locales.findIndex((l) => l.code === state.current));
    function focusItem(i) {
      if (i < 0 || i >= items.length) return;
      items.forEach((it, idx) => {
        it.toggleAttribute('data-highlighted', idx === i);
        if (idx === i) it.setAttribute('data-highlighted', '');
      });
      active = i;
      items[i].focus({ preventScroll: true });
    }

    pop.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') focusItem(Math.min(items.length - 1, active + 1));
      else if (ev.key === 'ArrowUp') focusItem(Math.max(0, active - 1));
      else if (ev.key === 'Home') focusItem(0);
      else if (ev.key === 'End') focusItem(items.length - 1);
      else if (ev.key === 'Enter' || ev.key === ' ') {
        const code = items[active] && items[active].dataset.code;
        closePopover(true);
        if (code) choose(code);
      } else if (ev.key === 'Escape' || ev.key === 'Tab') closePopover(true);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    });

    doc.body.appendChild(pop);
    position(pop, trigger);
    trigger.setAttribute('aria-expanded', 'true');
    const onOutside = (ev) => {
      if (!pop.contains(ev.target) && !trigger.contains(ev.target)) closePopover();
    };
    const onReflow = () => closePopover();
    doc.addEventListener('pointerdown', onOutside, true);
    win.addEventListener('resize', onReflow);
    win.addEventListener('blur', onReflow);
    doc.addEventListener('scroll', onReflow, true);
    state.popover = {
      pop,
      trigger,
      cleanup() {
        doc.removeEventListener('pointerdown', onOutside, true);
        win.removeEventListener('resize', onReflow);
        win.removeEventListener('blur', onReflow);
        doc.removeEventListener('scroll', onReflow, true);
      },
    };
    focusItem(active);
  }

  function checkMark() {
    if (learned && learned.indicator && learned.indicator.svg) {
      const tpl = doc.createElement('template');
      tpl.innerHTML = learned.indicator.svg;
      const svg = tpl.content.firstElementChild;
      if (svg && svg.tagName.toLowerCase() === 'svg') {
        if (learned.indicator.wrapClass) {
          const wrap = doc.createElement('span');
          wrap.className = learned.indicator.wrapClass;
          wrap.appendChild(svg);
          return wrap;
        }
        return svg;
      }
    }
    const span = doc.createElement('span');
    span.className = 'agy-i18n-check';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = '✓';
    return span;
  }

  function position(pop, trigger) {
    const r = trigger.getBoundingClientRect();
    const width = Math.max(r.width, 180);
    pop.style.minWidth = `${width}px`;
    const ph = pop.offsetHeight || 0;
    const below = win.innerHeight - r.bottom;
    const top = below >= ph + 8 || below >= r.top ? r.bottom + 4 : Math.max(8, r.top - ph - 4);
    let left = r.right - Math.max(width, pop.offsetWidth || width);
    left = Math.max(8, Math.min(left, win.innerWidth - (pop.offsetWidth || width) - 8));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }

  function closePopover(restoreFocus) {
    const p = state.popover;
    if (!p) return;
    state.popover = null;
    p.cleanup();
    p.pop.remove();
    p.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) p.trigger.focus({ preventScroll: true });
  }

  function ensureFallbackCss() {
    // 仅在尚未学到原生样式时生效；全部取自 Antigravity 的主题变量
    deps.upsertStyle(doc, 'agy-i18n-picker-css', [
      '.agy-i18n-popover{background:var(--popover, var(--background));color:var(--popover-foreground, var(--foreground));border:1px solid var(--border);border-radius:var(--radius, 8px);padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.24);font:inherit;}',
      '.agy-i18n-option{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 8px;border-radius:calc(var(--radius, 8px) - 2px);cursor:default;outline:none;font:inherit;font-size:.875rem;}',
      '.agy-i18n-option[data-highlighted],.agy-i18n-option:hover{background:var(--accent, rgba(127,127,127,.16));color:var(--accent-foreground, inherit);}',
      '.agy-i18n-check{opacity:.8}',
    ].join('\n'));
  }

  function choose(code) {
    if (!code || code === state.current) return;
    state.onSelect(code);
  }

  // ---------- 维护 ----------
  function ensure() {
    scheduled = false;
    if (!state.locales.length || !doc.body) return;
    const existing = doc.querySelector(`[${ROW_ATTR}="language-row"]`);
    const appearance = findAppearance();
    if (!appearance) {
      if (existing && !existing.isConnected) closePopover();
      return;
    }
    if (existing && appearance.container.contains(existing)) {
      existing.__agyApi && existing.__agyApi.render();
      return;
    }
    if (existing) existing.remove();
    const tpl = findDropdownTemplate(appearance);
    if (!tpl) return;
    const row = buildRow(tpl, appearance);
    if (!row) return;
    // 放在外观卡片的第一行（主题之前），与原生行同一父容器
    const first = appearance.rows[0].row;
    first.parentElement.insertBefore(row, first);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    win.requestAnimationFrame ? win.requestAnimationFrame(ensure) : setTimeout(ensure, 16);
  }

  function watch() {
    const mo = new win.MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches('[role="listbox"]')) learnFrom(n);
          else if (n.querySelector) {
            const lb = n.querySelector('[role="listbox"]');
            if (lb) learnFrom(lb);
          }
        }
      }
      schedule();
    });
    const start = () => mo.observe(doc.body, { childList: true, subtree: true });
    if (doc.body) start();
    else doc.addEventListener('DOMContentLoaded', start);
    dom.on((ev) => {
      if (ev === 'locale') {
        const row = doc.querySelector(`[${ROW_ATTR}="language-row"]`);
        if (row) row.remove();
        schedule();
      }
    });
    schedule();
  }

  return {
    watch,
    ensure,
    update({ locales, current, labels }) {
      if (locales) state.locales = locales;
      if (current) state.current = current;
      if (labels) state.labels = Object.assign({}, state.labels, labels);
      closePopover();
      const row = doc.querySelector(`[${ROW_ATTR}="language-row"]`);
      if (row) row.remove();
      schedule();
    },
    _learnFrom: learnFrom,
    _state: state,
  };
}

module.exports = { createPicker };
