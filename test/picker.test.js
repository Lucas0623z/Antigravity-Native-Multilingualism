'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Matcher } = require('../src/shared/matcher.js');
const { createDomTranslator } = require('../src/renderer/dom.js');
const { createPicker } = require('../src/renderer/picker.js');
const { makeDom, tick } = require('./fixtures.js');
const zhData = require('../locales/zh-CN.json');
const zh = new Matcher(zhData);

const LOCALES = [
  { code: 'system', name: '跟随系统 (简体中文)' },
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
];
const LABELS = { title: '显示语言', description: 'Antigravity 界面使用的语言，切换后立即生效。' };

async function setup(html) {
  const jsdom = makeDom(html);
  const win = jsdom.window;
  const dom = createDomTranslator(win);
  dom.setMatcher(zh);
  dom.start();
  const chosen = [];
  const picker = createPicker(win, { dom, onSelect: (c) => chosen.push(c) });
  picker.update({ locales: LOCALES, current: 'zh-CN', labels: LABELS });
  picker.watch();
  await tick(50);
  return { win, doc: win.document, dom, picker, chosen };
}

test('在 外观 卡片第一行插入"显示语言"，完全克隆原生 Theme 行的结构与 class', async () => {
  const { doc } = await setup();
  const card = doc.getElementById('appearance-card');
  const row = card.firstElementChild;
  assert.strictEqual(row.getAttribute('data-agy-i18n'), 'language-row');
  const themeRow = row.nextElementSibling;
  assert.strictEqual(row.className, themeRow.className, '行 class 与原生一致');
  const trig = row.querySelector('[role="combobox"]');
  const nativeTrig = themeRow.querySelector('[role="combobox"]');
  assert.strictEqual(trig.className, nativeTrig.className, '下拉按钮 class 与原生一致');
  assert.ok(trig.querySelector('svg path'), '保留原生箭头图标');
  assert.strictEqual(row.querySelector('span').textContent, '显示语言');
  assert.strictEqual(row.querySelector('.text-muted-foreground').textContent, LABELS.description);
  assert.strictEqual(trig.querySelector('.truncate').textContent, '简体中文');
  // 原生 Theme 行已被翻译，但模板识别靠英文原文
  assert.strictEqual(themeRow.querySelector('span').textContent, '主题');
});

test('克隆行不带 React 的 id / aria-controls / data-state，避免与原生控件冲突', async () => {
  const { doc } = await setup();
  const row = doc.querySelector('[data-agy-i18n="language-row"]');
  for (const el of [row, ...row.querySelectorAll('*')]) {
    assert.ok(!el.id, 'id 必须移除');
    assert.ok(!el.hasAttribute('aria-controls'));
    assert.ok(!el.hasAttribute('data-state'));
  }
  assert.strictEqual(doc.querySelectorAll('#radix-1').length, 1);
});

test('点击打开列表、键盘选择、点击选择', async () => {
  const { doc, win, chosen } = await setup();
  const trig = doc.querySelector('[data-agy-i18n="language-row"] [role="combobox"]');
  trig.click();
  const pop = doc.querySelector('[data-agy-i18n="language-popover"]');
  assert.ok(pop, '弹出列表');
  assert.strictEqual(pop.getAttribute('role'), 'listbox');
  assert.strictEqual(trig.getAttribute('aria-expanded'), 'true');
  const opts = pop.querySelectorAll('[role="option"]');
  assert.deepStrictEqual(Array.from(opts).map((o) => o.textContent.replace('✓', '')), LOCALES.map((l) => l.name));
  assert.strictEqual(pop.querySelector('[aria-selected="true"]').dataset.code, 'zh-CN');
  // 键盘：向上一项 → English，回车
  pop.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  pop.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepStrictEqual(chosen, ['en']);
  assert.strictEqual(doc.querySelector('[data-agy-i18n="language-popover"]'), null, '选择后关闭');
  // 点击
  trig.click();
  doc.querySelector('[data-agy-i18n="language-popover"] [data-code="system"]').click();
  assert.deepStrictEqual(chosen, ['en', 'system']);
});

test('Esc / 点击外部关闭列表', async () => {
  const { doc, win } = await setup();
  const trig = doc.querySelector('[data-agy-i18n="language-row"] [role="combobox"]');
  trig.click();
  const pop = doc.querySelector('[data-agy-i18n="language-popover"]');
  pop.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(doc.querySelector('[data-agy-i18n="language-popover"]'), null);
  trig.click();
  doc.body.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
  assert.strictEqual(doc.querySelector('[data-agy-i18n="language-popover"]'), null);
});

