'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  TRAY_POSES,
  DEFAULT_ASSETS_DIR,
  DEFAULT_POSE_HOLD_MIN_MS,
  DEFAULT_POSE_HOLD_MAX_MS,
  pickNextPoseId,
  pickPoseHoldMs,
  advanceFrameIndex,
  listPoseFramePaths,
  buildTrayMenuTemplate,
  createTrayController,
  shouldQuitAfterAllWindowsClosed,
} = require('../tray.cjs')

const REQUIRED_POSE_NAMES = [
  '躺平',
  '站立打招呼',
  '蹲下思考',
  '无聊发呆',
  '追蝴蝶',
  '从边缘伸头查看',
]

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

test('姿势目录覆盖全部六种中文姿势名与 id', () => {
  assert.equal(TRAY_POSES.length, 6)
  assert.deepEqual(
    TRAY_POSES.map((p) => p.name).sort(),
    [...REQUIRED_POSE_NAMES].sort(),
  )
  for (const pose of TRAY_POSES) {
    assert.match(pose.id, /^[a-z0-9-]+$/)
  }
})

test('pickNextPoseId 在多姿势时避开当前 id', () => {
  const ids = new Set()
  for (let i = 0; i < 40; i++) {
    ids.add(pickNextPoseId('lie-flat', TRAY_POSES, () => i / 40))
  }
  assert.equal(ids.has('lie-flat'), false)
  assert.ok(ids.size >= 2)
})

test('advanceFrameIndex 循环前进', () => {
  assert.equal(advanceFrameIndex(0, 4), 1)
  assert.equal(advanceFrameIndex(3, 4), 0)
  assert.equal(advanceFrameIndex(0, 0), 0)
})

test('pickPoseHoldMs 默认落在 30s–60s 闭区间', () => {
  assert.equal(DEFAULT_POSE_HOLD_MIN_MS, 30_000)
  assert.equal(DEFAULT_POSE_HOLD_MAX_MS, 60_000)
  assert.equal(pickPoseHoldMs(() => 0), 30_000)
  assert.equal(pickPoseHoldMs(() => 0.999999), 60_000)
  for (let i = 0; i < 30; i++) {
    const ms = pickPoseHoldMs(() => i / 30)
    assert.ok(ms >= 30_000 && ms <= 60_000, `out of range: ${ms}`)
  }
})

test('assets/tray 交付 gif/webm 与 PNG 帧（非空）', () => {
  assert.ok(fs.existsSync(DEFAULT_ASSETS_DIR), 'assets/tray must exist')
  for (const pose of TRAY_POSES) {
    const gif = path.join(DEFAULT_ASSETS_DIR, `${pose.id}.gif`)
    const webm = path.join(DEFAULT_ASSETS_DIR, `${pose.id}.webm`)
    assert.ok(fs.existsSync(gif), `missing gif for ${pose.name}`)
    assert.ok(fs.existsSync(webm), `missing webm for ${pose.name}`)
    assert.ok(fs.statSync(gif).size > 0, `empty gif for ${pose.name}`)
    assert.ok(fs.statSync(webm).size > 0, `empty webm for ${pose.name}`)
    const frames = listPoseFramePaths(DEFAULT_ASSETS_DIR, pose.id)
    assert.ok(frames.length >= 2, `need >=2 frames for ${pose.name}, got ${frames.length}`)
    for (const f of frames) {
      assert.ok(fs.statSync(f).size > 0, `empty frame ${f}`)
    }
  }
  // 旧彩色圆标已从 live tray 源移除
  const oldBadge = path.join(DEFAULT_ASSETS_DIR, '..', 'tray-icon.png')
  assert.equal(fs.existsSync(oldBadge), false, 'assets/tray-icon.png must be removed')
  const traySource = fs.readFileSync(path.join(__dirname, '..', 'tray.cjs'), 'utf8')
  assert.equal(traySource.includes('TRAY_ICON_DATA_URL'), false)
  assert.equal(traySource.includes('tray-icon.png'), false)
})

