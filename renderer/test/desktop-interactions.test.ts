import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clientPointToCanvas,
  clampWindowScale,
  isDragModeEnabled,
  isModifierPressed,
  isScaleModeEnabled,
  nextWindowScale,
  screenPointToLookDirection,
  shouldProcessMouseFollow,
  zoomDirectionForKey,
  zoomDirectionForWheel,
} from '../src/desktop-interactions.ts'

test('修饰键按平台分流：darwin 只认 Command，其余平台只认 Ctrl', () => {
  assert.equal(isModifierPressed({ metaKey: true, ctrlKey: false }, 'darwin'), true)
  assert.equal(isModifierPressed({ metaKey: false, ctrlKey: true }, 'darwin'), false)
  assert.equal(isModifierPressed({ metaKey: false, ctrlKey: true }, 'win32'), true)
  assert.equal(isModifierPressed({ metaKey: true, ctrlKey: false }, 'linux'), false)
})

test('按钮拖动/缩放模式与 S1 修饰键模式可同时工作', () => {
  assert.equal(isDragModeEnabled({ metaKey: false, ctrlKey: false }, 'darwin', true), true)
  assert.equal(isDragModeEnabled({ metaKey: true, ctrlKey: false }, 'darwin', false), true)
  assert.equal(isDragModeEnabled({ metaKey: false, ctrlKey: false }, 'darwin', false), false)
  assert.equal(isScaleModeEnabled({ metaKey: false, ctrlKey: false }, 'darwin', true), true)
  assert.equal(isScaleModeEnabled({ metaKey: true, ctrlKey: false }, 'darwin', false), true)
  assert.equal(isScaleModeEnabled({ metaKey: false, ctrlKey: false }, 'darwin', false), false)
})

test('顶部按钮热区内暂停眼神跟随，离开后恢复处理', () => {
  assert.equal(shouldProcessMouseFollow(true, true), false)
  assert.equal(shouldProcessMouseFollow(true, false), true)
  assert.equal(shouldProcessMouseFollow(false, false), false)
})

test('屏幕坐标按窗口中心归一化，Y 轴翻转并钳制到 [-1,1]', () => {
  const bounds = { x: 100, y: 200, width: 600, height: 400 }
  assert.deepEqual(screenPointToLookDirection({ x: 400, y: 400 }, bounds), { x: 0, y: 0 })
  assert.deepEqual(screenPointToLookDirection({ x: 100, y: 200 }, bounds), { x: -1, y: 1 })
  assert.deepEqual(screenPointToLookDirection({ x: 1000, y: 1000 }, bounds), { x: 1, y: -1 })
  assert.deepEqual(
    screenPointToLookDirection({ x: Number.NaN, y: 0 }, bounds),
    { x: 0, y: 0 },
  )
})

test('缩放步长为 0.05，main/renderer 共识范围为 0.5-1.75', () => {
  assert.equal(clampWindowScale(0.1), 0.5)
  assert.equal(clampWindowScale(3), 1.75)
  assert.equal(clampWindowScale(1.234), 1.23)
  assert.equal(clampWindowScale(Number.NaN), 1)
  assert.equal(nextWindowScale(1, 1), 1.05)
  assert.equal(nextWindowScale(1, -1), 0.95)
  assert.equal(nextWindowScale(1.75, 1), 1.75)
  assert.equal(nextWindowScale(0.5, -1), 0.5)
})

test('滚轮与键盘缩放方向只接受约定输入', () => {
  assert.equal(zoomDirectionForWheel(-1), 1)
  assert.equal(zoomDirectionForWheel(1), -1)
  assert.equal(zoomDirectionForWheel(0), 0)
  assert.equal(zoomDirectionForKey('='), 1)
  assert.equal(zoomDirectionForKey('+'), 1)
  assert.equal(zoomDirectionForKey('-'), -1)
  assert.equal(zoomDirectionForKey('_'), -1)
  assert.equal(zoomDirectionForKey('0'), 0)
})

test('CSS transform 缩放后仍按实际 rect 映射到 canvas 物理像素', () => {
  assert.deepEqual(
    clientPointToCanvas(
      { x: 400, y: 350 },
      { left: 100, top: 50, width: 600, height: 600 },
      { width: 1200, height: 1200 },
    ),
    { x: 600, y: 600 },
  )
  assert.deepEqual(
    clientPointToCanvas(
      { x: 400, y: 350 },
      { left: 250, top: 200, width: 300, height: 300 },
      { width: 1200, height: 1200 },
    ),
    { x: 600, y: 600 },
  )
})
