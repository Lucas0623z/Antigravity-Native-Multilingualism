'use strict';
/**
 * 打补丁 / 还原 / 状态。
 *
 * 打补丁（只追加，不移动任何原始字节）：
 *   新 app.asar = [新头部] + [原数据区，逐字节不变] + [新增文件：运行时、词典、改过的入口、标记]
 *   入口文件（package.json 的 main）只在最前面插入一行 require。
 *   原始头部字节、原始数据区长度、原始文件 SHA-256 都写在标记里。
 *
 * 还原：用标记里的原始头部 + 截取原始长度的数据区，即可逐字节重建原版 app.asar，
 *   并用 SHA-256 校验；校验不过才回退到备份文件。
 */
const path = require('path');
const crypto = require('crypto');
const asar = require('./asar.js');

const PAYLOAD_DIR_IN_ASAR = 'agy-i18n';
const MARKER_PATH = `${PAYLOAD_DIR_IN_ASAR}/marker.json`;
const INJECT_TAG = '/*agy-i18n*/';

class PatchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function getMarker(file, info) {
  const buf = asar.readFile(file, info, MARKER_PATH);
  if (!buf) return null;
  try {
    const m = JSON.parse(buf.toString('utf8'));
    return m && m.tool === 'agy-i18n' ? m : null;
  } catch (_) {
    return null;
  }
}

/** 返回"原版 app.asar"的来源描述（无论当前是否已打过补丁） */
function originalSource(file, info) {
  const marker = getMarker(file, info);
  if (!marker) {
    return {
      marker: null,
      headerPickle: info.headerPickle,
      header: info.header,
      dataStart: info.dataOffset,
      dataLength: info.fileSize - info.dataOffset,
      sha256: null,
    };
  }
  const headerPickle = Buffer.from(marker.originalHeader, 'base64');
  const strLen = headerPickle.readUInt32LE(4);
  const header = JSON.parse(headerPickle.toString('utf8', 8, 8 + strLen));
  return {
    marker,
    headerPickle,
    header,
    dataStart: info.dataOffset,
    dataLength: marker.originalDataLength,
    sha256: marker.originalSha256,
  };
}

/** 读取原版入口文件内容 */
function readOriginalFile(file, src, p) {
  const fakeInfo = { header: src.header, dataOffset: src.dataStart };
  return asar.readFile(file, fakeInfo, p);
}

function resolveMain(file, src) {
  const pkgBuf = readOriginalFile(file, src, 'package.json');
  if (!pkgBuf) throw new PatchError('NO_PACKAGE_JSON', 'app.asar 中没有 package.json，这不是 Antigravity 桌面端？');
  const pkg = JSON.parse(pkgBuf.toString('utf8'));
  let main = String(pkg.main || 'index.js').replace(/\\/g, '/').replace(/^\.\//, '');
  const candidates = [main, `${main}.js`, `${main}/index.js`];
  for (const c of candidates) {
    const e = asar.getEntry(src.header, c);
    if (e && !e.files) {
      main = c;
      return { pkg, main, esm: /\.mjs$/.test(main) || (pkg.type === 'module' && !/\.cjs$/.test(main)) };
    }
  }
  throw new PatchError('NO_MAIN', `找不到入口文件 ${main}`);
}

/** 在入口文件最前面（shebang 与 'use strict' 之后）插入引导语句 */
function injectBoot(source, mainPath, esm) {
  const fromDir = path.posix.dirname(mainPath);
  let rel = path.posix.relative(fromDir, `${PAYLOAD_DIR_IN_ASAR}/boot.js`);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const line = esm
    ? `${INJECT_TAG}import{createRequire as __agyI18nCR}from"module";try{__agyI18nCR(import.meta.url)(${JSON.stringify(rel)})}catch(e){}\n`
    : `${INJECT_TAG}try{require(${JSON.stringify(rel)})}catch(e){}\n`;
  let head = '';
  let rest = source;
  if (rest.startsWith('﻿')) {
    head += '﻿';
    rest = rest.slice(1);
  }
  if (rest.startsWith('#!')) {
    const nl = rest.indexOf('\n');
    head += nl === -1 ? `${rest}\n` : rest.slice(0, nl + 1);
    rest = nl === -1 ? '' : rest.slice(nl + 1);
  }
  // 指令序言：'use strict' 等（可夹杂注释与空白）
  const prologue = /^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|(['"])use strict\1;?)*/.exec(rest)[0];
  const hasDirective = /(['"])use strict\1/.test(prologue);
  if (hasDirective) {
    const end = prologue.length;
    return `${head}${rest.slice(0, end)}${end && !rest.slice(0, end).endsWith('\n') ? '\n' : ''}${line}${rest.slice(end)}`;
  }
  return `${head}${line}${rest}`;
}

/** 收集 payload 目录下所有文件 → [{ rel, buf }] */
function collectPayload(payloadDir) {
  const fs = asar.rawFs();
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else out.push({ rel, buf: fs.readFileSync(full) });
    }
  };
  walk(payloadDir, '');
  if (!out.some((f) => f.rel === 'boot.js')) throw new PatchError('BAD_PAYLOAD', `payload 不完整：${payloadDir} 中没有 boot.js（是否忘了运行构建？）`);
  return out;
}

function hasIntegrity(header) {
  let found = false;
  const visit = (node) => {
    if (found || !node) return;
    if (node.integrity) {
      found = true;
      return;
    }
    if (node.files) for (const k of Object.keys(node.files)) visit(node.files[k]);
  };
  visit(header);
  return found;
}

/**
 * 写出新文件：prefix + 原数据区 + 追加块；同时计算原版文件的 SHA-256。
 * @returns {string} 原版 sha256
 */
function writeAsar(file, tmp, src, newHeader, blobs) {
  const fs = asar.rawFs();
  const prefix = asar.encodeHeader(newHeader);
  const origPrefix = asar.headerPickleToFilePrefix(src.headerPickle);
  const origHash = crypto.createHash('sha256').update(origPrefix);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, prefix);
    asar.copyRange(file, src.dataStart, src.dataLength, fd, [origHash]);
    for (const b of blobs) fs.writeSync(fd, b);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return origHash.digest('hex');
}

function replaceFile(tmp, file) {
  const fs = asar.rawFs();
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
      throw new PatchError('APP_RUNNING', 'app.asar 正被占用：请先完全退出 Antigravity（包括托盘图标）后再试。');
    }
    throw e;
  }
}

