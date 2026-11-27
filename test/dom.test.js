'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Matcher } = require('../src/shared/matcher.js');
const { createDomTranslator } = require('../src/renderer/dom.js');
const { makeDom, tick } = require('./fixtures.js');
const zh = new Matcher(require('../locales/zh-CN.json'));

function setup() {
  const jsdom = makeDom();
  const win = jsdom.window;
  const t = createDomTranslator(win);
  t.setMatcher(zh);
  t.start();
  return { win, doc: win.document, t };
}

test('翻译界面文字与属性', async () => {
  const { doc } = setup();
  await tick();
  assert.strictEqual(doc.querySelector('nav button').textContent, '设置');
  assert.strictEqual(doc.querySelector('nav button[title]').getAttribute('title'), '关闭');
  assert.strictEqual(doc.querySelector('#appearance h3').textContent, '外观');
  assert.strictEqual(doc.querySelector('p.desc').textContent, '取消');
  assert.strictEqual(doc.getElementById('search').getAttribute('placeholder'), '搜索');
});

test('绝不翻译：聊天正文、用户消息、代码、对话标题', async () => {
  const { doc } = setup();
  await tick();
  assert.strictEqual(doc.querySelector('.prose h3').textContent, 'Settings');
  assert.strictEqual(doc.querySelector('.prose p').textContent, 'Read the README and fix the bug');
  assert.strictEqual(doc.querySelector('[data-testid="user-message-content"]').textContent, 'Settings');
  assert.strictEqual(doc.querySelector('code').textContent, 'Settings');
  assert.strictEqual(doc.querySelector('[data-testid="conversation-row-sidebar"] .truncate').textContent, 'Settings');
});

test('正文语境（<p>）中禁用自由文本模板；按钮/步骤语境中启用', async () => {
  const { doc } = setup();
  await tick();
  assert.strictEqual(doc.querySelector('p.sentence').textContent, 'Running npm test');
  assert.strictEqual(doc.querySelector('div.step').textContent, '正在运行 npm test');
});

test('动态插入与 React 式文本更新都会被翻译', async () => {
  const { doc } = setup();
  const b = doc.createElement('button');
  b.textContent = 'Cancel';
  doc.body.appendChild(b);
  await tick();
  assert.strictEqual(b.textContent, '取消');
  // React 重新渲染：直接改写文本节点
  b.firstChild.nodeValue = 'Settings';
  await tick();
  assert.strictEqual(b.textContent, '设置');
  // 属性更新
  b.setAttribute('aria-label', 'Close');
  await tick();
  assert.strictEqual(b.getAttribute('aria-label'), '关闭');
});

test('不增删 DOM 节点（React 安全）', async () => {
  const jsdom = makeDom();
  const doc = jsdom.window.document;
  const before = doc.querySelectorAll('*').length;
  const textBefore = [];
  const tw = doc.createTreeWalker(doc.body, jsdom.window.NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) textBefore.push(tw.currentNode);
  const t = createDomTranslator(jsdom.window);
  t.setMatcher(zh);
  t.start();
  await tick();
  // 只多出我们的字体 <style>（在 head 中，带 data-agy-i18n 标记）
  const added = Array.from(doc.querySelectorAll('*')).length - before;
  assert.ok(added <= 2, `多出 ${added} 个元素`);
  assert.strictEqual(doc.querySelectorAll('body [data-agy-i18n]').length, 0);
  const tw2 = doc.createTreeWalker(doc.body, jsdom.window.NodeFilter.SHOW_TEXT);
  const textAfter = [];
  while (tw2.nextNode()) textAfter.push(tw2.currentNode);
  assert.strictEqual(textAfter.length, textBefore.length);
  textAfter.forEach((n, i) => assert.strictEqual(n, textBefore[i], '文本节点必须是同一个对象'));
});

test('切回英文逐节点还原，再切回中文', async () => {
  const { doc, t } = setup();
  await tick();
  t.setMatcher(null);
  assert.strictEqual(doc.querySelector('nav button').textContent, 'Settings');
  assert.strictEqual(doc.querySelector('nav button[title]').getAttribute('title'), 'Close');
  assert.strictEqual(doc.getElementById('search').getAttribute('placeholder'), 'Search');
  assert.strictEqual(doc.documentElement.getAttribute('lang'), null);
  t.setMatcher(zh);
  assert.strictEqual(doc.querySelector('nav button').textContent, '设置');
});

test('设置 html lang 与中文字体回退（只追加，不替换原字体）', async () => {
  const { doc } = setup();
  await tick();
  assert.strictEqual(doc.documentElement.getAttribute('lang'), 'zh-CN');
  const face = doc.getElementById('agy-i18n-font');
  assert.ok(face && face.textContent.includes('Microsoft YaHei UI'));
  assert.ok(face.textContent.includes('unicode-range'));
  const stack = doc.getElementById('agy-i18n-font-stack');
  assert.ok(stack && /font-family:Inter, system-ui, var\(--agy-i18n-cjk\)/.test(stack.textContent), stack && stack.textContent);
});

test('originalText 在翻译后仍返回英文原文', async () => {
  const { doc, t } = setup();
  await tick();
  assert.strictEqual(t.originalText(doc.querySelector('#appearance h3')), 'Appearance');
});

test('缺失词条收集只收集 UI 控件中的短文本', async () => {
  const jsdom = makeDom('<!doctype html><body><button>Frobnicate widgets</button><p>Some long paragraph of chat text that is not UI</p><button>/usr/bin/node</button></body>');
  const got = [];
  const t = createDomTranslator(jsdom.window, { collect: true, onMissing: (s) => got.push(s) });
  t.setMatcher(zh);
  t.start();
  await tick();
  assert.deepStrictEqual(got, ['Frobnicate widgets']);
});
