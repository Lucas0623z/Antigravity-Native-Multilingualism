'use strict';
/** 模拟 Antigravity 设置页（结构取自真实界面的 class / data-testid） */
const { JSDOM } = require('jsdom');

const { SETTINGS_HTML, selectRow } = require('./settings-page.js');

const opened = [];
function makeDom(html = SETTINGS_HTML, url = 'https://127.0.0.1:52011/') {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  opened.push(dom);
  return dom;
}
// 测试结束时关闭所有 jsdom 窗口（否则 requestAnimationFrame 定时器会让进程挂住）
require('node:test').after(() => {
  for (const d of opened.splice(0)) d.window.close();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeDom, SETTINGS_HTML, tick, selectRow };
