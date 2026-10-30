'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  BLUR_REOPEN_GUARD_MS,
  LEVEL_INTERVAL_MS,
  POPOVER_WIDTH,
  SettingsWindows,
  computePopoverPosition,
} = require('../settings-windows.cjs')
const { SETTINGS_CHANGED_CHANNEL, SETTINGS_LEVEL_CHANNEL } = require('../settings-channels.cjs')

const MENU_BAR_AREA = { x: 0, y: 25, width: 1440, height: 875 }

test('菜单栏托盘：弹窗放在图标下方并水平居中', () => {
  const position = computePopoverPosition({
    trayBounds: { x: 1100, y: 0, width: 24, height: 24 },
    size: { width: 340, height: 400 },
    workArea: MENU_BAR_AREA,
  })
  assert.deepEqual(position, { x: 942, y: 30 })
})

test('任务栏托盘（屏幕下半部）：弹窗放在图标上方', () => {
  const position = computePopoverPosition({
    trayBounds: { x: 1700, y: 1040, width: 24, height: 40 },
    size: { width: 340, height: 400 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  })
  assert.deepEqual(position, { x: 1542, y: 634 })
})

test('贴屏幕右缘时收进 workArea', () => {
  const position = computePopoverPosition({
    trayBounds: { x: 1420, y: 0, width: 20, height: 24 },
    size: { width: 340, height: 400 },
    workArea: MENU_BAR_AREA,
  })
  assert.equal(position.x, 1440 - 340)
})

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.sent = []
  }
  send(channel, payload) { this.sent.push([channel, payload]) }
  setWindowOpenHandler() {}
  isLoading() { return false }
}

function createHarness() {
  const windows = []
  let clock = 1000
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.visible = false
      this.destroyed = false
      this.bounds = null
      this.webContents = new FakeWebContents()
      windows.push(this)
    }
    loadFile(file, options) { this.loaded = { file, options }; return Promise.resolve() }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isMinimized() { return false }
    show() { this.visible = true }
    hide() { this.visible = false }
    focus() {}
    restore() {}
    setBounds(bounds) { this.bounds = bounds }
    setSize(width, height) { this.bounds = { ...this.bounds, width, height } }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  const opened = []
  const manager = new SettingsWindows({
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea: MENU_BAR_AREA }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
    platform: 'darwin',
    pagesDir: '/pages',
    preloadPath: '/preload.cjs',
    onFullOpened: (section) => opened.push(section),
    now: () => clock,
  })
  return {
    manager,
    windows,
    opened,
    advance(ms) { clock += ms },
  }
}

test('托盘点击开关弹窗；失焦隐藏后紧随的点击不会重新打开', () => {
  const { manager, windows, advance } = createHarness()
  const tray = { x: 1100, y: 0, width: 24, height: 24 }

  assert.equal(manager.togglePopover(tray), true)
  const popover = windows[0]
  assert.equal(popover.visible, true)
  assert.equal(popover.options.frame, false)
  assert.equal(popover.loaded.file, '/pages/popover.html')
  assert.deepEqual(popover.bounds, { x: 942, y: 30, width: POPOVER_WIDTH, height: 420 })

  // 点托盘图标：先 blur 隐藏，紧接着 click
  popover.emit('blur')
  assert.equal(popover.visible, false)
  advance(BLUR_REOPEN_GUARD_MS - 1)
  assert.equal(manager.togglePopover(tray), false)
  assert.equal(popover.visible, false)

  advance(BLUR_REOPEN_GUARD_MS)
  assert.equal(manager.togglePopover(tray), true)
  assert.equal(popover.visible, true)
  assert.equal(windows.length, 1, '弹窗复用同一个窗口')
})

test('fitPopover 按内容高度调整并重新定位', () => {
  const { manager, windows } = createHarness()
  manager.showPopover({ x: 1100, y: 0, width: 24, height: 24 })
  manager.fitPopover(360)
  assert.deepEqual(windows[0].bounds, { x: 942, y: 30, width: POPOVER_WIDTH, height: 360 })
})

test('openFull 隐藏弹窗、带 section 加载完整窗，再次打开复用并回调 section', () => {
  const { manager, windows, opened } = createHarness()
  manager.showPopover({ x: 1100, y: 0, width: 24, height: 24 })
  manager.openFull('voice')
  const [popover, full] = windows
  assert.equal(popover.visible, false)
  assert.equal(full.loaded.file, '/pages/settings.html')
  assert.deepEqual(full.loaded.options.query, { platform: 'darwin', section: 'voice' })
  assert.equal(full.options.titleBarStyle, 'hiddenInset')

  full.emit('ready-to-show')
  assert.equal(full.visible, true)
  manager.openFull('mcp')
  assert.equal(windows.length, 2)
  assert.deepEqual(opened, [null, 'mcp'])
})

test('isSender 识别两个设置窗，拒绝其他 sender', () => {
  const { manager, windows } = createHarness()
  manager.showPopover(null)
  manager.openFull()
  const [popover, full] = windows
  assert.equal(manager.isSender({ sender: popover.webContents }), true)
  assert.equal(manager.isSender({ sender: full.webContents }), true)
  assert.equal(manager.isSender({ sender: new FakeWebContents() }), false)
})

test('broadcast 推送到所有存活窗口；pushLevel 只推可见窗口并节流', () => {
  const { manager, windows, advance } = createHarness()
  assert.equal(manager.pushLevel(0.5), false, '没有窗口时不推送')

  manager.showPopover({ x: 1100, y: 0, width: 24, height: 24 })
  manager.openFull()
  const [popover, full] = windows
  manager.broadcast({ port: 47832 })
  assert.deepEqual(popover.webContents.sent.at(-1), [SETTINGS_CHANGED_CHANNEL, { port: 47832 }])
  assert.deepEqual(full.webContents.sent.at(-1), [SETTINGS_CHANGED_CHANNEL, { port: 47832 }])

  // openFull 已隐藏弹窗，完整窗尚未 ready-to-show → 都不可见，不推
  assert.equal(manager.pushLevel(0.3), false)
  full.emit('ready-to-show')
  assert.equal(manager.pushLevel(0.4), true)
  assert.deepEqual(full.webContents.sent.at(-1), [SETTINGS_LEVEL_CHANNEL, 0.4])
  assert.deepEqual(popover.webContents.sent.at(-1), [SETTINGS_CHANGED_CHANNEL, { port: 47832 }])

  advance(LEVEL_INTERVAL_MS - 1)
  assert.equal(manager.pushLevel(0.6), false, '节流窗口内丢弃')
  advance(1)
  assert.equal(manager.pushLevel(0.7), true)
})

test('dispose 销毁两个窗口', () => {
  const { manager, windows } = createHarness()
  manager.showPopover(null)
  manager.openFull()
  manager.dispose()
  assert.equal(windows.every((win) => win.destroyed), true)
  assert.equal(manager.hasVisibleWindow(), false)
})
