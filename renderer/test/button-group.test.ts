import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  BUTTON_GROUP_HIDE_DELAY,
  BUTTON_HOTSPOT_HEIGHT,
  LOCK_HOTSPOT_HEIGHT,
  MOUSE_IGNORE_DEBOUNCE_MS,
  createButtonGroupState,
  isUnlockShortcut,
} from '../src/button-group.ts'

function createManualTimers() {
  let nextId = 0
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  return {
    schedule(callback: () => void, delayMs: number) {
      const id = nextId++
      timers.set(id, { callback, delayMs })
      return id
    },
    cancel(id: unknown) {
      timers.delete(id as number)
    },
    latest() {
      return [...timers.values()].at(-1)
    },
    runLatest() {
      const entry = [...timers.entries()].at(-1)
      if (!entry) return
      timers.delete(entry[0])
      entry[1].callback()
    },
  }
}

test('按钮组默认隐藏，进入 48px 热区显示，离开后 800ms 延迟隐藏', () => {
  const timers = createManualTimers()
  const hotspotChanges: boolean[] = []
  const controller = createButtonGroupState({
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  controller.onHotspotChange((active) => hotspotChanges.push(active))

  assert.equal(BUTTON_HOTSPOT_HEIGHT, 48)
  assert.equal(BUTTON_GROUP_HIDE_DELAY, 800)
  assert.equal(controller.isVisible(), false)

  controller.setHotspotActive(true)
  assert.equal(controller.isVisible(), true)
  assert.deepEqual(hotspotChanges, [true])

  controller.setHotspotActive(false)
  assert.equal(controller.isVisible(), true)
  assert.equal(timers.latest()?.delayMs, 800)
  timers.runLatest()
  assert.equal(controller.isVisible(), false)
  assert.deepEqual(hotspotChanges, [true, false])
})

test('拖动与缩放状态互斥，任一激活状态都会阻止自动隐藏', () => {
  const timers = createManualTimers()
  const controller = createButtonGroupState({
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  controller.show()
  controller.setDragging(true)
  assert.equal(controller.isDragging(), true)
  assert.equal(controller.isScaling(), false)
  controller.setHotspotActive(false)
  assert.equal(controller.isVisible(), true)
  assert.equal(timers.latest(), undefined)

  controller.setScaling(true)
  assert.equal(controller.isDragging(), false)
  assert.equal(controller.isScaling(), true)
  controller.setScaling(false)
  assert.equal(controller.isVisible(), true)
  timers.runLatest()
  assert.equal(controller.isVisible(), false)

  controller.setHotspotActive(true)
  controller.setDragging(true)
  controller.setDragging(false)
  controller.setHotspotActive(false)
  assert.equal(controller.isVisible(), true)
  timers.runLatest()
  assert.equal(controller.isVisible(), false)
})

test('锁定状态调用鼠标穿透回调、关闭拖动/缩放并默认隐藏', () => {
  const timers = createManualTimers()
  const ignores: boolean[] = []
  const controller = createButtonGroupState({
    schedule: timers.schedule,
    cancel: timers.cancel,
    onMouseIgnoreChange: (ignore) => ignores.push(ignore),
  })

  controller.setDragging(true)
  controller.setLocked(true)
  assert.deepEqual(ignores, [true])
  assert.equal(controller.isLocked(), true)
  assert.equal(controller.isDragging(), false)
  assert.equal(controller.isScaling(), false)
  // 锁定时默认隐藏
  assert.equal(controller.isVisible(), false)

  // 全局鼠标流持续上报：光标在热区外，先解除"锁定瞬间仍在热区"的抑制
  controller.setLockHotspotActive(false)

  // 悬浮到热区时显示，防抖后临时恢复交互
  controller.setLockHotspotActive(true)
  assert.equal(controller.isVisible(), true)
  timers.runLatest()
  assert.deepEqual(ignores, [true, false])

  // 离开热区后防抖恢复穿透（latest 为 100ms 防抖），再跑 800ms 隐藏
  controller.setLockHotspotActive(false)
  timers.runLatest()
  assert.deepEqual(ignores, [true, false, true])
  timers.runLatest()
  assert.equal(controller.isVisible(), false)

  controller.setLocked(false)
  assert.deepEqual(ignores, [true, false, true, false])
})

test('锁定热区进入/离开以 100ms 防抖临时恢复或重新启用鼠标穿透', () => {
  const timers = createManualTimers()
  const ignores: boolean[] = []
  const controller = createButtonGroupState({
    schedule: timers.schedule,
    cancel: timers.cancel,
    onMouseIgnoreChange: (ignore) => ignores.push(ignore),
  })

  assert.equal(LOCK_HOTSPOT_HEIGHT, 40)
  assert.equal(MOUSE_IGNORE_DEBOUNCE_MS, 100)
  controller.setLocked(true)
  assert.deepEqual(ignores, [true])

  // 光标本就在热区外：全局鼠标流的首次"离开"上报解除锁定抑制
  controller.setLockHotspotActive(false)

  controller.setLockHotspotActive(true)
  assert.equal(controller.isLockHotspotActive(), true)
  assert.equal(timers.latest()?.delayMs, 100)
  assert.deepEqual(ignores, [true], '进入热区不能立即反复切换 IPC')
  timers.runLatest()
  assert.deepEqual(ignores, [true, false])

  controller.setLockHotspotActive(false)
  assert.equal(timers.latest()?.delayMs, 100)
  timers.runLatest()
  assert.deepEqual(ignores, [true, false, true])

  // 100ms 内快速往返时，后一个状态取消前一个穿透防抖，不应产生多余切换；
  // 但离开热区后仍需调度 800ms 延迟隐藏，否则锁定态下工具条常驻。
  controller.setLockHotspotActive(true)
  controller.setLockHotspotActive(false)
  assert.deepEqual(ignores, [true, false, true])
  assert.equal(timers.latest()?.delayMs, 800)
  timers.runLatest()
  assert.equal(controller.isVisible(), false)
})

test('解锁快捷键按平台选择 Command/Ctrl，且不要求热区状态', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: true, key: 'l' }
  assert.equal(isUnlockShortcut({ ...base, metaKey: true }, 'darwin'), true)
  assert.equal(isUnlockShortcut({ ...base, ctrlKey: true }, 'win32'), true)
  assert.equal(isUnlockShortcut({ ...base, metaKey: true }, 'win32'), false)
  assert.equal(isUnlockShortcut({ ...base, ctrlKey: true }, 'darwin'), false)
  assert.equal(isUnlockShortcut({ ...base, ctrlKey: true, shiftKey: false }, 'linux'), false)
  assert.equal(isUnlockShortcut({ ...base, ctrlKey: true, key: 'L' }, 'linux'), true)
})

test('锁定瞬间鼠标仍在热区时抑制唤出，离开后再悬浮才显示', () => {
  const timers = createManualTimers()
  const controller = createButtonGroupState({
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  controller.setLocked(true)
  // 锁定瞬间鼠标仍停在热区（刚点完锁定按钮）：全局流持续上报"在热区"
  controller.setLockHotspotActive(true)
  controller.setLockHotspotActive(true)
  assert.equal(controller.isLockHotspotActive(), false)
  assert.equal(controller.isVisible(), false, '抑制期间不因悬浮信号唤出工具条')

  // 鼠标离开热区 → 抑制解除
  controller.setLockHotspotActive(false)
  assert.equal(controller.isVisible(), false)

  // 再次悬浮 → 正常唤出
  controller.setLockHotspotActive(true)
  assert.equal(controller.isLockHotspotActive(), true)
  assert.equal(controller.isVisible(), true)

  // 解锁后抑制标志清除，下次锁定重新生效
  controller.setLocked(false)
  controller.setLocked(true)
  controller.setLockHotspotActive(true)
  assert.equal(controller.isVisible(), false, '重新锁定后抑制再次生效')
})

test('锁定时强制退出按钮热区并广播，避免穿透态热区滞留暂停眼神跟随', () => {
  const timers = createManualTimers()
  const hotspotChanges: boolean[] = []
  const controller = createButtonGroupState({
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  controller.onHotspotChange((active) => hotspotChanges.push(active))

  controller.setHotspotActive(true)
  assert.equal(controller.isHotspotActive(), true)
  controller.setLocked(true)
  assert.equal(controller.isHotspotActive(), false)
  assert.deepEqual(hotspotChanges, [true, false])
})

test('index.html 使用纯 SVG 的四个圆形按钮并声明热区可见性样式', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.equal((html.match(/<button type="button" data-action="(?:drag|scale|lock|settings)"/g) ?? []).length, 4)
  assert.equal((html.match(/<svg viewBox=/g) ?? []).length, 4)
  assert.match(html, /height: 48px/)
  assert.match(html, /opacity: 0;/)
  assert.match(html, /pointer-events: none;/)
  assert.match(html, /#button-group\.visible[\s\S]*?opacity: 1;/)
  assert.match(html, /transition: opacity 0\.2s ease-in-out/)
  assert.match(html, /#button-group[\s\S]*?-webkit-app-region: no-drag/)
  assert.match(html, /id="lock-hotspot"/)
  assert.match(html, /#lock-hotspot[\s\S]*?height: 40px/)
  assert.match(html, /#lock-hotspot\.locked[\s\S]*?pointer-events: auto;/)
  assert.match(html, /#button-group\.locked[\s\S]*?opacity: 0;[\s\S]*?scale\(0\.84\)/)
  assert.match(html, /#button-group\.locked\.visible[\s\S]*?opacity: 1;/)
  // 锁定态只展示解锁按钮
  assert.match(html, /#button-group\.locked \[data-action="drag"\][\s\S]*?\[data-action="settings"\][\s\S]*?display: none;/)
  assert.match(html, /data-lock-status hidden>已锁定</)
})
