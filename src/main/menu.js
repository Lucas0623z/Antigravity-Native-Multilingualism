'use strict';
/**
 * 原生菜单 / 托盘 / 右键菜单汉化。
 *
 * 关键点：绝不修改 Antigravity 自己的 MenuItem。
 * Antigravity 的代码会按英文 label 查找菜单（'File'、'View'、'Help'）、
 * 用 updateActions[menuItem.label] 路由更新操作——直接改 label 会让这些逻辑失效。
 *
 * 做法：提交给系统显示时，生成一份"翻译后的影子菜单"，点击事件转发回原始菜单项；
 * Menu.getApplicationMenu() 仍返回原始菜单。原始菜单项上的 enabled / checked /
 * visible / label 变化会同步到影子菜单。
 */

function installMenuHooks(electron, getTranslate, log) {
  const { Menu, Tray } = electron;
  if (!Menu || Menu.__agyI18nHooked) return { refresh() {} };
  Menu.__agyI18nHooked = true;

  const origSetApp = Menu.setApplicationMenu.bind(Menu);
  const origGetApp = Menu.getApplicationMenu.bind(Menu);
  const origBuild = Menu.buildFromTemplate.bind(Menu);
  const origPopup = Menu.prototype.popup;
  const origTraySet = Tray && Tray.prototype.setContextMenu;
  const origTrayTip = Tray && Tray.prototype.setToolTip;

  let appMenuOriginal; // undefined = 尚未设置过
  const shadowOf = new WeakMap(); // 原始 MenuItem -> 影子 MenuItem
  const trays = new Set();
  const trayMenus = new WeakMap();
  const trayTips = new WeakMap();
  let refreshQueued = false;

  const TRANSLATED_PROPS = ['label', 'sublabel', 'toolTip'];
  const MIRRORED_PROPS = ['enabled', 'visible', 'checked', 'label', 'sublabel', 'toolTip'];

  function tr(s) {
    const t = getTranslate();
    if (!t || typeof s !== 'string' || !s) return s;
    // 菜单 label 中 & 是 Windows 助记符：&File -> File
    const amp = /&(?!&)/.test(s);
    const plain = amp ? s.replace(/&(?!&)/g, '') : s;
    const out = t(plain);
    return out == null ? s : out;
  }

  function mirror(orig) {
    if (orig.__agyI18nMirrored) return;
    try {
      for (const prop of MIRRORED_PROPS) {
        let value = orig[prop];
        Object.defineProperty(orig, prop, {
          configurable: true,
          enumerable: true,
          get() {
            return value;
          },
          set(v) {
            value = v;
            const shadow = shadowOf.get(orig);
            if (shadow) {
              try {
                shadow[prop] = TRANSLATED_PROPS.includes(prop) ? tr(v) : v;
              } catch (_) {
                /* ignore */
              }
            }
            if (prop === 'label' || prop === 'visible') queueRefresh();
          },
        });
      }
      Object.defineProperty(orig, '__agyI18nMirrored', { value: true });
    } catch (_) {
      /* 无法定义访问器时退化为仅在重新设置菜单时同步 */
    }
  }

  function shadowItem(orig) {
    const o = {
      type: orig.type,
      id: orig.id,
      label: tr(orig.label),
      sublabel: tr(orig.sublabel),
      toolTip: tr(orig.toolTip),
      enabled: orig.enabled,
      visible: orig.visible,
      checked: orig.checked,
      icon: orig.icon || undefined,
      accelerator: orig.accelerator || undefined,
      registerAccelerator: orig.registerAccelerator,
      acceleratorWorksWhenHidden: orig.acceleratorWorksWhenHidden,
    };
    if (orig.role) o.role = orig.role;
    if (orig.submenu) o.submenu = shadowMenu(orig.submenu);
    if (!orig.role && orig.type !== 'separator' && orig.type !== 'submenu') {
      o.click = (_shadowItem, focusedWindow, event) => {
        // 原始 MenuItem.click 会自行翻转 checked，并以"原始菜单项"调用 Antigravity 的回调
        if (typeof orig.click === 'function') {
          orig.click(event, focusedWindow, focusedWindow ? focusedWindow.webContents : undefined);
        }
      };
    }
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  }

  function shadowMenu(menu) {
    if (!menu || !Array.isArray(menu.items)) return menu;
    const tmpl = menu.items.map(shadowItem);
    const shadow = origBuild(tmpl);
    menu.items.forEach((orig, i) => {
      const s = shadow.items[i];
      if (s) {
        shadowOf.set(orig, s);
        mirror(orig);
      }
    });
    return shadow;
  }

  function translateMenu(menu) {
    if (!menu || !getTranslate()) return menu;
    try {
      return shadowMenu(menu);
    } catch (e) {
      log('menu translate failed', e);
      return menu;
    }
  }

  let lastShadowApp = null;
  Menu.setApplicationMenu = function setApplicationMenu(menu) {
    appMenuOriginal = menu;
    lastShadowApp = translateMenu(menu);
    return origSetApp(lastShadowApp);
  };
  Menu.getApplicationMenu = function getApplicationMenu() {
    return appMenuOriginal !== undefined ? appMenuOriginal : origGetApp();
  };
  Menu.prototype.popup = function popup(options) {
    if (!getTranslate() || this.__agyI18nShadow) return origPopup.call(this, options);
    let shadow;
    try {
      shadow = shadowMenu(this);
      shadow.__agyI18nShadow = true;
    } catch (e) {
      log('popup translate failed', e);
      return origPopup.call(this, options);
    }
    // 关闭回调仍然通知原菜单
    return origPopup.call(shadow, options);
  };

  if (Tray && origTraySet) {
    Tray.prototype.setContextMenu = function setContextMenu(menu) {
      trays.add(this);
      trayMenus.set(this, menu);
      return origTraySet.call(this, translateMenu(menu));
    };
  }
  if (Tray && origTrayTip) {
    Tray.prototype.setToolTip = function setToolTip(tip) {
      trays.add(this);
      trayTips.set(this, tip);
      return origTrayTip.call(this, tr(tip));
    };
  }

  function refresh() {
    refreshQueued = false;
    try {
      if (appMenuOriginal !== undefined) {
        lastShadowApp = translateMenu(appMenuOriginal);
        origSetApp(lastShadowApp);
      }
      for (const t of trays) {
        if (typeof t.isDestroyed === 'function' && t.isDestroyed()) {
          trays.delete(t);
          continue;
        }
        if (trayMenus.has(t)) origTraySet.call(t, translateMenu(trayMenus.get(t)));
        if (trayTips.has(t)) origTrayTip.call(t, tr(trayTips.get(t)));
      }
    } catch (e) {
      log('menu refresh failed', e);
    }
  }

  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setImmediate(refresh);
  }

  return { refresh, _tr: tr, _shadowAppMenu: () => lastShadowApp };
}

module.exports = { installMenuHooks };
