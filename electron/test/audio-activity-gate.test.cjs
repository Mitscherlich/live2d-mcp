'use strict'

/**
 * audio-activity-gate.cjs 单测（ADR 0001 · F6）
 * 阈值转移 listening⇄speaking、900ms 静音释放、level clamp、reset 语义。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AudioActivityGate,
  DEFAULT_SPEECH_RELEASE_MS,
  DEFAULT_SPEECH_THRESHOLD,
} = require('../audio-activity-gate.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function collect(options = {}) {
  const events = []
  const gate = new AudioActivityGate({
    onActivity: (activity) => events.push(['activity', activity]),
    onLevel: (level) => events.push(['level', level]),
    ...options,
  })
  return { events, gate }
}

test('默认常量对齐 SPEC/persona：阈值 0.018，释放 900ms', () => {
  assert.equal(DEFAULT_SPEECH_THRESHOLD, 0.018)
  assert.equal(DEFAULT_SPEECH_RELEASE_MS, 900)
})

test('有声超过阈值 → speaking；电平先转发（clamp [0,1]）', () => {
  const { events, gate } = collect()
  gate.handleLevel(2.5) // 越界 clamp 到 1
  assert.deepEqual(events, [
    ['level', 1],
    ['activity', 'speaking'],
  ])
  gate.handleLevel(0.5) // 持续有声不重复发 activity
  assert.deepEqual(events[2], ['level', 0.5])
  assert.equal(events.length, 3)
})

test('低于阈值不进入 speaking；无声后 releaseMs 回落 listening 并补 level 0', async () => {
  const { events, gate } = collect({ speechReleaseMs: 30 })
  gate.handleLevel(0.001) // 低于阈值
  assert.deepEqual(events, [['level', 0.001]])

  gate.handleLevel(0.5)
  gate.handleLevel(0) // 无声，启动静音计时
  await sleep(60)
  assert.deepEqual(events, [
    ['level', 0.001],
    ['level', 0.5],
    ['activity', 'speaking'],
    ['level', 0],
    ['level', 0],
    ['activity', 'listening'],
  ])
})

test('静音窗口内恢复有声 → 不回落（句间保持）', async () => {
  const { events, gate } = collect({ speechReleaseMs: 40 })
  gate.handleLevel(0.5)
  gate.handleLevel(0)
  await sleep(20)
  gate.handleLevel(0.6) // 释放前恢复
  await sleep(60)
  const activities = events.filter(([kind]) => kind === 'activity')
  assert.deepEqual(activities, [['activity', 'speaking']])
})

test('会话已结束（shouldReturnToListening=false）→ 释放后不发 listening', async () => {
  const { events, gate } = collect({ speechReleaseMs: 20, shouldReturnToListening: () => false })
  gate.handleLevel(0.5)
  gate.handleLevel(0)
  await sleep(50)
  const activities = events.filter(([kind]) => kind === 'activity')
  assert.deepEqual(activities, [['activity', 'speaking']])
})

test('reset：清空 speaking 并按需补发 level 0', () => {
  const { events, gate } = collect()
  gate.handleLevel(0.5)
  gate.reset()
  assert.deepEqual(events.at(-1), ['level', 0])
  gate.handleLevel(0.5) // reset 后重新进入 speaking
  const activities = events.filter(([kind]) => kind === 'activity')
  assert.deepEqual(activities, [['activity', 'speaking'], ['activity', 'speaking']])
})

test('非法 level（NaN/Infinity）按 0 处理，不崩溃', () => {
  const { events, gate } = collect()
  gate.handleLevel(Number.NaN)
  gate.handleLevel(Number.POSITIVE_INFINITY) // 非有限数保守按无声（persona 同口径）
  assert.deepEqual(events, [
    ['level', 0],
    ['level', 0],
  ])
})
