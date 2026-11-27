'use strict';
/**
 * 组装 locales/<code>.json：
 *   node tools/make-locale.js <code> <strings.json> <templates.json>
 * meta 来自下面的 META 表；strings 中值为 null 的条目会被丢弃。
 */
const fs = require('fs');
const path = require('path');
const { compileTemplate } = require('../src/shared/matcher.js');

const META = {
  'zh-CN': {
    code: 'zh-CN',
    name: '简体中文',
    htmlLang: 'zh-CN',
    fontFallback: ['Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC'],
    pickerTitle: '显示语言',
    pickerDescription: 'Antigravity 界面使用的语言，切换后立即生效。',
    systemOption: '跟随系统',
    punctuation: { ':': '：', '…': '…', '...': '…' },
    units: { s: '秒', m: '分钟', h: '小时', d: '天', w: '周', mo: '个月', y: '年', less: '不到 {v}', join: ' ' },
  },
  'zh-TW': {
    code: 'zh-TW',
    name: '繁體中文',
    htmlLang: 'zh-TW',
    fontFallback: ['Microsoft JhengHei UI', 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC', 'Source Han Sans TC'],
    pickerTitle: '顯示語言',
    pickerDescription: 'Antigravity 介面使用的語言，切換後立即生效。',
    systemOption: '跟隨系統',
    punctuation: { ':': '：', '…': '…', '...': '…' },
    units: { s: '秒', m: '分鐘', h: '小時', d: '天', w: '週', mo: '個月', y: '年', less: '不到 {v}', join: ' ' },
  },
};

function make(code, stringsFile, templatesFile) {
  const meta = META[code];
  if (!meta) throw new Error(`未知语言 ${code}`);
  const raw = JSON.parse(fs.readFileSync(stringsFile, 'utf8'));
  const strings = {};
  for (const k of Object.keys(raw).sort((a, b) => a.localeCompare(b, 'en'))) {
    const v = raw[k];
    if (typeof v === 'string' && v && v !== k) strings[k] = v;
  }
  const templates = JSON.parse(fs.readFileSync(templatesFile, 'utf8'));
  for (const t of templates) compileTemplate(t.en); // 校验语法
  const out = { meta, strings, templates };
  const file = path.join(__dirname, '..', 'locales', `${code}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  return { file, strings: Object.keys(strings).length, templates: templates.length };
}

if (require.main === module) {
  const [code, s, t] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(make(code, s, t))}\n`);
}

module.exports = { make, META };
