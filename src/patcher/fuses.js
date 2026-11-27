'use strict';
/**
 * 读取 Electron Fuses（只读，绝不修改可执行文件）。
 * Fuse 区块：哨兵串 + [版本 UInt8][数量 UInt8][每个 fuse 一个 ASCII 字节：'0' 关 / '1' 开 / 'r' 已移除]
 */
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');

const FUSE_NAMES_V1 = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];

function parseFuseBlock(buf, at) {
  const version = buf[at];
  const count = buf[at + 1];
  const fuses = {};
  for (let i = 0; i < count; i++) {
    const ch = String.fromCharCode(buf[at + 2 + i]);
    const name = FUSE_NAMES_V1[i] || `Fuse${i}`;
    fuses[name] = ch === '1' ? true : ch === '0' ? false : ch === 'r' ? 'removed' : 'unknown';
  }
  return { version, count, fuses };
}

/** 流式扫描 exe 查找 fuse 区块；找不到返回 null（老版本 Electron 没有 fuse） */
function readFuses(exePath) {
  let fs;
  try {
    fs = require('original-fs');
  } catch (_) {
    fs = require('fs');
  }
  const fd = fs.openSync(exePath, 'r');
  const CHUNK = 16 * 1024 * 1024;
  const overlap = SENTINEL.length + 64;
  const buf = Buffer.allocUnsafe(CHUNK + overlap);
  try {
    let pos = 0;
    let carry = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, carry, CHUNK, pos);
      if (n <= 0) return null;
      const len = carry + n;
      const view = buf.subarray(0, len);
      const idx = view.indexOf(SENTINEL);
      if (idx !== -1 && idx + SENTINEL.length + 2 < len) {
        const at = idx + SENTINEL.length;
        const count = view[at + 1];
        if (at + 2 + count <= len) return parseFuseBlock(view, at);
      }
      pos += n;
      carry = Math.min(overlap, len);
      view.copy(buf, 0, len - carry, len);
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readFuses, parseFuseBlock, SENTINEL, FUSE_NAMES_V1 };
