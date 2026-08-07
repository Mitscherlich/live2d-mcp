'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const {
  GLOBAL_MOUSE_MOVE_CHANNEL,
  GET_WINDOW_BOUNDS_CHANNEL,
  GET_WINDOW_SCALE_CHANNEL,
  MOVE_WINDOW_CHANNEL,
  OPEN_SETTINGS_CHANNEL,
  SET_SCALE_EVENT_CHANNEL,
  SET_MOUSE_IGNORE_CHANNEL,
  SET_WINDOW_SCALE_CHANNEL,
} = require('../window-interactions.cjs')

function loadPreload() {
  const listeners = new Map()
  const invoked = []
  let exposed = null
  const ipcRenderer = {
    invoke(channel, payload) {
      invoked.push({ channel, payload: structuredClone(payload) })
      return Promise.resolve(channel)
    },
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, [])
      listeners.get(channel).push(listener)
    },
    removeListener(channel, listener) {
      const entries = listeners.get(channel) ?? []
      const index = entries.indexOf(listener)
      if (index >= 0) entries.splice(index, 1)
    },
    send() {},
    emit(channel, payload) {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, payload)
    },
  }
  const contextBridge = {
    exposeInMainWorld(name, api) {
      exposed = { name, api }
    },
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8')
  vm.runInNewContext(source, {
    require(specifier) {
      if (specifier === 'electron') return { contextBridge, ipcRenderer }
      throw new Error(`unexpected require: ${specifier}`)
    },
    process: {
      argv: [],
      platform: 'darwin',
      versions: { electron: '39', chrome: '1', node: '24' },
    },
    console,
  })
  assert.equal(exposed?.name, 'live2d')
  return { api: exposed.api, ipcRenderer, invoked, listeners }
}

test('preload 六个窗口 invoke API 只发送固定通道与窄负载', async () => {
  const { api, invoked } = loadPreload()

  await api.moveWindow(4, -3)
  await api.getWindowBounds()
  await api.getWindowScale()
  await api.setWindowScale(1.25)
  await api.setMouseIgnore(true)
  await api.openSettings()

  assert.deepEqual(invoked, [
    { channel: MOVE_WINDOW_CHANNEL, payload: { deltaX: 4, deltaY: -3 } },
    { channel: GET_WINDOW_BOUNDS_CHANNEL, payload: undefined },
    { channel: GET_WINDOW_SCALE_CHANNEL, payload: undefined },
    { channel: SET_WINDOW_SCALE_CHANNEL, payload: 1.25 },
    { channel: SET_MOUSE_IGNORE_CHANNEL, payload: { ignore: true } },
    { channel: OPEN_SETTINGS_CHANNEL, payload: undefined },
  ])

  await assert.rejects(api.moveWindow(Number.NaN, 2), /移动增量必须是有限数/)
  await assert.rejects(api.setWindowScale(Number.NaN), /缩放值必须是有限数/)
  await assert.rejects(api.setMouseIgnore('yes'), /窗口穿透参数必须是布尔值/)
  assert.equal(invoked.length, 6, '非法负载不得调用任意 IPC')
})

test('preload 全局鼠标订阅只放行有限坐标，并可取消订阅', () => {
  const { api, ipcRenderer, listeners } = loadPreload()
  const points = []
  const off = api.onGlobalMouseMove((x, y, bounds) => points.push({ x, y, bounds }))

  ipcRenderer.emit(GLOBAL_MOUSE_MOVE_CHANNEL, {
    x: 12,
    y: -8,
    bounds: { x: 100, y: 80, width: 600, height: 640 },
  })
  ipcRenderer.emit(GLOBAL_MOUSE_MOVE_CHANNEL, { x: '12', y: -8 })
  ipcRenderer.emit(GLOBAL_MOUSE_MOVE_CHANNEL, { x: Number.NaN, y: 4 })
  assert.equal(points.length, 1)
  assert.equal(points[0].x, 12)
  assert.equal(points[0].y, -8)
  // preload 运行在独立 vm realm，bounds 原型与测试域不同，展开后再做结构比较
  assert.deepEqual({ ...points[0].bounds }, { x: 100, y: 80, width: 600, height: 640 })

  // bounds 缺失/形状非法时降级为 null，不阻断坐标投递
  ipcRenderer.emit(GLOBAL_MOUSE_MOVE_CHANNEL, { x: 1, y: 2 })
  ipcRenderer.emit(GLOBAL_MOUSE_MOVE_CHANNEL, { x: 1, y: 2, bounds: { x: 1 } })
  assert.equal(points.at(-2).bounds, null)
  assert.equal(points.at(-1).bounds, null)

  off()
  assert.equal(listeners.get(GLOBAL_MOUSE_MOVE_CHANNEL).length, 0)
})

test('preload 缩放订阅只放行 0.5-1.75 的有限值，并可取消订阅', () => {
  const { api, ipcRenderer, listeners } = loadPreload()
  const scales = []
  const off = api.onSetScale((scale) => scales.push(scale))

  ipcRenderer.emit(SET_SCALE_EVENT_CHANNEL, 1.4)
  ipcRenderer.emit(SET_SCALE_EVENT_CHANNEL, 2)
  ipcRenderer.emit(SET_SCALE_EVENT_CHANNEL, '1')
  assert.deepEqual(scales, [1.4])

  off()
  assert.equal(listeners.get(SET_SCALE_EVENT_CHANNEL).length, 0)
})
