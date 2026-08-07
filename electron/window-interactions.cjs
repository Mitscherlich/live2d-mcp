'use strict'

/**
 * ADR 0002 · S1：角色窗桌面交互的 main 进程边界。
 *
 * 这里集中管理固定 IPC 通道、窗口移动 snap、内存缩放值、鼠标穿透和全局鼠标轮询。
 * 模块不直接 require Electron，便于用 fake ipcMain / BrowserWindow 真实覆盖每个端点。
 */

const { sanitizeWindowState } = require('./settings-store.cjs')

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
const MIN_WINDOW_SCALE = 0.5
const MAX_WINDOW_SCALE = 1.75
const DEFAULT_WINDOW_SCALE = 1
const GLOBAL_MOUSE_INTERVAL_MS = 33

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeScale(value) {
  if (!isFiniteNumber(value)) throw new TypeError('缩放值非法：必须是有限数')
  const clamped = clamp(value, MIN_WINDOW_SCALE, MAX_WINDOW_SCALE)
  return Math.round(clamped * 100) / 100
}

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

function createWindowInteractionController({
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

  const trackers = new Map()
  let registered = false
  let windowScale = DEFAULT_WINDOW_SCALE

  function getWindowState(win) {
    return {
      ...normalizeBounds(win.getBounds()),
      scale: windowScale,
    }
  }

  function notifyWindowState(win) {
    if (!win || win.isDestroyed()) return
    onWindowStateChange(getWindowState(win))
  }

  function requireAvatarSender(event) {
    const win = getWindow()
    if (!win || win.isDestroyed() || event?.sender !== win.webContents) {
      throw new Error('窗口交互 IPC sender 非法')
    }
    return win
  }

  const handlers = {
    [GET_WINDOW_BOUNDS_CHANNEL]: (event) => {
      const win = requireAvatarSender(event)
      return normalizeBounds(win.getBounds())
    },
    [MOVE_WINDOW_CHANNEL]: (event, payload) => {
      const win = requireAvatarSender(event)
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
        screen,
      )
      win.setPosition(next.x, next.y, false)
      notifyWindowState(win)
      return { ...next, width: bounds.width, height: bounds.height }
    },
    [GET_WINDOW_SCALE_CHANNEL]: (event) => {
      requireAvatarSender(event)
      return windowScale
    },
    [SET_WINDOW_SCALE_CHANNEL]: (event, rawScale) => {
      const win = requireAvatarSender(event)
      windowScale = setWindowScale(rawScale, { notify: false })
      win.webContents.send(SET_SCALE_EVENT_CHANNEL, windowScale)
      notifyWindowState(win)
      return windowScale
    },
    [SET_MOUSE_IGNORE_CHANNEL]: (event, payload) => {
      const win = requireAvatarSender(event)
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
      requireAvatarSender(event)
      openSettings()
      return true
    },
  }

  function register() {
    if (registered) return
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
    registered = true
  }

  function startGlobalMouseTracking(win) {
    trackers.get(win)?.()
    let active = true
    const interval = setIntervalFn(() => {
      if (!active || win.isDestroyed()) return
      const point = screen.getCursorScreenPoint()
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
      clearIntervalFn(interval)
      trackers.delete(win)
      win.removeListener?.('closed', stop)
    }
    trackers.set(win, stop)
    win.once?.('closed', stop)
    return stop
  }

  function setWindowScale(rawScale, { notify = true, notifyRenderer = false } = {}) {
    windowScale = normalizeScale(rawScale)
    const win = getWindow()
    if (notifyRenderer && win && !win.isDestroyed()) {
      win.webContents.send(SET_SCALE_EVENT_CHANNEL, windowScale)
    }
    if (notify) notifyWindowState(win)
    return windowScale
  }

  function restoreWindowState(win, rawState) {
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
      const next = snapWindowPosition(bounds, { x: state.x, y: state.y }, screen)
      win.setPosition(next.x, next.y, false)
    }
    setWindowScale(state.scale, { notify: false })
    return {
      ...normalizeBounds(win.getBounds()),
      scale: windowScale,
      positionRestored,
    }
  }

  function syncWindowScale(win = getWindow()) {
    if (!win || win.isDestroyed()) return false
    win.webContents.send(SET_SCALE_EVENT_CHANNEL, windowScale)
    return true
  }

  function dispose() {
    for (const stop of [...trackers.values()]) stop()
    if (!registered) return
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler?.(channel)
    registered = false
  }

  return {
    getWindowScale: () => windowScale,
    register,
    restoreWindowState,
    setWindowScale,
    startGlobalMouseTracking,
    syncWindowScale,
    dispose,
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
  MIN_WINDOW_SCALE,
  MAX_WINDOW_SCALE,
  DEFAULT_WINDOW_SCALE,
  GLOBAL_MOUSE_INTERVAL_MS,
  createWindowInteractionController,
}
