'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hookBaseUpdater, findBaseUpdater, installUpdaterHook } = require('../src/main/updater.js');
const { installDialogHooks } = require('../src/main/dialog.js');
const { Matcher } = require('../src/shared/matcher.js');
const zh = new Matcher(require('../locales/zh-CN.json'));

function fakeUpdaterClass() {
  const calls = [];
  class BaseUpdater {
    install(isSilent, isForceRunAfter) {
      calls.push([isSilent, isForceRunAfter]);
      return true;
    }
  }
  class NsisUpdater extends BaseUpdater {}
  return { BaseUpdater, NsisUpdater, calls };
}

test('更新钩子：启动衔接脚本，并让安装器静默且不自行启动', () => {
  const { NsisUpdater, BaseUpdater, calls } = fakeUpdaterClass();
  const spawned = [];
  assert.strictEqual(findBaseUpdater({ NsisUpdater }), BaseUpdater);
  hookBaseUpdater(BaseUpdater, { spawnBridge: (o) => (spawned.push(o), true) });
  const u = new NsisUpdater();
  assert.strictEqual(u.install(false, true), true);
  assert.deepStrictEqual(spawned, [{ relaunch: true }]);
  assert.deepStrictEqual(calls, [[true, false]]);
});

test('更新钩子：非静默安装（安装器本会自动启动应用）→ 由衔接脚本负责重启', () => {
  const { BaseUpdater, calls } = fakeUpdaterClass();
  const spawned = [];
  hookBaseUpdater(BaseUpdater, { spawnBridge: (o) => (spawned.push(o), true) });
  new BaseUpdater().install(false, false);
  assert.deepStrictEqual(spawned, [{ relaunch: true }]);
  assert.deepStrictEqual(calls, [[true, false]]);
});

test('更新钩子：退出时静默安装不重启', () => {
  const { BaseUpdater } = fakeUpdaterClass();
  const spawned = [];
  hookBaseUpdater(BaseUpdater, { spawnBridge: (o) => (spawned.push(o), true) });
  new BaseUpdater().install(true, false);
  assert.deepStrictEqual(spawned, [{ relaunch: false }]);
});

test('更新钩子：衔接脚本启动失败时完全按原参数安装（不影响官方更新）', () => {
  const { BaseUpdater, calls } = fakeUpdaterClass();
  hookBaseUpdater(BaseUpdater, { spawnBridge: () => false });
  new BaseUpdater().install(false, true);
  assert.deepStrictEqual(calls, [[false, true]]);
});

test('更新钩子：只挂一次', () => {
  const { BaseUpdater } = fakeUpdaterClass();
  hookBaseUpdater(BaseUpdater, { spawnBridge: () => true });
  const first = BaseUpdater.prototype.install;
  hookBaseUpdater(BaseUpdater, { spawnBridge: () => true });
  assert.strictEqual(BaseUpdater.prototype.install, first);
});

test('installUpdaterHook：生成正确的 PowerShell 参数（仅 Windows）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-up-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'repatch-after-update.ps1'), '');
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'x');
  const spawns = [];
  const ctx = installUpdaterHook({
    install: { dataDir: dir, appDir },
    log() {},
    platform: 'win32',
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return { on() {}, unref() {} };
    },
  });
  assert.ok(ctx.spawnBridge({ relaunch: true }));
  const s = spawns[0];
  assert.strictEqual(s.cmd, 'powershell.exe');
  assert.ok(s.opts.detached && s.opts.windowsHide);
  const a = s.args;
  assert.strictEqual(a[a.indexOf('-AppDir') + 1], appDir);
  assert.strictEqual(a[a.indexOf('-Relaunch') + 1], '1');
  assert.match(a[a.indexOf('-OldHash') + 1], /^[0-9a-f]{64}$/);
  assert.strictEqual(installUpdaterHook({ install: { dataDir: dir, appDir }, log() {}, platform: 'darwin' }), null);
});

test('对话框钩子：翻译文字，按钮顺序与返回值不变，两种调用形式都支持', () => {
  const seen = [];
  const dialog = {
    showMessageBoxSync(a, b) {
      seen.push(b === undefined ? a : b);
      return 1;
    },
    showErrorBox(t, c) {
      seen.push({ t, c });
    },
  };
  let active = zh;
  installDialogHooks({ dialog }, () => (active ? (s) => active.translate(s) : null), () => {});
  const ret = dialog.showMessageBoxSync({ title: 'Settings', message: 'Cancel', buttons: ['Cancel', 'Settings', 'Frobnicate'] });
  assert.strictEqual(ret, 1);
  assert.deepStrictEqual(seen[0].buttons, ['取消', '设置', 'Frobnicate']);
  assert.strictEqual(seen[0].title, '设置');
  const win = { isDestroyed: () => false };
  dialog.showMessageBoxSync(win, { message: 'Settings' });
  assert.strictEqual(seen[1].message, '设置');
  dialog.showErrorBox('Settings', 'Cancel');
  assert.deepStrictEqual(seen[2], { t: '设置', c: '取消' });
  active = null; // 英文
  dialog.showMessageBoxSync({ title: 'Settings' });
  assert.strictEqual(seen[3].title, 'Settings');
});
