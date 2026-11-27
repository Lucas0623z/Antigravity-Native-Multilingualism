'use strict';
/**
 * 真实 Electron 端到端测试：
 *   1. 用官方 @electron/asar 打包一个"模拟 Antigravity"
 *   2. 用本项目的补丁器打补丁（默认语言简体中文）
 *   3. 在 Xvfb 下启动真实 Electron，执行 fake-app-main.js 中的检查
 *   4. 卸载补丁，校验逐字节还原
 *
 * 用法：ELECTRON_BIN=/path/to/electron node test/e2e/run.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const officialAsar = require('@electron/asar');
const { build } = require('../../tools/build.js');
const patch = require('../../src/patcher/patch.js');

async function main() {
  const electron = process.env.ELECTRON_BIN;
  if (!electron || !fs.existsSync(electron)) {
    console.log('跳过：未设置 ELECTRON_BIN');
    return 0;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-e2e-'));
  const src = path.join(work, 'src');
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity-fake', version: '2.31.2', main: 'dist/main.js' }));
  fs.copyFileSync(path.join(__dirname, 'fake-app-main.js'), path.join(src, 'dist', 'main.js'));
  const { SETTINGS_HTML } = require('../settings-page.js');
  fs.writeFileSync(path.join(src, 'dist', 'page.html'), SETTINGS_HTML);
  const appDir = path.join(work, 'app');
  fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
  const asarPath = path.join(appDir, 'resources', 'app.asar');
  await officialAsar.createPackage(src, asarPath);
  const sha = () => crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
  const original = sha();

  const payload = build();
  const r = patch.apply({ asarPath, payloadDir: payload, version: 'e2e', installInfo: { defaultLocale: 'zh-CN', dataDir: path.join(work, 'data'), appDir } });
  console.log('patch:', r.status);

  const userData = path.join(work, 'userData');
  // 自签证书：模拟 language_server 的 https://127.0.0.1
  const key = path.join(work, 'key.pem');
  const cert = path.join(work, 'cert.pem');
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  const run = spawnSync('xvfb-run', ['-a', electron, '--no-sandbox', asarPath], {
    env: Object.assign({}, process.env, { E2E_USERDATA: userData, E2E_TLS_KEY: fs.existsSync(key) ? key : '', E2E_TLS_CERT: cert, AGY_I18N_DEBUG: '1', ELECTRON_ENABLE_LOGGING: '0' }),
    encoding: 'utf8',
    timeout: 90000,
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('E2E_RESULT '));
  if (!line) {
    console.log('stdout:', run.stdout);
    console.log('stderr:', (run.stderr || '').slice(-3000));
    throw new Error('Electron 没有输出结果');
  }
  const res = JSON.parse(line.slice('E2E_RESULT '.length));
  let failed = 0;
  for (const c of res.checks) {
    console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : `  →  ${JSON.stringify(c.detail)}`}`);
    if (!c.ok) failed++;
  }
  if (res.skipped) console.log(`- 跳过：${res.skipped}`);
  for (const e of res.errors) {
    console.log('错误:', e);
    failed++;
  }
  const log = path.join(work, 'data', 'logs', 'runtime.log');
  if (fs.existsSync(log)) console.log('runtime.log:\n' + fs.readFileSync(log, 'utf8').trim().split('\n').slice(-5).join('\n'));

  const rm = patch.remove({ asarPath });
  const restored = sha() === original;
  console.log(`${restored ? '✔' : '✘'} 卸载后 app.asar 与原版逐字节一致（${rm.method}）`);
  if (!restored) failed++;
  console.log(`\n${res.checks.length + 1 - failed}/${res.checks.length + 1} 通过`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(1);
});
