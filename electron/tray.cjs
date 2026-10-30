'use strict'

/**
 * 托盘纯构建模块（ADR 0001 · F7 · FR-D2；DESIGN.md §3.1）。Electron 依赖由 main 注入，
 * 使菜单动作与 window-all-closed 保活语义可由 node:test 直接验证。
 *
 * 点击语义：macOS / Windows 左键开关快捷弹窗、右键弹上下文菜单；
 * Linux 托盘通常不派发 click，沿用 setContextMenu（菜单「打开设置」直达完整窗）。
 */

const { trayIconPath } = require('./icons.cjs')

function buildTrayMenuTemplate({ showAvatar, hideAvatar, resetAvatar = () => {}, openSettings, quitApp }) {
  return [
    { label: '显示角色窗', click: showAvatar },
    { label: '隐藏角色窗', click: hideAvatar },
    { type: 'separator' },
    { label: '重置窗口位置', click: resetAvatar },
    { type: 'separator' },
    { label: '打开设置', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]
}

/** 该平台托盘是否派发 click / right-click（Linux AppIndicator 不派发） */
function trayClickSupported(platform) {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * 托盘控制器：持有 Tray 实例并内聚保活/销毁语义（此前"controller"返回裸
 * Tray，销毁判断外挂在 main —— 类化后实至名归）。
 *
 * actions.togglePopover(bounds) 接收托盘图标的屏幕 bounds，供弹窗定位。
 */
class TrayController {
  constructor({ Tray, Menu, nativeImage, platform, actions }) {
    // 直接加载完整 DPI 资源：macOS 自动合并同目录 @2x，Windows ICO 内含多尺寸。
    const icon = nativeImage.createFromPath(trayIconPath(platform))
    if (platform === 'darwin') icon.setTemplateImage(true)
    this._tray = new Tray(icon)
    this._tray.setToolTip('Mayuka')
    const menu = Menu.buildFromTemplate(buildTrayMenuTemplate(actions))

    if (trayClickSupported(platform) && typeof actions.togglePopover === 'function') {
      // 不 setContextMenu：macOS 上它会接管左键，弹窗就打不开了
      this._tray.on('click', (_event, bounds) => actions.togglePopover(bounds ?? this.getBounds()))
      this._tray.on('right-click', () => this._tray.popUpContextMenu(menu))
    } else {
      this._tray.setContextMenu(menu)
      this._tray.on('click', actions.openSettings)
    }
  }

  /** 托盘图标屏幕 bounds；平台不支持时返回 null */
  getBounds() {
    if (typeof this._tray.getBounds !== 'function') return null
    const bounds = this._tray.getBounds()
    return bounds && bounds.width > 0 ? bounds : null
  }

  isDestroyed() {
    return this._tray.isDestroyed()
  }

  destroy() {
    this._tray.destroy()
  }
}

/**
 * window-all-closed 保活判定：托盘在（未销毁）则保活不退出。
 * @param {TrayController|null|undefined} controller
 */
function shouldQuitAfterAllWindowsClosed(controller) {
  return !controller || controller.isDestroyed()
}

module.exports = {
  TrayController,
  buildTrayMenuTemplate,
  shouldQuitAfterAllWindowsClosed,
  trayClickSupported,
}
