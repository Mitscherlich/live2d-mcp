'use strict'

/**
 * 设置窗口管理（DESIGN.md §3.2 / §3.3 / §4.1）。
 *
 * 持有两个窗口：托盘快捷弹窗（popover.html）与完整设置窗（settings.html）。
 * 负责创建、定位、失焦隐藏、view / level 广播；业务动作（保存、缩放、复制）
 * 仍在组合根 CompanionApp。BrowserWindow / screen 由构造注入，node:test 用 fake 直测。
 */

const path = require('node:path')

const { appIconPath } = require('./icons.cjs')
const { isWindowSender } = require('./protocol-utils.cjs')
const { SETTINGS_CHANGED_CHANNEL, SETTINGS_LEVEL_CHANNEL } = require('./settings-channels.cjs')

const POPOVER_WIDTH = 340
const POPOVER_INITIAL_HEIGHT = 420
const POPOVER_GAP = 6
const FULL_WIDTH = 860
const FULL_HEIGHT = 640
const FULL_MIN_WIDTH = 720
const FULL_MIN_HEIGHT = 520
const FULL_BACKGROUND = '#0d1117'
// 托盘点击会先让弹窗失焦隐藏，紧随的 click 不应把它重新打开
const BLUR_REOPEN_GUARD_MS = 250
const LEVEL_INTERVAL_MS = 50

/**
 * 弹窗位置：水平居中对齐托盘图标；托盘在屏幕上半部（macOS 菜单栏）放下方，
 * 下半部（Windows 任务栏）放上方；最后收进 workArea。
 * @param {object} args
 * @param {{x:number,y:number,width:number,height:number}} args.trayBounds
 * @param {{width:number,height:number}} args.size
 * @param {{x:number,y:number,width:number,height:number}} args.workArea
 * @param {number} [args.gap]
 */
function computePopoverPosition({ trayBounds, size, workArea, gap = POPOVER_GAP }) {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max))
  const centerX = trayBounds.x + trayBounds.width / 2
  const trayCenterY = trayBounds.y + trayBounds.height / 2
  const below = trayCenterY < workArea.y + workArea.height / 2
  const rawY = below ? trayBounds.y + trayBounds.height + gap : trayBounds.y - size.height - gap
  return {
    x: Math.round(clamp(centerX - size.width / 2, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(rawY, workArea.y, workArea.y + workArea.height - size.height)),
  }
}

class SettingsWindows {
  /**
   * @param {object} options
   * @param {Function} options.BrowserWindow
   * @param {object} options.screen Electron screen
   * @param {string} options.platform process.platform
   * @param {string} [options.pagesDir] 页面目录（默认 electron/settings）
   * @param {string} options.preloadPath settings-preload.cjs 绝对路径
   * @param {(section: string|null) => void} [options.onFullOpened] 完整窗显示时回调
   *   （推一份最新 view；已打开的窗口再次唤起时带 section 让页面滚动定位）
   * @param {() => number} [options.now] 测试注入时钟
   */
  constructor({
    BrowserWindow,
    screen,
    platform,
    pagesDir = path.join(__dirname, 'settings'),
    preloadPath,
    onFullOpened = () => {},
    now = Date.now,
  }) {
    this._BrowserWindow = BrowserWindow
    this._screen = screen
    this._platform = platform
    this._pagesDir = pagesDir
    this._preloadPath = preloadPath
    this._onFullOpened = onFullOpened
    this._now = now

    this._popover = null
    this._full = null
    this._popoverHiddenAt = -Infinity
    this._popoverHeight = POPOVER_INITIAL_HEIGHT
    this._lastTrayBounds = null
    this._lastLevelAt = -Infinity
    this._pendingSection = null
  }

  /** IPC sender 是否属于任一设置窗 */
  isSender(event) {
    return isWindowSender(event, this._popover) || isWindowSender(event, this._full)
  }

  _alive(win) {
    return Boolean(win && !win.isDestroyed())
  }

  _secure(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
  }

  _webPreferences() {
    return {
      preload: this._preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    }
  }

  // ------------------------------------------------------------ 弹窗

  _createPopover() {
    if (this._alive(this._popover)) return this._popover
    const isMac = this._platform === 'darwin'
    const win = new this._BrowserWindow({
      width: POPOVER_WIDTH,
      height: this._popoverHeight,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: isMac,
      backgroundColor: isMac ? '#00000000' : '#ececf0',
      ...(isMac ? { vibrancy: 'popover', visualEffectState: 'active', roundedCorners: true } : {}),
      title: 'Mayuka',
      icon: appIconPath(this._platform),
      webPreferences: this._webPreferences(),
    })
    this._popover = win
    this._secure(win)
    win.on('blur', () => this.hidePopover())
    win.on('closed', () => {
      if (this._popover === win) this._popover = null
    })
    void win.loadFile(path.join(this._pagesDir, 'popover.html'), { query: { platform: this._platform } })
    return win
  }

