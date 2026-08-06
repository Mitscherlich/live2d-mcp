'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  GLOBAL_MOUSE_MOVE_CHANNEL,
  GET_WINDOW_BOUNDS_CHANNEL,
  GET_WINDOW_SCALE_CHANNEL,
  MOVE_WINDOW_CHANNEL,
  SET_SCALE_EVENT_CHANNEL,
  SET_WINDOW_SCALE_CHANNEL,
  createWindowInteractionController,
} = require('../window-interactions.cjs')

function createFakeIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `重复注册 ${channel}`)
      handlers.set(channel, handler)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    invoke(channel, event, payload) {
      const handler = handlers.get(channel)
      assert.ok(handler, `未注册 ${channel}`)
      return handler(event, payload)
    },
  }
}

function createFakeWindow(bounds = { x: 100, y: 80, width: 600, height: 640 }) {
  const win = new EventEmitter()
  win.bounds = { ...bounds }
  win.destroyed = false
  win.positions = []
  win.sent = []
  win.webContents = {
    send(channel, payload) {
      win.sent.push({ channel, payload })
    },
  }
  win.isDestroyed = () => win.destroyed
  win.getBounds = () => ({ ...win.bounds })
  win.setPosition = (x, y, animate) => {
    win.positions.push({ x, y, animate })
    win.bounds.x = x
    win.bounds.y = y
  }
  return win
}

function setup() {
  const ipcMain = createFakeIpcMain()
  const win = createFakeWindow()
  const intervals = []
  const cleared = []
  const screen = {
    cursor: { x: 320, y: 240 },
    getCursorScreenPoint() {
      return { ...this.cursor }
    },
    getDisplayNearestPoint() {
      return { workArea: { x: 0, y: 0, width: 1000, height: 800 } }
    },
  }
  const controller = createWindowInteractionController({
    ipcMain,
    screen,
    getWindow: () => win,
    setIntervalFn(callback, delay) {
      const token = { callback, delay }
      intervals.push(token)
      return token
    },
    clearIntervalFn(token) {
      cleared.push(token)
    },
  })
  controller.register()
  const event = { sender: win.webContents }
  return { ipcMain, win, intervals, cleared, screen, controller, event }
}

test('窗口交互 IPC：四个 invoke 端点全部注册，dispose 后全部移除', () => {
  const { ipcMain, controller } = setup()
  assert.deepEqual(
    [...ipcMain.handlers.keys()].sort(),
    [
      GET_WINDOW_BOUNDS_CHANNEL,
      GET_WINDOW_SCALE_CHANNEL,
      MOVE_WINDOW_CHANNEL,
      SET_WINDOW_SCALE_CHANNEL,
    ].sort(),
  )

  controller.dispose()
  assert.equal(ipcMain.handlers.size, 0)
})

test('get-window-bounds 只向角色窗 sender 返回有限整数边界', () => {
  const { ipcMain, event } = setup()
  assert.deepEqual(ipcMain.invoke(GET_WINDOW_BOUNDS_CHANNEL, event), {
    x: 100,
    y: 80,
    width: 600,
    height: 640,
  })
  assert.throws(
    () => ipcMain.invoke(GET_WINDOW_BOUNDS_CHANNEL, { sender: {} }),
    /sender 非法/,
  )
})

test('move-window 应用增量并把窗口限制为至少 80x40px 留在最近工作区', () => {
  const { ipcMain, win, event } = setup()

  assert.deepEqual(
    ipcMain.invoke(MOVE_WINDOW_CHANNEL, event, { deltaX: 20.4, deltaY: -10.6 }),
    { x: 120, y: 69, width: 600, height: 640 },
  )
  assert.deepEqual(win.positions.at(-1), { x: 120, y: 69, animate: false })

  assert.deepEqual(
    ipcMain.invoke(MOVE_WINDOW_CHANNEL, event, { deltaX: 5000, deltaY: 5000 }),
    { x: 920, y: 760, width: 600, height: 640 },
  )
  assert.deepEqual(
    ipcMain.invoke(MOVE_WINDOW_CHANNEL, event, { deltaX: -5000, deltaY: -5000 }),
    { x: -520, y: -600, width: 600, height: 640 },
  )
})

test('move-window 拒绝非有限增量和非角色窗 sender，不触碰窗口位置', () => {
  const { ipcMain, win, event } = setup()
  assert.throws(
    () => ipcMain.invoke(MOVE_WINDOW_CHANNEL, event, { deltaX: Number.NaN, deltaY: 1 }),
    /移动增量非法/,
  )
  assert.throws(
    () => ipcMain.invoke(MOVE_WINDOW_CHANNEL, { sender: {} }, { deltaX: 1, deltaY: 1 }),
    /sender 非法/,
  )
  assert.equal(win.positions.length, 0)
})

test('窗口缩放在 main 权威钳制到 0.5-1.75，并通过事件回推 renderer', () => {
  const { ipcMain, win, event } = setup()
  assert.equal(ipcMain.invoke(GET_WINDOW_SCALE_CHANNEL, event), 1)

  assert.equal(ipcMain.invoke(SET_WINDOW_SCALE_CHANNEL, event, 2), 1.75)
  assert.equal(ipcMain.invoke(GET_WINDOW_SCALE_CHANNEL, event), 1.75)
  assert.deepEqual(win.sent.at(-1), { channel: SET_SCALE_EVENT_CHANNEL, payload: 1.75 })

  assert.equal(ipcMain.invoke(SET_WINDOW_SCALE_CHANNEL, event, -2), 0.5)
  assert.equal(ipcMain.invoke(SET_WINDOW_SCALE_CHANNEL, event, 1.234), 1.23)
  assert.throws(
    () => ipcMain.invoke(SET_WINDOW_SCALE_CHANNEL, event, Number.POSITIVE_INFINITY),
    /缩放值非法/,
  )
})

test('全局鼠标轮询固定 33ms 推送有限屏幕坐标，窗口关闭即清理', () => {
  const { controller, win, intervals, cleared, screen } = setup()
  const stop = controller.startGlobalMouseTracking(win)
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].delay, 33)

  intervals[0].callback()
  assert.deepEqual(win.sent.at(-1), {
    channel: GLOBAL_MOUSE_MOVE_CHANNEL,
    payload: { x: 320, y: 240 },
  })

  screen.cursor = { x: Number.NaN, y: 1 }
  intervals[0].callback()
  assert.equal(win.sent.length, 1, '非法坐标不得穿透到 renderer')

  win.emit('closed')
  assert.deepEqual(cleared, [intervals[0]])
  stop()
  assert.equal(cleared.length, 1, '停止函数必须幂等')
})
