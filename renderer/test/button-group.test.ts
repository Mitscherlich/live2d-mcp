import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  BUTTON_GROUP_HIDE_DELAY,
  BUTTON_HOTSPOT_HEIGHT,
  createButtonGroupState,
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

test('锁定状态调用鼠标穿透回调、关闭拖动/缩放并保持缩小态可见', () => {
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
  assert.equal(controller.isVisible(), true)

  controller.setHotspotActive(false)
  assert.equal(controller.isVisible(), true)
  controller.setLocked(false)
  assert.deepEqual(ignores, [true, false])
  timers.runLatest()
  assert.equal(controller.isVisible(), false)
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
  assert.match(html, /data-lock-status hidden>已锁定</)
})
