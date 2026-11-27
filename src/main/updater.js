'use strict';
/**
 * 更新衔接：Antigravity 自动更新（electron-updater / NSIS）会整包替换 app.asar，
 * 汉化随之消失。这里在"安装更新"那一刻启动一个一次性的 PowerShell 脚本：
 *   等安装器换完文件 → 重新打补丁 → （若原本要重启）再启动 Antigravity。
 *
 * - 不注册计划任务、不开机自启、不常驻进程；脚本完成即退出。
 * - 绝不强制结束任何进程。
 * - 任何一步失败都不影响 Antigravity 自身的更新（只是新版本会是英文，重新运行安装脚本即可）。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');
const childProcess = require('child_process');

function rawFs() {
  try {
    return require('original-fs');
  } catch (_) {
    return fs;
  }
}

function sha256(file) {
  try {
    const h = crypto.createHash('sha256');
    const f = rawFs();
    const fd = f.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let n;
      while ((n = f.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally {
      f.closeSync(fd);
    }
    return h.digest('hex');
  } catch (_) {
    return '';
  }
}

function hookBaseUpdater(BaseUpdater, ctx) {
  if (!BaseUpdater || !BaseUpdater.prototype || typeof BaseUpdater.prototype.install !== 'function') return false;
  if (BaseUpdater.prototype.install.__agyI18n) return true;
  const origInstall = BaseUpdater.prototype.install;
  const wrapped = function install(isSilent, isForceRunAfter) {
    // electron-updater 语义：非静默安装时安装器结束会自动启动应用（autoRunAppAfterInstall 默认 true）；
    // 静默安装时只有 isForceRunAfter 才会启动。
    const relaunch = !!isForceRunAfter || (!isSilent && this.autoRunAppAfterInstall !== false);
    let spawned = false;
    if (!this.__agyI18nBridge) {
      this.__agyI18nBridge = true;
      spawned = ctx.spawnBridge({ relaunch });
    }
    // 由衔接脚本负责"先打补丁、再启动"，因此让安装器静默运行且不自行启动应用
    if (spawned) return origInstall.call(this, true, false);
    return origInstall.call(this, isSilent, isForceRunAfter);
  };
  wrapped.__agyI18n = true;
  BaseUpdater.prototype.install = wrapped;
  return true;
}

function findBaseUpdater(exp) {
  if (!exp || typeof exp !== 'object') return null;
  if (exp.BaseUpdater) return exp.BaseUpdater;
  // electron-updater 的 NsisUpdater 继承自 BaseUpdater
  if (exp.NsisUpdater) return Object.getPrototypeOf(exp.NsisUpdater) || null;
  return null;
}

/**
 * macOS：electron-updater 的 MacUpdater 走 Squirrel.Mac，下载完成后在应用退出时由 ShipIt 替换整个 .app。
 * 记录"已下载更新"，在 will-quit 时启动一次性衔接脚本（bash，完成即退出）。
 */
function installMacUpdaterHook(opts) {
  const { install, log, electron, spawn = childProcess.spawn } = opts;
  if (!electron || !electron.app) return null;
  const script = path.join(install.dataDir, 'scripts', 'macos', 'repatch-after-update.sh');
  const asarPath = path.join(install.appDir, 'Contents', 'Resources', 'app.asar');
  let pending = false;
  let spawned = false;
  const ctx = {
    markDownloaded() {
      pending = true;
    },
    spawnBridge() {
      if (spawned) return true;
      try {
        if (!fs.existsSync(script)) {
          log('mac repatch script missing, skip bridge');
          return false;
        }
        const args = [script, '--app', install.appDir, '--data-dir', install.dataDir, '--old-hash', sha256(asarPath) || 'unknown', '--parent-pid', String(process.pid)];
        const child = spawn('/bin/bash', args, { detached: true, stdio: 'ignore' });
        if (child && child.on) child.on('error', (e) => log('mac bridge spawn error', e));
        if (child && child.unref) child.unref();
        spawned = true;
        log('mac update bridge started');
        return true;
      } catch (e) {
        log('mac bridge spawn failed', e);
        return false;
      }
    },
  };
  try {
    // 原生 Squirrel.Mac 事件：electron-updater 的 MacUpdater 也依赖它
    const au = electron.autoUpdater;
    if (au && typeof au.on === 'function') au.on('update-downloaded', () => ctx.markDownloaded());
  } catch (e) {
    log('mac autoUpdater listen failed', e);
  }
  electron.app.on('will-quit', () => {
    if (pending) ctx.spawnBridge();
  });
  return ctx;
}

function installUpdaterHook(opts) {
  const { install, log, platform = process.platform, spawn = childProcess.spawn } = opts;
  if (!install || !install.dataDir || !install.appDir) return null;
  if (platform === 'darwin') return installMacUpdaterHook(opts);
  if (platform !== 'win32') return null;

  const script = path.join(install.dataDir, 'scripts', 'repatch-after-update.ps1');
  const asarPath = path.join(install.appDir, 'resources', 'app.asar');

  const ctx = {
    spawnBridge({ relaunch }) {
      try {
        if (!fs.existsSync(script)) {
          log('repatch script missing, skip bridge');
          return false;
        }
        const args = [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-File', script,
          '-AppDir', install.appDir,
          '-DataDir', install.dataDir,
          '-OldHash', sha256(asarPath) || 'unknown',
          '-ParentPid', String(process.pid),
          '-Relaunch', relaunch ? '1' : '0',
        ];
        const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
        if (child && child.on) child.on('error', (e) => log('bridge spawn error', e));
        if (child && child.unref) child.unref();
        log(`update bridge started (relaunch=${relaunch})`);
        return true;
      } catch (e) {
        log('bridge spawn failed', e);
        return false;
      }
    },
  };

  // 1) 已加载过的 electron-updater
  for (const id of Object.keys(require.cache)) {
    if (/[\\/]electron-updater[\\/]out[\\/](main|BaseUpdater)\.js$/.test(id)) {
      const BU = findBaseUpdater(require.cache[id].exports);
      if (BU) hookBaseUpdater(BU, ctx);
    }
  }

  // 2) 之后才加载的：拦截 Module._load
  const origLoad = Module._load;
  let done = false;
  Module._load = function load(request, parent, isMain) {
    const exp = origLoad.apply(this, arguments);
    if (!done && typeof request === 'string' && (request === 'electron-updater' || /electron-updater[\\/]out[\\/]BaseUpdater(\.js)?$/.test(request))) {
      try {
        const BU = findBaseUpdater(exp);
        if (BU && hookBaseUpdater(BU, ctx)) done = true;
      } catch (e) {
        log('updater hook failed', e);
      }
    }
    return exp;
  };
  return ctx;
}

module.exports = { installUpdaterHook, installMacUpdaterHook, hookBaseUpdater, findBaseUpdater };
