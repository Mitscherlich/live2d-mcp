'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildTrayMenuTemplate,
  createTrayController,
  shouldQuitAfterAllWindowsClosed,
} = require('../tray.cjs')

test('托盘菜单将显示、隐藏、设置与退出动作接到对应回调', () => {
  const calls = []
  const template = buildTrayMenuTemplate({
    showAvatar: () => calls.push('show'),
    hideAvatar: () => calls.push('hide'),
    openSettings: () => calls.push('settings'),
    quitApp: () => calls.push('quit'),
  })

  const actionable = template.filter((item) => item.type !== 'separator')
  assert.deepEqual(actionable.map((item) => item.label), [
    '显示角色窗',
    '隐藏角色窗',
    '打开设置',
    '退出',
  ])
  for (const item of actionable) item.click()
  assert.deepEqual(calls, ['show', 'hide', 'settings', 'quit'])
})

test('有可用托盘时 window-all-closed 保活；无托盘时退出', () => {
  assert.equal(shouldQuitAfterAllWindowsClosed(null), true)
  assert.equal(shouldQuitAfterAllWindowsClosed({ isDestroyed: () => false }), false)
  assert.equal(shouldQuitAfterAllWindowsClosed({ isDestroyed: () => true }), true)
})

test('托盘控制器使用内置图标并在 macOS 标记为模板图', () => {
  const events = new Map()
  const image = {
    resize(options) {
      assert.deepEqual(options, { width: 18, height: 18 })
      return this
    },
    setTemplateImage(value) {
      this.template = value
    },
  }
  class FakeTray {
    constructor(icon) {
      assert.equal(icon, image)
    }
    setToolTip(value) { this.tooltip = value }
    setContextMenu(value) { this.menu = value }
    on(name, callback) { events.set(name, callback) }
  }
  const menu = { marker: true }
  const actions = {
    showAvatar() {}, hideAvatar() {}, openSettings() {}, quitApp() {},
  }
  const tray = createTrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ ...menu, template }) },
    nativeImage: {
      createFromDataURL(dataUrl) {
        assert.match(dataUrl, /^data:image\/png;base64,/)
        return image
      },
    },
    platform: 'darwin',
    actions,
  })

  assert.equal(image.template, true)
  assert.equal(tray.tooltip, 'Live2D Companion')
  assert.deepEqual(tray.menu.marker, true)
  assert.equal(events.has('click'), true)
})
