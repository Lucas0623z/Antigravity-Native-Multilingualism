'use strict';
/**
 * 翻译匹配器（主进程与渲染进程共用，零依赖）。
 *
 * 设计原则——宁可少翻，绝不误翻：
 *  1. 精确匹配：整段文本（去首尾空白后）必须与词典键完全一致。
 *  2. 安全变体：只处理末尾的 ":" "…" "..." 和内部多余空白，不做大小写模糊匹配。
 *  3. 模板：只允许带"类型"的占位符（数字、时长、时间……），
 *     自由文本占位符 {x} 只在非正文语境（按钮、菜单、标签）中启用，并限制长度。
 */

const PLACEHOLDER_TYPES = {
  // 数字：1 / 1,234 / 3.5
  n: '\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?',
  // 紧凑时长：<1m / 5m / 2h 30m / 1d 4h / 3mo
  d: '<?\\d+\\s?(?:mos?|yrs?|hrs?|mins?|secs?|[smhdwy])(?:,?\\s\\d+\\s?(?:mos?|yrs?|hrs?|mins?|secs?|[smhdwy]))*',
  // 完整时长：5 minutes / 3 days, 4 hours / 1 hour and 5 minutes
  l: '(?:\\d+|an?) (?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)(?:,? (?:and )?\\d+ (?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))*',
  // 时刻：9:41 / 9:41 AM
  t: '\\d{1,2}:\\d{2}(?:\\s?[AaPp][Mm])?',
  // 自由短文本：不跨行，1–80 字符（仅非正文语境）
  x: '[^\\r\\n]{1,80}?',
  // 单个词/标识符：无空白
  w: '\\S{1,80}',
};

const LONG_UNITS = {
  second: 'seconds?', minute: 'minutes?', hour: 'hours?', day: 'days?', week: 'weeks?', month: 'months?', year: 'years?',
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把模板源串编译成正则。
 *   "{n} agent[s] running"  ->  /^(\d…) agents? running$/
 *   占位符名：类型字母 + 可选数字（{n}、{n2}、{x}、{x2}）
 *   [s] / [es] 表示可选复数后缀。
 */
function compileTemplate(src) {
  const names = [];
  let re = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const end = src.indexOf('}', i);
      if (end === -1) throw new Error(`模板缺少 }: ${src}`);
      const name = src.slice(i + 1, end);
      const type = name[0];
      if (!PLACEHOLDER_TYPES[type]) throw new Error(`未知占位符类型 {${name}}: ${src}`);
      names.push(name);
      re += `(${PLACEHOLDER_TYPES[type]})`;
      i = end + 1;
    } else if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end === -1) throw new Error(`模板缺少 ]: ${src}`);
      re += `(?:${escapeRegExp(src.slice(i + 1, end))})?`;
      i = end + 1;
    } else if (ch === ' ') {
      re += '\\s+';
      i += 1;
    } else {
      re += escapeRegExp(ch);
      i += 1;
    }
  }
  return { regex: new RegExp(`^${re}$`), names, free: names.some((n) => n[0] === 'x' || n[0] === 'w') };
}

const TRAILING_SUFFIXES = [
  // [英文后缀, 是否本地化替换]
  ['...', true],
  ['…', true],
  [':', true],
];

class Matcher {
  /**
   * @param {object} locale  locales/<code>.json 的内容
   *   { meta: {...}, strings: { en: tr | null }, templates: [{ en, tr }] }
   */
  constructor(locale) {
    this.meta = (locale && locale.meta) || {};
    this.code = this.meta.code || 'en';
    this.exact = new Map();
    const strings = (locale && locale.strings) || {};
    for (const key of Object.keys(strings)) {
      const val = strings[key];
      if (typeof val !== 'string' || val === '' || val === key) continue;
      this.exact.set(key, val);
      // 词典键本身含多余空白时，也登记一个规范化版本
      const norm = normalizeSpace(key);
      if (norm !== key && !this.exact.has(norm)) this.exact.set(norm, val);
    }
    this.templates = [];
    for (const t of (locale && locale.templates) || []) {
      if (!t || typeof t.en !== 'string' || typeof t.tr !== 'string') continue;
      const compiled = compileTemplate(t.en);
      this.templates.push({ ...compiled, tr: t.tr, en: t.en });
    }
    this.punct = Object.assign({ ':': ':', '…': '…', '...': '…' }, this.meta.punctuation || {});
    this.cache = new Map();
  }