test('darwin 托盘使用 template image，并调度帧动画与随机姿势切换', () => {
  const events = new Map()
  const createdPaths = []
  const images = []
  let imageSeq = 0

  function makeImage(tag) {
    const img = {
      tag,
      template: undefined,
      resize(options) {
        assert.deepEqual(options, { width: 22, height: 22 })
        return this
      },
      setTemplateImage(value) {
        this.template = value
      },
    }
    images.push(img)
    return img
  }

  class FakeTray {
    constructor(icon) {
      this.icon = icon
      this.images = [icon]
      this.destroyed = false
    }
    setToolTip(value) {
      this.tooltip = value
    }
    setContextMenu(value) {
      this.menu = value
    }
    setImage(icon) {
      this.icon = icon
      this.images.push(icon)
    }
    on(name, callback) {
      events.set(name, callback)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  }

  const intervals = []
  const timeouts = []
  const setIntervalFn = (fn, ms) => {
    const handle = { kind: 'interval', fn, ms, id: intervals.length }
    intervals.push(handle)
    return handle
  }
  const clearIntervalFn = (handle) => {
    const idx = intervals.indexOf(handle)
    if (idx >= 0) intervals.splice(idx, 1)
  }
  const setTimeoutFn = (fn, ms) => {
    const handle = { kind: 'timeout', fn, ms, id: timeouts.length }
    timeouts.push(handle)
    return handle
  }
  const clearTimeoutFn = (handle) => {
    const idx = timeouts.indexOf(handle)
    if (idx >= 0) timeouts.splice(idx, 1)
  }

  // 伪随机：0.0, 0.2, 0.4... 可预测地换姿势与停留时长
  let randI = 0
  const random = () => {
    const v = (randI % 5) / 5
    randI += 1
    return v
  }

  const menu = { marker: true }
  const actions = {
    showAvatar() {},
    hideAvatar() {},
    resetAvatar() {},
    openSettings() {},
    quitApp() {},
  }

  const tray = createTrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ ...menu, template }) },
    nativeImage: {
      createFromPath(p) {
        createdPaths.push(p)
        assert.match(p, /assets[\\/]+tray[\\/]+frames[\\/]+/)
        assert.ok(!p.includes('tray-icon.png'), 'must not load old colorful badge')
        return makeImage(`path:${++imageSeq}`)
      },
      createEmpty() {
        return makeImage(`empty:${++imageSeq}`)
      },
      createFromDataURL() {
        return makeImage(`data:${++imageSeq}`)
      },
    },
    platform: 'darwin',
    actions,
    assetsDir: DEFAULT_ASSETS_DIR,
    frameIntervalMs: 10,
    // 测试用短区间；生产默认 30s–60s
    poseHoldMinMs: 40,
    poseHoldMaxMs: 60,
    random,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    initialPoseId: 'lie-flat',
  })

  assert.equal(tray.tooltip, 'Live2D Companion')
  assert.deepEqual(tray.menu.marker, true)
  assert.equal(events.has('click'), true)

  // 至少加载了真实 PNG 帧
  assert.ok(createdPaths.length >= 2, `expected frame paths, got ${createdPaths.length}`)
  assert.ok(
    createdPaths.every((p) => p.includes(`${path.sep}frames${path.sep}`) || p.includes('/frames/')),
  )

  // darwin template
  const templated = images.filter((img) => img.template === true)
  assert.ok(templated.length >= 1, 'expected setTemplateImage(true) on darwin frames')

  // 帧用 interval；姿势用 timeout 链式调度
  assert.equal(intervals.length, 1)
  assert.equal(timeouts.length, 1)
  const frameTimer = intervals.find((t) => t.ms === 10)
  assert.ok(frameTimer, 'frame timer')
  const firstPoseDelay = timeouts[0].ms
  assert.ok(firstPoseDelay >= 40 && firstPoseDelay <= 60, `pose delay ${firstPoseDelay}`)

  const beforeImages = tray.images.length
  // 推进若干帧
  frameTimer.fn()
  frameTimer.fn()
  assert.ok(tray.images.length > beforeImages, 'setImage should run on frame ticks')

  const stateBefore = tray.getTrayAnimationState()
  assert.equal(stateBefore.useTemplate, true)
  assert.equal(stateBefore.poseId, 'lie-flat')
  assert.equal(stateBefore.poseHoldMinMs, 40)
  assert.equal(stateBefore.poseHoldMaxMs, 60)
  assert.deepEqual(stateBefore.poseNames.sort(), [...REQUIRED_POSE_NAMES].sort())

  // 触发两次姿势切换（每次 fire 后会再 schedule 一个 timeout）
  const firePose = () => {
    assert.ok(timeouts.length >= 1, 'expected pending pose timeout')
    const t = timeouts[timeouts.length - 1]
    // 模拟到期：先清掉当前 handle，再执行回调（与 clearTimeout 后重 schedule 语义一致）
    clearTimeoutFn(t)
    t.fn()
  }
  firePose()
  firePose()
  const stateAfter = tray.getTrayAnimationState()
  assert.ok(stateAfter.poseHistory.length >= 3)
  assert.ok(
    stateAfter.poseHistory.some((id) => id !== 'lie-flat'),
    'random pose switch should leave initial pose',
  )
  assert.ok(stateAfter.setImageCount >= 1)
  assert.ok(stateAfter.poseHoldHistory.length >= 2)
  for (const ms of stateAfter.poseHoldHistory) {
    assert.ok(ms >= 40 && ms <= 60, `hold ${ms} out of test range`)
  }

  // destroy 清理定时器
  tray.destroy()
  assert.equal(intervals.length, 0)
  assert.equal(timeouts.length, 0)
  assert.equal(tray.destroyed, true)
})

test('非 darwin 不强制 template image', () => {
  const images = []
  function makeImage() {
    const img = {
      template: undefined,
      resize() {
        return this
      },
      setTemplateImage(v) {
        this.template = v
      },
    }
    images.push(img)
    return img
  }
  class FakeTray {
    constructor(icon) {
      this.icon = icon
    }
    setToolTip() {}
    setContextMenu() {}
    setImage() {}
    on() {}
    destroy() {}
  }
  createTrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: {
      createFromPath: () => makeImage(),
      createEmpty: () => makeImage(),
    },
    platform: 'linux',
    actions: {
      showAvatar() {},
      hideAvatar() {},
      openSettings() {},
      quitApp() {},
    },
    assetsDir: DEFAULT_ASSETS_DIR,
    poseHoldMinMs: 50,
    poseHoldMaxMs: 50,
    setInterval: (fn, ms) => ({ fn, ms }),
    clearInterval: () => {},
    setTimeout: (fn, ms) => ({ fn, ms }),
    clearTimeout: () => {},
  }).destroy()
  assert.ok(images.length >= 1)
  assert.ok(images.every((img) => img.template === undefined))
})