test('学习原生下拉弹层的 class 与勾选图标，之后直接复用', async () => {
  const { doc } = await setup();
  // 用户打开了某个原生下拉框：Radix 在 body 末尾渲染 listbox
  const native = doc.createElement('div');
  native.innerHTML = '<div data-radix-popper-content-wrapper><div role="listbox" class="native-list bg-popover rounded-md"><div role="option" class="native-option px-2" aria-selected="true" data-state="checked"><span>Dark</span><span class="native-ind"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span></div><div role="option" class="native-option px-2"><span>Light</span></div></div></div>';
  doc.body.appendChild(native);
  await tick(30);
  native.remove();
  const trig = doc.querySelector('[data-agy-i18n="language-row"] [role="combobox"]');
  trig.click();
  const pop = doc.querySelector('[data-agy-i18n="language-popover"]');
  assert.strictEqual(pop.className, 'native-list bg-popover rounded-md');
  const sel = pop.querySelector('[aria-selected="true"]');
  assert.strictEqual(sel.className, 'native-option px-2');
  assert.ok(sel.querySelector('.native-ind svg path'), '复用原生勾选图标');
});

test('React 重新渲染设置页后自动恢复语言行', async () => {
  const { doc } = await setup();
  doc.querySelector('[data-agy-i18n="language-row"]').remove();
  await tick(50);
  assert.ok(doc.querySelector('#appearance-card > [data-agy-i18n="language-row"]'));
  assert.strictEqual(doc.querySelectorAll('[data-agy-i18n="language-row"]').length, 1);
});

test('切换语言后行内文字随之更新', async () => {
  const { doc, picker } = await setup();
  picker.update({ current: 'en', labels: { title: 'Display Language', description: 'Choose the language' } });
  await tick(50);
  const row = doc.querySelector('[data-agy-i18n="language-row"]');
  assert.strictEqual(row.querySelector('span').textContent, 'Display Language');
  assert.strictEqual(row.querySelector('[role="combobox"] .truncate').textContent, 'English');
});

test('外观卡片没有下拉行时，借用设置页其它原生下拉行作为模板', async () => {
  const { selectRow } = require('./fixtures.js');
  const html = `<!doctype html><body>
    <div class="space-y-2"><h3>Appearance</h3><div class="agy-card" id="appearance-card">
      <div class="row"><div><span>Theme</span></div><div role="radiogroup"><button role="radio">Light</button><button role="radio">Dark</button></div></div>
      <div class="row"><div><span>Compact</span></div><button role="switch"></button></div>
    </div></div>
    <div class="space-y-2"><h3>Editor</h3><div class="agy-card">${selectRow('Font', 'Editor font', 'Default', 9)}${selectRow('Tab size', 'Spaces', '2', 10)}</div></div>
  </body>`;
  const { doc } = await setup(html);
  const row = doc.querySelector('#appearance-card > [data-agy-i18n="language-row"]');
  assert.ok(row, '已插入');
  assert.ok(row.querySelector('[role="combobox"]'));
  assert.strictEqual(row.querySelector('[role="combobox"] .truncate').textContent, '简体中文');
});

test('实测结构：主题是图标按钮组 → 克隆"字体"下拉行，而不是主题行', async () => {
  const { selectRow } = require('./settings-page.js');
  const html = `<!doctype html><body><div class="space-y-2"><h3>Appearance</h3><div class="agy-card" id="appearance-card">
      <div class="py-2 px-3 theme-row"><div><span>Theme</span></div><div class="flex gap-1"><button aria-label="Light"><svg></svg></button><button aria-label="Dark"><svg></svg></button><button aria-label="System"><svg></svg></button></div></div>
      ${selectRow('Font', 'Interface font', 'Inter', 3)}
      ${selectRow('Font size', 'Interface text size', '14', 4)}
    </div></div></body>`;
  const { doc } = await setup(html);
  const row = doc.querySelector('#appearance-card > [data-agy-i18n="language-row"]');
  assert.ok(row, '已插入');
  const fontRow = doc.querySelector('#radix-3').closest('#appearance-card > *');
  assert.strictEqual(row.className, fontRow.className, '与"字体"行同样的 class');
  assert.strictEqual(row.querySelector('[role="combobox"]').className, doc.querySelector('#radix-3').className);
  assert.strictEqual(row.querySelector('[role="combobox"] .truncate').textContent, '简体中文');
  assert.strictEqual(row.querySelector('.text-muted-foreground').textContent, LABELS.description);
});

test('不在设置页时不插入任何东西', async () => {
  const { doc } = await setup('<!doctype html><body><button>Settings</button></body>');
  assert.strictEqual(doc.querySelector('[data-agy-i18n="language-row"]'), null);
});

test('原生 <select> 模板：直接使用系统原生下拉框', async () => {
  const html = `<!doctype html><body><div class="space-y-2"><h3>Appearance</h3><div class="agy-card" id="appearance-card">
    <div class="row"><div><span>Theme</span><p>Pick one</p></div><select class="native-select"><option>Dark</option><option>Light</option></select></div>
    <div class="row"><div><span>Density</span></div><select class="native-select"><option>Normal</option></select></div>
  </div></div></body>`;
  const { doc, win, chosen } = await setup(html);
  const sel = doc.querySelector('[data-agy-i18n="language-row"] select');
  assert.ok(sel);
  assert.strictEqual(sel.className, 'native-select');
  assert.strictEqual(sel.value, 'zh-CN');
  sel.value = 'en';
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.deepStrictEqual(chosen, ['en']);
});
