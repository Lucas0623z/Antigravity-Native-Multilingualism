#!/usr/bin/env node
'use strict';
/**
 * agy-i18n 命令行
 *
 *   node cli.js apply  [--app-dir <目录>] [--locale system|zh-CN|zh-TW|en] [--json]
 *   node cli.js remove [--app-dir <目录>] [--json]
 *   node cli.js status [--app-dir <目录>] [--json]
 *
 * 推荐用 Antigravity 自带的 Electron 运行（无需另装 Node.js）：
 *   set ELECTRON_RUN_AS_NODE=1 && "<安装目录>\Antigravity.exe" cli.js apply
 * install.ps1 会自动选择可用的运行方式。
 */
process.noAsar = true;
const path = require('path');
const fs = require('fs');
const patch = require('./src/patcher/patch.js');
const { readFuses } = require('./src/patcher/fuses.js');
const platform = require('./src/patcher/platform.js');

const ROOT = __dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const MAC_PERMISSION_HINT =
  'macOS 阻止了对 Antigravity.app 的修改。请打开 系统设置 → 隐私与安全性 → App 管理，允许"终端"（或你使用的终端程序），然后重试。若 Antigravity 安装在需要管理员权限的位置，请用 sudo 运行。';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  const appDir = path.resolve(String(args['app-dir'] || platform.defaultAppDir() || '.'));
  const lay = platform.layout(appDir);
  const asarPath = lay.asarPath;
  const dataDir = path.resolve(String(args['data-dir'] || ROOT));
  const payloadDir = path.join(ROOT, 'dist', 'payload');
  const backupDir = path.join(dataDir, 'backup');
  const json = !!args.json;

  const result = { ok: true, command: cmd, appDir, version: PKG.version };
  try {
    if (!fs.existsSync(asarPath)) {
      throw new patch.PatchError('NO_ASAR', `在 ${appDir} 下找不到 ${path.relative(appDir, asarPath)}。请用 --app-dir 指定 Antigravity 桌面端的安装位置。`);
    }
    if (fs.existsSync(lay.fuseBinary)) {
      try {
        const f = readFuses(lay.fuseBinary);
        result.fuses = f ? f.fuses : null;
      } catch (_) {
        result.fuses = null;
      }
    }

    if (cmd === 'apply') {
      if (result.fuses && result.fuses.EnableEmbeddedAsarIntegrityValidation === true) {
        throw new patch.PatchError('ASAR_INTEGRITY_ON', '此版本 Antigravity 开启了 ASAR 完整性校验，修改 app.asar 会导致无法启动。为安全起见已停止，未做任何修改。');
      }
      const locale = String(args.locale || 'system');
      if (!/^(system|en|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(locale)) throw new patch.PatchError('BAD_LOCALE', `无效的语言代码：${locale}`);
      Object.assign(
        result,
        patch.apply({
          asarPath,
          payloadDir,
          backupDir,
          version: PKG.version,
          installInfo: { dataDir, appDir, defaultLocale: locale, platform: lay.platform },
        }),
      );
    } else if (cmd === 'remove') {
      Object.assign(result, patch.remove({ asarPath, backupDir }));
    } else if (cmd === 'status') {
      Object.assign(result, patch.status({ asarPath }));
    } else {
      throw new patch.PatchError('BAD_COMMAND', `未知命令：${cmd}（可用：apply / remove / status）`);
    }
  } catch (e) {
    result.ok = false;
    result.error = e && e.code ? e.code : 'ERROR';
    result.message = e && e.message ? e.message : String(e);
    if (lay.platform === 'darwin' && e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'APP_RUNNING')) {
      result.error = 'MAC_PERMISSION';
      result.message = MAC_PERMISSION_HINT;
    }
    process.exitCode = e && e.code === 'APP_RUNNING' ? 3 : 1;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    print(result);
  }
}

function print(r) {
  const L = (s) => process.stdout.write(`${s}\n`);
  if (!r.ok) {
    L(`失败：${r.message}`);
    return;
  }
  if (r.command === 'apply') {
    L(r.status === 'already' ? `已是最新补丁（v${r.version}），无需改动。` : `完成：已为 Antigravity 安装语言包 v${r.version}。`);
  } else if (r.command === 'remove') {
    L(r.status === 'not-patched' ? '当前就是原版，无需还原。' : `已还原原版 app.asar（方式：${r.method === 'rebuild' ? '逐字节重建并校验' : '备份'}）。`);
  } else if (r.command === 'status') {
    L(`Antigravity 版本：${r.appVersion || '未知'}`);
    L(r.patched ? `语言包：已安装 v${r.payloadVersion}（${r.patchedAt}）` : '语言包：未安装');
  }
}

main();
