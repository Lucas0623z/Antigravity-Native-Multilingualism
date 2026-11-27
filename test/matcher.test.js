'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Matcher, compileTemplate } = require('../src/shared/matcher.js');
const zh = require('../locales/zh-CN.json');

const m = new Matcher(zh);

test('精确匹配并保留首尾空白', () => {
  assert.strictEqual(m.translate('Settings'), '设置');
  assert.strictEqual(m.translate('  Settings\n'), '  设置\n');
});

test('末尾标点变体', () => {
  assert.strictEqual(m.translate('Settings:'), '设置：');
  assert.strictEqual(m.translate('Settings...'), '设置…');
});

test('不做大小写模糊匹配、不翻译句子', () => {
  assert.strictEqual(m.translate('Read the README and fix the bug'), null);
  assert.strictEqual(m.translate('Please open the settings page'), null);
});

test('纯数字/符号/中文不处理', () => {
  assert.strictEqual(m.translate('123'), null);
  assert.strictEqual(m.translate('设置'), null);
  assert.strictEqual(m.translate(''), null);
});

test('模板：数量与复数', () => {
  assert.strictEqual(m.translate('3 agents running'), '3 个智能体正在运行');
  assert.strictEqual(m.translate('1 agent running'), '1 个智能体正在运行');
  assert.strictEqual(m.translate('1,234 files changed'), '已更改 1,234 个文件');
});

test('模板：时长本地化', () => {
  assert.strictEqual(m.translate('Resets in 2h 30m'), '2 小时 30 分钟后重置');
  assert.strictEqual(m.translate('5m ago'), '5 分钟前');
  assert.strictEqual(m.translate('Worked for 1m 20s · 3 updates'), '工作了 1 分钟 20 秒 · 3 项更新');
  assert.strictEqual(
    m.translate('You have used some of your weekly limit, it will fully refresh in 3 days, 4 hours.'),
    '您已使用部分每周限额，将在 3 天 4 小时后完全恢复。',
  );
});

test('自由文本模板只在非正文语境启用', () => {
  assert.strictEqual(m.translate('Select model, current: Gemini 3 Pro'), '选择模型，当前：Gemini 3 Pro');
  assert.strictEqual(m.translate('Select model, current: Gemini 3 Pro', { prose: true }), null);
  assert.strictEqual(m.translate('Running npm test', { prose: true }), null);
});

test('自由文本占位符内的已知词条一并翻译，且汉字之间不留空格', () => {
  const mm = new Matcher({
    meta: { code: 'zh-CN' },
    strings: { Terminal: '终端' },
    templates: [{ en: 'Close {x}', tr: '关闭 {x}' }],
  });
  assert.strictEqual(mm.translate('Close Terminal'), '关闭终端');
  assert.strictEqual(mm.translate('Close main.py'), '关闭 main.py');
});

test('模板编译拒绝未知占位符', () => {
  assert.throws(() => compileTemplate('{q} things'));
  assert.ok(compileTemplate('{n} item[s]').regex.test('2 items'));
});

test('词典质量：无空译文、无与原文相同、关键词条存在', () => {
  for (const [k, v] of Object.entries(zh.strings)) {
    assert.ok(typeof v === 'string' && v.length > 0, `空译文: ${k}`);
    assert.notStrictEqual(v, k, `译文与原文相同: ${k}`);
  }
  for (const k of ['Settings', 'Appearance', 'Theme', 'Cancel', 'File', 'Edit', 'View', 'Help', 'Restart to Update', 'Check for Updates']) {
    assert.ok(zh.strings[k], `缺少关键词条 ${k}`);
  }
  assert.ok(Object.keys(zh.strings).length > 4000);
});
