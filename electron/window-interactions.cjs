'use strict'

/**
 * ADR 0002 · S1：角色窗桌面交互的 main 进程边界。
 *
 * 这里集中管理固定 IPC 通道、窗口移动 snap、内存缩放值、鼠标穿透和全局鼠标轮询。
 * 模块不直接 require Electron，便于用 fake ipcMain / BrowserWindow 真实覆盖每个端点。
 */

const { isFiniteNumber, isWindowSender } = require('./protocol-utils.cjs')
const {
  DEFAULT_WINDOW_SCALE,
  clamp,
  normalizeScale,
  sanitizeWindowState,
} = require('./window-state.cjs')

const MOVE_WINDOW_CHANNEL = 'live2d:move-window'
const GET_WINDOW_BOUNDS_CHANNEL = 'live2d:get-window-bounds'
const GET_WINDOW_SCALE_CHANNEL = 'live2d:get-window-scale'
const SET_WINDOW_SCALE_CHANNEL = 'live2d:set-window-scale'
const GLOBAL_MOUSE_MOVE_CHANNEL = 'live2d:global-mouse-move'
const SET_SCALE_EVENT_CHANNEL = 'live2d:set-scale'
const SET_MOUSE_IGNORE_CHANNEL = 'live2d:set-mouse-ignore'
const OPEN_SETTINGS_CHANNEL = 'live2d:open-settings'

const MIN_VISIBLE_WIDTH = 80
const MIN_VISIBLE_HEIGHT = 40
const GLOBAL_MOUSE_INTERVAL_MS = 33

function normalizeBounds(bounds) {
  const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height]
  if (!values.every(isFiniteNumber)) throw new TypeError('窗口边界非法')
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
}

function snapWindowPosition(bounds, candidate, screen) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(candidate.x + bounds.width / 2),
    y: Math.round(candidate.y + bounds.height / 2),
  })
  const workArea = normalizeBounds(display?.workArea)
  const visibleWidth = Math.min(MIN_VISIBLE_WIDTH, bounds.width)
  const visibleHeight = Math.min(MIN_VISIBLE_HEIGHT, bounds.height)
  return {
    x: clamp(
      Math.round(candidate.x),
      workArea.x - bounds.width + visibleWidth,
      workArea.x + workArea.width - visibleWidth,
    ),
    y: clamp(
      Math.round(candidate.y),
      workArea.y - bounds.height + visibleHeight,
      workArea.y + workArea.height - visibleHeight,
    ),
  }
}

/**
 * 角色窗交互控制器：IPC 端点注册、窗口 scale 真值、全局鼠标轮询跟踪器。
 * 生命周期：register() → dispose()（退出/测试收尾摘除全部端点与轮询）。
 */
class WindowInteractionController {
  constructor({
    ipcMain,
    screen,
    getWindow,
    openSettings = () => {},
    onWindowStateChange = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain 必填')
    if (!screen || typeof screen.getDisplayNearestPoint !== 'function') {
      throw new TypeError('screen 必填')
    }
    if (typeof getWindow !== 'function') throw new TypeError('getWindow 必填')
    if (typeof openSettings !== 'function') throw new TypeError('openSettings 必须是函数')
    if (typeof onWindowStateChange !== 'function') {
      throw new TypeError('onWindowStateChange 必须是函数')
    }

    this._ipcMain = ipcMain
    this._screen = screen
    this._getWindow = getWindow
    this._openSettings = openSettings
    this._onWindowStateChange = onWindowStateChange
    this._setIntervalFn = setIntervalFn
    this._clearIntervalFn = clearIntervalFn

    this._trackers = new Map()
    this._registered = false
    this._windowScale = DEFAULT_WINDOW_SCALE

    this._handlers = {
      [GET_WINDOW_BOUNDS_CHANNEL]: (event) => {
        const win = this._requireAvatarSender(event)
        return normalizeBounds(win.getBounds())
      },
      [MOVE_WINDOW_CHANNEL]: (event, payload) => {
        const win = this._requireAvatarSender(event)
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !isFiniteNumber(payload.deltaX) ||
          !isFiniteNumber(payload.deltaY)
        ) {
          throw new TypeError('窗口移动增量非法')
        }
        const bounds = normalizeBounds(win.getBounds())
        const next = snapWindowPosition(
          bounds,
          { x: bounds.x + payload.deltaX, y: bounds.y + payload.deltaY },
          this._screen,
        )
        win.setPosition(next.x, next.y, false)
        this._notifyWindowState(win)
        return { ...next, width: bounds.width, height: bounds.height }
      },
      [GET_WINDOW_SCALE_CHANNEL]: (event) => {
        this._requireAvatarSender(event)
        return this._windowScale
      },
      [SET_WINDOW_SCALE_CHANNEL]: (event, rawScale) => {
        const win = this._requireAvatarSender(event)
        const scale = this.setWindowScale(rawScale, { notify: false })
        win.webContents.send(SET_SCALE_EVENT_CHANNEL, scale)
        this._notifyWindowState(win)
        return scale
      },
      [SET_MOUSE_IGNORE_CHANNEL]: (event, payload) => {
        const win = this._requireAvatarSender(event)
        if (
          typeof payload !== 'object' ||
          payload === null ||
          typeof payload.ignore !== 'boolean'
        ) {
          throw new TypeError('窗口穿透参数非法')
        }
        if (typeof win.setIgnoreMouseEvents !== 'function') {
          throw new Error('窗口不支持鼠标穿透')
        }
        win.setIgnoreMouseEvents(payload.ignore, { forward: true })
        return payload.ignore
      },
      [OPEN_SETTINGS_CHANNEL]: (event) => {
        this._requireAvatarSender(event)
        this._openSettings()
        return true
      },
    }
  }

