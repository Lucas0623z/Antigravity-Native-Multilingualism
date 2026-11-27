'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const officialAsar = require('@electron/asar');
const patch = require('../src/patcher/patch.js');
const asar = require('../src/patcher/asar.js');
const { build } = require('../tools/build.js');

const PAYLOAD = build();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 用 Electron 官方 @electron/asar 生成一个"假 Antigravity" app.asar */
async function makeApp({ esm = false, strict = true, unpack = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-app-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(src, 'node_modules', 'native'), { recursive: true });
  const pkg = { name: 'antigravity', version: '2.31.2', main: esm ? 'dist/main.mjs' : 'dist/main.js' };
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg));
  const body = esm ? 'import fs from "fs";\nexport const x = 1;\n' : `${strict ? '"use strict";\n' : ''}Object.defineProperty(exports, "__esModule", { value: true });\nconst electron_1 = require("electron");\n`;
  fs.writeFileSync(path.join(src, pkg.main), body);
  fs.writeFileSync(path.join(src, 'dist', 'menu.js'), 'module.exports = 1;\n'.repeat(5000));
  fs.writeFileSync(path.join(src, 'node_modules', 'native', 'addon.node'), crypto.randomBytes(300000));
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
  const asarPath = path.join(appDir, 'resources', 'app.asar');
  await officialAsar.createPackageWithOptions(src, asarPath, unpack ? { unpack: '*.node' } : {});
  return { dir, appDir, asarPath, pkg };
}

test('打补丁后官方 asar 库可正常读取，入口插入引导行，payload 完整', async () => {
  const app = await makeApp();
  const before = sha(app.asarPath);
  const r = patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.0', installInfo: { defaultLocale: 'zh-CN' } });
  assert.strictEqual(r.status, 'patched');
  assert.strictEqual(r.originalSha256, before);

  const files = officialAsar.listPackage(app.asarPath).map((p) => p.replace(/\\/g, '/'));
  for (const f of ['/agy-i18n/boot.js', '/agy-i18n/preload.bundle.js', '/agy-i18n/main/index.js', '/agy-i18n/locales/zh-CN.json', '/agy-i18n/install.json', '/agy-i18n/marker.json']) {
    assert.ok(files.includes(f), `缺少 ${f}`);
  }
  const main = officialAsar.extractFile(app.asarPath, 'dist/main.js').toString();
  const lines = main.split('\n');
  assert.strictEqual(lines[0], '"use strict";', '"use strict" 必须仍在第一行');
  assert.ok(lines[1].startsWith('/*agy-i18n*/try{require("../agy-i18n/boot.js")}catch(e){}'));
  assert.ok(main.endsWith('const electron_1 = require("electron");\n'));
  // 未改动的文件逐字节一致
  const menu = officialAsar.extractFile(app.asarPath, 'dist/menu.js').toString();
  assert.strictEqual(menu, 'module.exports = 1;\n'.repeat(5000));
  // unpacked 文件不受影响
  assert.ok(fs.existsSync(`${app.asarPath}.unpacked/node_modules/native/addon.node`));
  const install = JSON.parse(officialAsar.extractFile(app.asarPath, 'agy-i18n/install.json').toString());
  assert.strictEqual(install.defaultLocale, 'zh-CN');
  assert.strictEqual(install.version, '1.0.0');
});

test('卸载可逐字节还原原版（SHA-256 一致）', async () => {
  const app = await makeApp();
  const before = sha(app.asarPath);
  patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.0', installInfo: {} });
  assert.notStrictEqual(sha(app.asarPath), before);
  const r = patch.remove({ asarPath: app.asarPath });
  assert.strictEqual(r.status, 'restored');
  assert.strictEqual(r.method, 'rebuild');
  assert.strictEqual(sha(app.asarPath), before);
  assert.strictEqual(patch.remove({ asarPath: app.asarPath }).status, 'not-patched');
});

test('重复打补丁幂等；升级 payload 版本后仍可还原到最初原版', async () => {
  const app = await makeApp();
  const before = sha(app.asarPath);
  patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.0', installInfo: {} });
  const once = sha(app.asarPath);
  assert.strictEqual(patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.0', installInfo: {} }).status, 'already');
  assert.strictEqual(sha(app.asarPath), once);
  // 新版本覆盖：数据区不会越叠越大
  patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.1', installInfo: {} });
  const size1 = fs.statSync(app.asarPath).size;
  patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.2', installInfo: {} });
  assert.ok(Math.abs(fs.statSync(app.asarPath).size - size1) < 64, '反复升级不应让文件越来越大');
  const main = officialAsar.extractFile(app.asarPath, 'dist/main.js').toString();
  assert.strictEqual((main.match(/\/\*agy-i18n\*\//g) || []).length, 1, '引导行只能有一行');
  patch.remove({ asarPath: app.asarPath });
  assert.strictEqual(sha(app.asarPath), before);
});

test('ESM 入口使用 createRequire 引导', async () => {
  const app = await makeApp({ esm: true });
  patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.0', installInfo: {} });
  const main = officialAsar.extractFile(app.asarPath, 'dist/main.mjs').toString();
  assert.ok(main.startsWith('/*agy-i18n*/import{createRequire as __agyI18nCR}from"module";'));
});

test('原版带完整性信息时，新增文件也写入正确的 integrity', async () => {
  const app = await makeApp();
  const info0 = asar.readHeader(app.asarPath);
  const hasIntegrity = !!asar.getEntry(info0.header, 'dist/menu.js').integrity;
  patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.0', installInfo: {} });
  const info = asar.readHeader(app.asarPath);
  const e = asar.getEntry(info.header, 'agy-i18n/boot.js');
  if (hasIntegrity) {
    const buf = asar.readFile(app.asarPath, info, 'agy-i18n/boot.js');
    assert.strictEqual(e.integrity.hash, crypto.createHash('sha256').update(buf).digest('hex'));
  } else {
    assert.strictEqual(e.integrity, undefined);
  }
});

test('injectBoot 处理 BOM、shebang、注释与无 use strict 的情况', () => {
  const a = patch.injectBoot('﻿#!/usr/bin/env node\n"use strict";\nfoo();\n', 'dist/main.js', false);
  assert.ok(a.startsWith('﻿#!/usr/bin/env node\n"use strict";\n/*agy-i18n*/try{require('));
  const b = patch.injectBoot('foo();\n', 'main.js', false);
  assert.ok(b.startsWith('/*agy-i18n*/try{require("./agy-i18n/boot.js")}catch(e){}\nfoo();'));
  const c = patch.injectBoot('/* banner */\n\'use strict\';foo();', 'a/b/main.js', false);
  assert.ok(c.includes("'use strict';\n/*agy-i18n*/try{require(\"../../agy-i18n/boot.js\")}"));
});

test('status 报告补丁状态与 Antigravity 版本', async () => {
  const app = await makeApp();
  assert.strictEqual(patch.status({ asarPath: app.asarPath }).patched, false);
  patch.apply({ asarPath: app.asarPath, payloadDir: PAYLOAD, version: '1.0.0', installInfo: { defaultLocale: 'system' } });
  const s = patch.status({ asarPath: app.asarPath });
  assert.strictEqual(s.patched, true);
  assert.strictEqual(s.appVersion, '2.31.2');
  assert.strictEqual(s.installInfo.defaultLocale, 'system');
});
