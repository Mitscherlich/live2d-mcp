'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  TrayController,
  buildTrayMenuTemplate,
  shouldQuitAfterAllWindowsClosed,
  trayClickSupported,
} = require('../tray.cjs')

test('托盘菜单将显示、隐藏、设置与退出动作接到对应回调', () => {
  const calls = []
  const template = buildTrayMenuTemplate({
    showAvatar: () => calls.push('show'),
    hideAvatar: () => calls.push('hide'),
    resetAvatar: () => calls.push('reset'),
    openSettings: () => calls.push('settings'),
    quitApp: () => calls.push('quit'),
  })

  const actionable = template.filter((item) => item.type !== 'separator')
  assert.deepEqual(actionable.map((item) => item.label), [
    '显示角色窗',
    '隐藏角色窗',
    '重置窗口位置',
    '打开设置',
    '退出',
  ])
  for (const item of actionable) item.click()
  assert.deepEqual(calls, ['show', 'hide', 'reset', 'settings', 'quit'])
})

test('有可用托盘时 window-all-closed 保活；无托盘时退出', () => {
  assert.equal(shouldQuitAfterAllWindowsClosed(null), true)
  assert.equal(shouldQuitAfterAllWindowsClosed({ isDestroyed: () => false }), false)
  assert.equal(shouldQuitAfterAllWindowsClosed({ isDestroyed: () => true }), true)
})

function createTrayHarness(platform, extraActions = {}) {
  const events = new Map()
  const image = {
    setTemplateImage(value) {
      this.template = value
    },
  }
  let rawTray = null
  class FakeTray {
    constructor(icon) {
      assert.equal(icon, image)
      this.destroyed = false
      this.contextMenu = null
      this.poppedUp = null
      rawTray = this
    }
    setToolTip(value) { this.tooltip = value }
    setContextMenu(value) { this.contextMenu = value }
    popUpContextMenu(value) { this.poppedUp = value }
    getBounds() { return { x: 1200, y: 0, width: 24, height: 24 } }
    on(name, callback) { events.set(name, callback) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  }
  const calls = []
  const actions = {
    showAvatar() {}, hideAvatar() {}, resetAvatar() {},
    openSettings() { calls.push(['settings']) },
    quitApp() {},
    togglePopover(bounds) { calls.push(['toggle', bounds]) },
    ...extraActions,
  }
  const controller = new TrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ marker: true, template }) },
    nativeImage: {
      createFromPath(filePath) {
        assert.equal(fs.existsSync(filePath), true, '托盘资源应随应用入库')
        image.filePath = filePath
        return image
      },
    },
    platform,
    actions,
  })
  return { controller, rawTray, events, image, calls }
}

test('macOS 托盘加载 B6 模板及 Retina 配套图；持有销毁语义', () => {
  const { controller, rawTray, image } = createTrayHarness('darwin')
  assert.equal(image.template, true)
  assert.equal(path.basename(image.filePath), 'trayTemplate.png')
  assert.equal(fs.existsSync(image.filePath.replace('.png', '@2x.png')), true)
  assert.equal(rawTray.tooltip, 'Mayuka')

  assert.equal(controller.isDestroyed(), false)
  assert.equal(shouldQuitAfterAllWindowsClosed(controller), false)
  controller.destroy()
  assert.equal(controller.isDestroyed(), true)
  assert.equal(shouldQuitAfterAllWindowsClosed(controller), true)
})

for (const [platform, filename] of [['win32', 'tray-color.ico'], ['linux', 'tray-color.png']]) {
  test(`${platform} 托盘使用彩色资源并保留原有 DPI 表示`, () => {
    const { image } = createTrayHarness(platform)
    assert.equal(path.basename(image.filePath), filename)
    assert.notEqual(image.template, true, '彩色图不能作为单色模板加载')
  })
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}：左键带 bounds 开关弹窗，右键弹菜单，不调用 setContextMenu`, () => {
    const { rawTray, events, calls } = createTrayHarness(platform)
    assert.equal(rawTray.contextMenu, null, 'setContextMenu 会在 macOS 接管左键')

    events.get('click')({}, { x: 10, y: 0, width: 22, height: 22 })
    assert.deepEqual(calls, [['toggle', { x: 10, y: 0, width: 22, height: 22 }]])

    // click 事件不带 bounds 时回退 Tray.getBounds()
    events.get('click')({})
    assert.deepEqual(calls[1], ['toggle', { x: 1200, y: 0, width: 24, height: 24 }])

    events.get('right-click')()
    assert.equal(rawTray.poppedUp.marker, true)
  })
}

test('linux：沿用 setContextMenu，click 直达完整设置', () => {
  const { rawTray, events, calls } = createTrayHarness('linux')
  assert.equal(rawTray.contextMenu.marker, true)
  assert.equal(events.has('right-click'), false)
  events.get('click')()
  assert.deepEqual(calls, [['settings']])
})

test('trayClickSupported 只对 darwin / win32 为真', () => {
  assert.equal(trayClickSupported('darwin'), true)
  assert.equal(trayClickSupported('win32'), true)
  assert.equal(trayClickSupported('linux'), false)
})