/**
 * 打补丁。
 * @param {object} o
 * @param {string} o.asarPath
 * @param {string} o.payloadDir   构建好的运行时目录（dist/payload）
 * @param {object} o.installInfo  写入 agy-i18n/install.json 的内容（dataDir、appDir、defaultLocale…）
 * @param {string} o.version      payload 版本
 * @param {string} [o.backupDir]  首次打补丁时保存一份原版备份
 */
function apply(o) {
  const fs = asar.rawFs();
  const file = o.asarPath;
  if (!fs.existsSync(file)) throw new PatchError('NO_ASAR', `找不到 ${file}`);
  const info = asar.readHeader(file);
  const src = originalSource(file, info);
  const { main, esm } = resolveMain(file, src);
  const mainEntry = asar.getEntry(src.header, main);
  if (mainEntry.unpacked) throw new PatchError('MAIN_UNPACKED', '入口文件位于 app.asar.unpacked，暂不支持');

  const payload = collectPayload(o.payloadDir);
  const installInfo = Object.assign({}, o.installInfo || {}, { version: o.version });
  payload.push({ rel: 'install.json', buf: Buffer.from(JSON.stringify(installInfo, null, 2)) });

  // 已是同版本同配置的补丁：无需重写
  if (src.marker && src.marker.payloadVersion === o.version && src.marker.installHash === hashObj(installInfo) && src.marker.payloadHash === hashPayload(payload)) {
    return { status: 'already', version: o.version };
  }

  const origMain = readOriginalFile(file, src, main).toString('utf8');
  const newMain = Buffer.from(injectBoot(origMain, main, esm), 'utf8');

  const header = JSON.parse(JSON.stringify(src.header));
  const withIntegrity = hasIntegrity(src.header);
  if (asar.getEntry(header, PAYLOAD_DIR_IN_ASAR)) throw new PatchError('CONFLICT', `原版 app.asar 中已存在 ${PAYLOAD_DIR_IN_ASAR}/，拒绝覆盖`);

  const blobs = [];
  let cursor = src.dataLength;
  const add = (p, buf, extra) => {
    const entry = Object.assign({ size: buf.length, offset: String(cursor) }, extra || {});
    if (withIntegrity) entry.integrity = asar.integrityOf(buf);
    asar.putEntry(header, p, entry);
    blobs.push(buf);
    cursor += buf.length;
  };

  // 入口文件：指向追加的新内容（保留 executable 等原属性）
  const mainExtra = {};
  if (mainEntry.executable) mainExtra.executable = true;
  add(main, newMain, mainExtra);
  for (const f of payload) add(`${PAYLOAD_DIR_IN_ASAR}/${f.rel}`, f.buf);

  // 标记最后写入（它需要原版 sha256，先占位，写完数据后再回填——因此单独计算）
  const tmp = `${file}.agy-i18n.tmp`;
  // 先计算原版 sha256（若已有标记则直接用标记里的值）
  let originalSha256 = src.sha256;
  if (!originalSha256) originalSha256 = asar.sha256File(file);
  const marker = {
    tool: 'agy-i18n',
    payloadVersion: o.version,
    payloadHash: hashPayload(payload),
    installHash: hashObj(installInfo),
    patchedAt: new Date().toISOString(),
    main,
    originalHeader: src.headerPickle.toString('base64'),
    originalDataLength: src.dataLength,
    originalSha256,
    originalSize: 8 + src.headerPickle.length + src.dataLength,
  };
  add(MARKER_PATH, Buffer.from(JSON.stringify(marker)));

  const writtenOrigHash = writeAsar(file, tmp, src, header, blobs);
  if (writtenOrigHash !== originalSha256) {
    fs.unlinkSync(tmp);
    throw new PatchError('ORIGINAL_MISMATCH', '原版数据校验失败：现有补丁标记与文件内容不一致。请先运行卸载，或重新安装 Antigravity。');
  }

  // 回读校验
  verifyPatched(tmp, main, newMain, marker);

  if (o.backupDir && !src.marker) backup(file, o.backupDir, originalSha256);
  replaceFile(tmp, file);
  return { status: 'patched', version: o.version, main, originalSha256 };
}

