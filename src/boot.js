'use strict';
/**
 * 引导：由补丁器插入到 Antigravity 主进程入口第一行，
 *   try{require("<相对路径>/agy-i18n/boot.js")}catch(e){}
 * 本文件与整个运行时都打包在 app.asar 内部，运行时不从外部目录加载任何代码。
 *
 * 安全阀：设置环境变量 AGY_I18N=off 启动 Antigravity，即可完全跳过本扩展。
 */
if (process.env.AGY_I18N !== 'off' && process.type === 'browser' && !global.__agyI18nBooted) {
  global.__agyI18nBooted = true;
  try {
    require('./main/index.js').start();
  } catch (e) {
    try {
      // eslint-disable-next-line no-console
      console.error('[agy-i18n] failed to start:', e);
    } catch (_) {
      /* ignore */
    }
  }
}