  _requireAvatarSender(event) {
    const win = this._getWindow()
    if (!isWindowSender(event, win)) {
      throw new Error('窗口交互 IPC sender 非法')
    }
    return win
  }

  /** 当前窗口状态（bounds + scale），持久化与恢复共用 */
  getWindowState(win) {
    return {
      ...normalizeBounds(win.getBounds()),
      scale: this._windowScale,
    }
  }

  _notifyWindowState(win) {
    if (!win || win.isDestroyed()) return
    this._onWindowStateChange(this.getWindowState(win))
  }

  getWindowScale() {
    return this._windowScale
  }

  register() {
    if (this._registered) return
    for (const [channel, handler] of Object.entries(this._handlers)) {
      this._ipcMain.handle(channel, handler)
    }
    this._registered = true
  }

  startGlobalMouseTracking(win) {
    this._trackers.get(win)?.()
    let active = true
    const interval = this._setIntervalFn(() => {
      if (!active || win.isDestroyed()) return
      const point = this._screen.getCursorScreenPoint()
      if (!isFiniteNumber(point?.x) || !isFiniteNumber(point?.y)) return
      // 顺带推送窗口 bounds：renderer 用它把屏幕坐标换算成窗口热区，
      // 避免穿透态/非焦点下窗口鼠标事件丢失导致的热区状态卡死。
      win.webContents.send(GLOBAL_MOUSE_MOVE_CHANNEL, {
        x: point.x,
        y: point.y,
        bounds: normalizeBounds(win.getBounds()),
      })
    }, GLOBAL_MOUSE_INTERVAL_MS)

    const stop = () => {
      if (!active) return
      active = false
      this._clearIntervalFn(interval)
      this._trackers.delete(win)
      win.removeListener?.('closed', stop)
    }
    this._trackers.set(win, stop)
    win.once?.('closed', stop)
    return stop
  }

  setWindowScale(rawScale, { notify = true, notifyRenderer = false } = {}) {
    this._windowScale = normalizeScale(rawScale)
    const win = this._getWindow()
    if (notifyRenderer && win && !win.isDestroyed()) {
      win.webContents.send(SET_SCALE_EVENT_CHANNEL, this._windowScale)
    }
    if (notify) this._notifyWindowState(win)
    return this._windowScale
  }

  restoreWindowState(win, rawState) {
    if (!win || win.isDestroyed()) throw new Error('窗口状态恢复目标非法')
    const state = sanitizeWindowState(rawState)
    const currentBounds = normalizeBounds(win.getBounds())
    if (
      typeof win.setSize === 'function' &&
      (currentBounds.width !== state.width || currentBounds.height !== state.height)
    ) {
      win.setSize(state.width, state.height, false)
    }

    const bounds = normalizeBounds(win.getBounds())
    const positionRestored = Number.isFinite(state.x) && Number.isFinite(state.y)
    if (positionRestored) {
      const next = snapWindowPosition(bounds, { x: state.x, y: state.y }, this._screen)
      win.setPosition(next.x, next.y, false)
    }
    this.setWindowScale(state.scale, { notify: false })
    return {
      ...normalizeBounds(win.getBounds()),
      scale: this._windowScale,
      positionRestored,
    }
  }

  syncWindowScale(win = this._getWindow()) {
    if (!win || win.isDestroyed()) return false
    win.webContents.send(SET_SCALE_EVENT_CHANNEL, this._windowScale)
    return true
  }

  dispose() {
    for (const stop of [...this._trackers.values()]) stop()
    if (!this._registered) return
    for (const channel of Object.keys(this._handlers)) this._ipcMain.removeHandler?.(channel)
    this._registered = false
  }
}

module.exports = {
  MOVE_WINDOW_CHANNEL,
  GET_WINDOW_BOUNDS_CHANNEL,
  GET_WINDOW_SCALE_CHANNEL,
  SET_WINDOW_SCALE_CHANNEL,
  GLOBAL_MOUSE_MOVE_CHANNEL,
  SET_SCALE_EVENT_CHANNEL,
  SET_MOUSE_IGNORE_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
  GLOBAL_MOUSE_INTERVAL_MS,
  WindowInteractionController,
}
