'use strict';
/**
 * 极简 Electron ASAR 读写（零依赖）。
 *
 * 文件布局：
 *   [UInt32LE 4][UInt32LE H]                 ← "尺寸 pickle"，H = 头部 pickle 字节数
 *   [UInt32LE H-4][UInt32LE L][JSON L 字节][填充到 4 字节对齐]   ← 头部 pickle
 *   [数据区 ……]                               ← 各文件 offset 均相对数据区起点
 *
 * 在 Electron 的 ELECTRON_RUN_AS_NODE 模式下运行时，普通 fs 会把 .asar 当目录，
 * 所以优先使用 original-fs。
 */
const crypto = require('crypto');
const path = require('path');

function rawFs() {
  try {
    return require('original-fs');
  } catch (_) {
    return require('fs');
  }
}

const BLOCK_SIZE = 4 * 1024 * 1024;

function align4(n) {
  return n + ((4 - (n % 4)) % 4);
}

/** 读取头部 */
function readHeader(file) {
  const fs = rawFs();
  const fd = fs.openSync(file, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('不是有效的 asar 文件（太短）');
    if (sizeBuf.readUInt32LE(0) !== 4) throw new Error('不是有效的 asar 文件（尺寸 pickle 异常）');
    const headerSize = sizeBuf.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 512 * 1024 * 1024) throw new Error('asar 头部尺寸异常');
    const headerPickle = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerPickle, 0, headerSize, 8) !== headerSize) throw new Error('asar 头部被截断');
    const strLen = headerPickle.readUInt32LE(4);
    if (8 + strLen > headerSize) throw new Error('asar 头部字符串长度异常');
    const json = headerPickle.toString('utf8', 8, 8 + strLen);
    const header = JSON.parse(json);
    const fileSize = fs.fstatSync(fd).size;
    return { header, headerPickle, dataOffset: 8 + headerSize, fileSize };
  } finally {
    fs.closeSync(fd);
  }
}

/** 由 JSON 头部对象生成 [尺寸 pickle + 头部 pickle] 字节 */
function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = align4(json.length);
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  return headerPickleToFilePrefix(pickle);
}

function headerPickleToFilePrefix(pickle) {
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([size, pickle]);
}

function splitPath(p) {
  return String(p).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
}

function getEntry(header, p) {
  let node = header;
  for (const part of splitPath(p)) {
    if (!node.files || !Object.prototype.hasOwnProperty.call(node.files, part)) return null;
    node = node.files[part];
  }
  return node;
}

/** 在头部中放置一个文件条目（自动创建目录） */
function putEntry(header, p, entry) {
  const parts = splitPath(p);
  let node = header;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node.files) node.files = {};
    if (!node.files[parts[i]]) node.files[parts[i]] = { files: {} };
    node = node.files[parts[i]];
    if (!node.files) throw new Error(`asar 路径冲突：${parts.slice(0, i + 1).join('/')} 不是目录`);
  }
  if (!node.files) node.files = {};
  node.files[parts[parts.length - 1]] = entry;
}

function removeEntry(header, p) {
  const parts = splitPath(p);
  let node = header;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node.files || !node.files[parts[i]]) return;
    node = node.files[parts[i]];
  }
  if (node.files) delete node.files[parts[parts.length - 1]];
}

function integrityOf(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(i, i + BLOCK_SIZE)).digest('hex'));
  }
  if (!blocks.length) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

/** 读取 asar 内某文件内容（支持 unpacked） */
function readFile(file, info, p) {
  const fs = rawFs();
  let entry = getEntry(info.header, p);
  let guard = 0;
  while (entry && entry.link && guard++ < 16) entry = getEntry(info.header, entry.link);
  if (!entry || entry.files) return null;
  if (entry.unpacked) return fs.readFileSync(path.join(`${file}.unpacked`, ...splitPath(p)));
  const size = Number(entry.size);
  const buf = Buffer.alloc(size);
  const fd = fs.openSync(file, 'r');
  try {
    let read = 0;
    const start = info.dataOffset + Number(entry.offset);
    while (read < size) {
      const n = fs.readSync(fd, buf, read, size - read, start + read);
      if (n <= 0) throw new Error(`读取 ${p} 时文件提前结束`);
      read += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

/** 列出所有文件路径（供测试与诊断） */
function listFiles(header, prefix = '') {
  const out = [];
  for (const [name, node] of Object.entries(header.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (node.files) out.push(...listFiles(node, p));
    else out.push(p);
  }
  return out;
}

/** 把源文件 [start, start+length) 拷贝进目标 fd，同时喂给哈希 */
function copyRange(srcFile, start, length, dstFd, hashes) {
  const fs = rawFs();
  const fd = fs.openSync(srcFile, 'r');
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let done = 0;
    while (done < length) {
      const want = Math.min(buf.length, length - done);
      const n = fs.readSync(fd, buf, 0, want, start + done);
      if (n <= 0) throw new Error('拷贝数据区时源文件提前结束');
      const chunk = buf.subarray(0, n);
      fs.writeSync(dstFd, chunk);
      for (const h of hashes) h.update(chunk);
      done += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(file) {
  const fs = rawFs();
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let n;
    let pos = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      h.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

module.exports = {
  rawFs,
  readHeader,
  encodeHeader,
  headerPickleToFilePrefix,
  getEntry,
  putEntry,
  removeEntry,
  integrityOf,
  readFile,
  listFiles,
  copyRange,
  sha256File,
  splitPath,
};
