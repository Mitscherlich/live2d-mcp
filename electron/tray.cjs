'use strict'

/**
 * 托盘纯构建模块（ADR 0001 · F7 · FR-D2）。Electron 依赖由 main 注入，
 * 使菜单动作与 window-all-closed 保活语义可由 node:test 直接验证。
 */

// 1×1 不透明 PNG；经 nativeImage 放大并在 macOS 标记为 template image。
// 不依赖 Live2D/persona 角色资源，打包与开发模式均可用。
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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

/**
 * 托盘控制器：持有 Tray 实例并内聚保活/销毁语义（此前"controller"返回裸
 * Tray，销毁判断外挂在 main —— 类化后实至名归）。
 */
class TrayController {
  constructor({ Tray, Menu, nativeImage, platform, actions }) {
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL).resize({ width: 18, height: 18 })
    if (platform === 'darwin') icon.setTemplateImage(true)
    this._tray = new Tray(icon)
    this._tray.setToolTip('Live2D Companion')
    this._tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(actions)))
    this._tray.on('click', actions.showAvatar)
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
  TRAY_ICON_DATA_URL,
  TrayController,
  buildTrayMenuTemplate,
  shouldQuitAfterAllWindowsClosed,
}