  /**
   * 翻译一段文本。
   * @param {string} text 原文（可含首尾空白）
   * @param {{ prose?: boolean }} [ctx] prose=true 表示处在段落/列表等"正文"语境，禁用自由文本模板
   * @returns {string|null} 译文（保留首尾空白）；不翻译时返回 null
   */
  translate(text, ctx) {
    if (typeof text !== 'string') return null;
    const prose = !!(ctx && ctx.prose);
    const cacheKey = (prose ? '1' : '0') + text;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const out = this._translate(text, prose);
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(cacheKey, out);
    return out;
  }

  _translate(text, prose) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const lead = m[1];
    const core = m[2];
    const tail = m[3];
    if (!core || !/[A-Za-z]/.test(core)) return null;
    if (core.length > 2000) return null;
    const res = this._core(core, prose, 0);
    return res == null ? null : lead + res + tail;
  }

  _core(core, prose, depth) {
    let hit = this.exact.get(core);
    if (hit !== undefined) return hit;
    const norm = normalizeSpace(core);
    if (norm !== core) {
      hit = this.exact.get(norm);
      if (hit !== undefined) return hit;
    }
    // 末尾标点变体："Settings:" -> "设置："
    for (const [suf] of TRAILING_SUFFIXES) {
      if (norm.length > suf.length && norm.endsWith(suf)) {
        const base = norm.slice(0, -suf.length).trimEnd();
        hit = this.exact.get(base);
        if (hit !== undefined) return hit + (this.punct[suf] != null ? this.punct[suf] : suf);
      }
    }
    if (depth > 0) return null;
    return this._template(norm, prose);
  }

  _template(text, prose) {
    for (const t of this.templates) {
      if (prose && t.free) continue;
      const mm = t.regex.exec(text);
      if (!mm) continue;
      let out = t.tr;
      t.names.forEach((name, idx) => {
        let val = mm[idx + 1];
        if (name[0] === 'd' || name[0] === 'l') {
          val = this.duration(val);
        } else if (name[0] === 'x' || name[0] === 'w') {
          // 自由文本占位符：若它本身是已知 UI 词条则一并翻译（"Close Settings" -> "关闭 设置"）
          const inner = this._core(val, prose, 1);
          if (inner != null) val = inner;
        }
        out = out.split(`{${name}}`).join(val);
      });
      // 占位符替换后两侧都是汉字时去掉多余空格："关闭 设置" -> "关闭设置"
      return out.replace(/([㐀-鿿豈-﫿])[ \t]+(?=[㐀-鿿豈-﫿])/g, '$1');
    }
    return null;
  }

  /** 本地化时长："2h 30m" / "3 days, 4 hours" / "<1m" */
  duration(raw) {
    const units = this.meta.units;
    if (!units) return raw;
    const less = /^</.test(raw);
    const parts = [];
    const re = /(\d+|an?)\s?(mos?|months?|yrs?|years?|hrs?|hours?|mins?|minutes?|secs?|seconds?|weeks?|days?|[smhdwy])\b/gi;
    let m;
    while ((m = re.exec(raw))) {
      const num = /^an?$/i.test(m[1]) ? '1' : m[1];
      const u = m[2].toLowerCase();
      const key = /^mo/.test(u) ? 'mo' : /^y/.test(u) ? 'y' : /^h/.test(u) ? 'h' : /^mi|^m$/.test(u) ? 'm' : /^s/.test(u) ? 's' : /^w/.test(u) ? 'w' : 'd';
      if (!units[key]) return raw;
      parts.push(`${num}${units.space === false ? '' : ' '}${units[key]}`);
    }
    if (!parts.length) return raw;
    const joined = parts.join(units.join != null ? units.join : ' ');
    return less && units.less ? units.less.split('{v}').join(joined) : joined;
  }

  /** 原文是否在词典或模板中有命中（供"缺失词条收集"使用） */
  has(text) {
    return this.translate(text) != null;
  }
}

function normalizeSpace(s) {
  return s.replace(/\s+/g, ' ');
}

module.exports = { Matcher, compileTemplate, PLACEHOLDER_TYPES, LONG_UNITS };
