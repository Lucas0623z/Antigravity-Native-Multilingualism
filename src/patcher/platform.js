'use strict';
/**
 * 各平台 Antigravity 安装布局。
 *   Windows: <安装目录>\Antigravity.exe, <安装目录>\resources\app.asar
 *   macOS:   Antigravity.app/Contents/MacOS/Antigravity,
 *            Antigravity.app/Contents/Resources/app.asar,
 *            Fuse 位于 Contents/Frameworks/Electron Framework.framework/Electron Framework
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function defaultAppDir(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    const cands = ['/Applications/Antigravity.app', path.join(os.homedir(), 'Applications', 'Antigravity.app')];
    return cands.find((c) => exists(path.join(c, 'Contents', 'Resources', 'app.asar'))) || cands[0];
  }
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'antigravity') : null;
}

function layout(appDir, platform = process.platform) {
  if (platform === 'darwin' || /\.app\/?$/i.test(appDir)) {
    const contents = path.join(appDir, 'Contents');
    let exe = path.join(contents, 'MacOS', 'Antigravity');
    if (!exists(exe)) {
      try {
        const found = fs.readdirSync(path.join(contents, 'MacOS'))[0];
        if (found) exe = path.join(contents, 'MacOS', found);
      } catch (_) {
        /* ignore */
      }
    }
    return {
      platform: 'darwin',
      asarPath: path.join(contents, 'Resources', 'app.asar'),
      exe,
      fuseBinary: path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
    };
  }
  let exe = path.join(appDir, 'Antigravity.exe');
  if (!exists(exe)) {
    try {
      const n = fs.readdirSync(appDir).find((x) => /\.exe$/i.test(x) && !/^(uninstall|elevate)/i.test(x));
      if (n) exe = path.join(appDir, n);
    } catch (_) {
      /* ignore */
    }
  }
  return { platform: 'win32', asarPath: path.join(appDir, 'resources', 'app.asar'), exe, fuseBinary: exe };
}

module.exports = { defaultAppDir, layout };