  popoverVisible() {
    return this._alive(this._popover) && this._popover.isVisible()
  }

  /**
   * 托盘左键：开关弹窗。
   * @param {{x:number,y:number,width:number,height:number}|null} trayBounds
   */
  togglePopover(trayBounds) {
    if (this.popoverVisible()) {
      this.hidePopover()
      return false
    }
    if (this._now() - this._popoverHiddenAt < BLUR_REOPEN_GUARD_MS) return false
    this.showPopover(trayBounds)
    return true
  }

  showPopover(trayBounds) {
    const win = this._createPopover()
    if (trayBounds) this._lastTrayBounds = trayBounds
    this._placePopover()
    const reveal = () => {
      if (!this._alive(win)) return
      win.show()
      win.focus()
    }
    if (win.webContents.isLoading()) win.once('ready-to-show', reveal)
    else reveal()
    return win
  }

  hidePopover() {
    if (!this.popoverVisible()) return
    this._popoverHiddenAt = this._now()
    this._popover.hide()
  }

  /** 页面按内容上报高度（已由 parseSettingsAction 收敛范围） */
  fitPopover(height) {
    this._popoverHeight = height
    if (!this._alive(this._popover)) return
    this._popover.setSize(POPOVER_WIDTH, height, false)
    this._placePopover()
  }

  _placePopover() {
    if (!this._alive(this._popover)) return
    const size = { width: POPOVER_WIDTH, height: this._popoverHeight }
    const anchor = this._lastTrayBounds ?? this._fallbackAnchor()
    const display = this._screen.getDisplayNearestPoint({
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2),
    })
    const { x, y } = computePopoverPosition({ trayBounds: anchor, size, workArea: display.workArea })
    this._popover.setBounds({ x, y, ...size }, false)
  }

  /** 拿不到托盘 bounds（Linux / 尚未点击）时贴光标所在屏的右上角 */
  _fallbackAnchor() {
    const display = this._screen.getDisplayNearestPoint(this._screen.getCursorScreenPoint())
    const area = display.workArea
    return { x: area.x + area.width - POPOVER_WIDTH / 2 - 16, y: area.y, width: 0, height: 0 }
  }

  // ---------------------------------------------------------- 完整窗

  /**
   * 打开完整设置窗；section 提供时滚动到对应分区。
   * @param {string|null} [section]
   */
  openFull(section = null) {
    this.hidePopover()
    if (this._alive(this._full)) {
      if (this._full.isMinimized()) this._full.restore()
      this._full.show()
      this._full.focus()
      this._onFullOpened(section)
      return this._full
    }
    const isMac = this._platform === 'darwin'
    const win = new this._BrowserWindow({
      width: FULL_WIDTH,
      height: FULL_HEIGHT,
      minWidth: FULL_MIN_WIDTH,
      minHeight: FULL_MIN_HEIGHT,
      show: false,
      title: 'Mayuka 设置',
      icon: appIconPath(this._platform),
      backgroundColor: FULL_BACKGROUND,
      autoHideMenuBar: true,
      ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } } : {}),
      webPreferences: this._webPreferences(),
    })
    this._full = win
    this._secure(win)
    win.once('ready-to-show', () => {
      if (!this._alive(win)) return
      win.show()
      this._onFullOpened(null)
    })
    win.on('closed', () => {
      if (this._full === win) this._full = null
    })
    const query = { platform: this._platform, ...(section ? { section } : {}) }
    void win.loadFile(path.join(this._pagesDir, 'settings.html'), { query })
    return win
  }

  // ------------------------------------------------------------ 广播

  _targets() {
    return [this._popover, this._full].filter((win) => this._alive(win))
  }

  /** 视图模型推送到两个窗口（未创建/已销毁的跳过） */
  broadcast(view) {
    for (const win of this._targets()) win.webContents.send(SETTINGS_CHANGED_CHANNEL, view)
  }

  /** 实时电平：只推可见窗口，并节流到 LEVEL_INTERVAL_MS */
  pushLevel(level) {
    const now = this._now()
    if (now - this._lastLevelAt < LEVEL_INTERVAL_MS) return false
    const visible = this._targets().filter((win) => win.isVisible())
    if (visible.length === 0) return false
    this._lastLevelAt = now
    for (const win of visible) win.webContents.send(SETTINGS_LEVEL_CHANNEL, level)
    return true
  }

  hasVisibleWindow() {
    return this._targets().some((win) => win.isVisible())
  }

  dispose() {
    for (const win of this._targets()) win.destroy()
    this._popover = null
    this._full = null
  }
}

module.exports = {
  BLUR_REOPEN_GUARD_MS,
  LEVEL_INTERVAL_MS,
  POPOVER_WIDTH,
  SettingsWindows,
  computePopoverPosition,
}