function verifyPatched(file, main, newMain, marker) {
  const info = asar.readHeader(file);
  const got = asar.readFile(file, info, main);
  if (!got || !got.equals(newMain)) throw new PatchError('VERIFY_FAILED', '回读校验失败：入口文件内容不一致');
  const m = getMarker(file, info);
  if (!m || m.originalSha256 !== marker.originalSha256) throw new PatchError('VERIFY_FAILED', '回读校验失败：标记不一致');
  if (!asar.readFile(file, info, `${PAYLOAD_DIR_IN_ASAR}/boot.js`)) throw new PatchError('VERIFY_FAILED', '回读校验失败：缺少 boot.js');
}

function backup(file, dir, sha) {
  const fs = asar.rawFs();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `app.asar.${sha.slice(0, 16)}`;
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(file, `${target}.tmp`);
      fs.renameSync(`${target}.tmp`, target);
    }
    // 只保留最新一份备份
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith('app.asar.') && n !== name) fs.unlinkSync(path.join(dir, n));
    }
  } catch (_) {
    /* 备份失败不阻止打补丁：还原本来就能逐字节重建 */
  }
}

/** 还原为原版 */
function remove(o) {
  const fs = asar.rawFs();
  const file = o.asarPath;
  if (!fs.existsSync(file)) throw new PatchError('NO_ASAR', `找不到 ${file}`);
  const info = asar.readHeader(file);
  const src = originalSource(file, info);
  if (!src.marker) return { status: 'not-patched' };

  const tmp = `${file}.agy-i18n.tmp`;
  const fd = fs.openSync(tmp, 'w');
  const h = crypto.createHash('sha256');
  try {
    const prefix = asar.headerPickleToFilePrefix(src.headerPickle);
    fs.writeSync(fd, prefix);
    h.update(prefix);
    asar.copyRange(file, src.dataStart, src.dataLength, fd, [h]);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const sha = h.digest('hex');
  if (sha === src.sha256) {
    replaceFile(tmp, file);
    return { status: 'restored', method: 'rebuild', sha256: sha };
  }
  fs.unlinkSync(tmp);
  // 重建结果不符：尝试备份
  if (o.backupDir) {
    const b = path.join(o.backupDir, `app.asar.${String(src.sha256).slice(0, 16)}`);
    if (fs.existsSync(b) && asar.sha256File(b) === src.sha256) {
      fs.copyFileSync(b, tmp);
      replaceFile(tmp, file);
      return { status: 'restored', method: 'backup', sha256: src.sha256 };
    }
  }
  throw new PatchError('RESTORE_FAILED', '无法逐字节还原原版 app.asar（校验不一致且没有可用备份）。请从官网重新安装 Antigravity 覆盖即可恢复原版。');
}

function status(o) {
  const fs = asar.rawFs();
  const file = o.asarPath;
  if (!fs.existsSync(file)) return { exists: false };
  const info = asar.readHeader(file);
  const marker = getMarker(file, info);
  const src = originalSource(file, info);
  let appVersion = null;
  try {
    appVersion = JSON.parse(readOriginalFile(file, src, 'package.json').toString('utf8')).version || null;
  } catch (_) {
    /* ignore */
  }
  let installInfo = null;
  if (marker) {
    try {
      installInfo = JSON.parse(asar.readFile(file, info, `${PAYLOAD_DIR_IN_ASAR}/install.json`).toString('utf8'));
    } catch (_) {
      /* ignore */
    }
  }
  return {
    exists: true,
    patched: !!marker,
    payloadVersion: marker ? marker.payloadVersion : null,
    patchedAt: marker ? marker.patchedAt : null,
    appVersion,
    installInfo,
  };
}

function hashObj(o) {
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}
function hashPayload(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    if (f.rel === 'install.json') continue;
    h.update(f.rel).update('\0').update(f.buf).update('\0');
  }
  return h.digest('hex');
}

module.exports = { apply, remove, status, injectBoot, getMarker, PatchError, PAYLOAD_DIR_IN_ASAR, MARKER_PATH };
