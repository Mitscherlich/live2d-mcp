/**
 * voice-state.ts 单测（ADR 0001 · F3）
 *
 * 运行：根 package.json `npm test`（Node ≥22.6 type-stripping 直接加载 .ts）。
 * 覆盖：activity 状态机（idle/listening/speaking）、level clamp、
 * 900ms 短静音保持、平滑曲线、嘴参别名解析。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VoiceStateMachine,
  LevelSmoother,
  resolveMouthParamId,
  clamp01,
  VOICE_DEFAULTS,
  MOUTH_PARAM_ALIASES,
} from '../src/voice-state.ts'

const HOLD = VOICE_DEFAULTS.silenceHoldMs // 900

test('clamp01：钳制到 [0,1]，非有限数归 0', () => {
  assert.equal(clamp01(0.5), 0.5)
  assert.equal(clamp01(1.7), 1)
  assert.equal(clamp01(-0.3), 0)
  assert.equal(clamp01(Number.NaN), 0)
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0)
})

test('初始 idle 不张嘴；仅 session 激活进入 listening 仍不张嘴', () => {
  const m = new VoiceStateMachine()
  assert.equal(m.activity, 'idle')
  assert.equal(m.mouthTarget(), 0)

  m.applySession(true, 1000)
  assert.equal(m.activity, 'listening')
  assert.equal(m.mouthTarget(), 0)
})

test('纯电平推导：listening 下注入 level 进入 speaking 且嘴参目标 > 0', () => {
  const m = new VoiceStateMachine()
  m.applySession(true, 0)
  m.applyLevel(0.5, 16)
  assert.equal(m.activity, 'speaking')
  assert.equal(m.level, 0.5)
  // 0.5 * gain(2.8) = 1.4 → clamp 1
  assert.equal(m.mouthTarget(), 1)
})

test('纯电平推导：无 state 事件时仅注入 level 也进入 speaking（G2 语义）', () => {
  const m = new VoiceStateMachine()
  assert.equal(m.activity, 'idle')
  m.applyLevel(0.4, 100)
  assert.equal(m.activity, 'speaking')
  assert.ok(m.mouthTarget() > 0)
})

test('level clamp：越界与非法输入被钳制；低于阈值不触发 speaking', () => {
  const m = new VoiceStateMachine()
  m.applySession(true, 0)
  m.applyLevel(1.7, 10)
  assert.equal(m.level, 1)
  assert.equal(m.activity, 'speaking')

  const m2 = new VoiceStateMachine()
  m2.applySession(true, 0)
  m2.applyLevel(Number.NaN, 10)
  assert.equal(m2.level, 0)
  assert.equal(m2.activity, 'listening')

  const m3 = new VoiceStateMachine()
  m3.applySession(true, 0)
  m3.applyLevel(VOICE_DEFAULTS.speechThreshold, 10) // 恰好阈值（非超过）不算有声
  assert.equal(m3.activity, 'listening')
})

test('短静音保持：speaking 期间 level 归零，900ms 内保持 speaking，超时回落 listening', () => {
  const m = new VoiceStateMachine()
  m.applySession(true, 0)
  m.applyLevel(0.6, 1000)
  assert.equal(m.activity, 'speaking')

  // 句间停顿开始：level 归零
  m.applyLevel(0, 2000)
  // hold 期内（2000+899 < 2000+900）保持 speaking，嘴仍可按最近 level 目标工作
  m.update(2899)
  assert.equal(m.activity, 'speaking')
  // 边界：恰好 900ms 达到即回落
  m.update(2900)
  assert.equal(m.activity, 'listening')
  // 回落后嘴参目标为 0
  assert.equal(m.mouthTarget(), 0)
})

test('短静音保持：hold 期内 level 恢复则保持 speaking 不抖动', () => {
  const m = new VoiceStateMachine()
  m.applyLevel(0.6, 0)
  m.applyLevel(0, 100) // 停顿 100ms
  m.update(500)
  assert.equal(m.activity, 'speaking')
  m.applyLevel(0.5, 600) // 恢复发声（hold 期内）
  m.update(600 + HOLD - 1)
  assert.equal(m.activity, 'speaking')
  assert.ok(m.mouthTarget() > 0)
})

test('显式 activity 注入：speaking/listening/idle 语义与回落目标', () => {
  const m = new VoiceStateMachine()
  m.applyActivity('speaking', 1000)
  assert.equal(m.activity, 'speaking')
  // 显式 speaking 但 level 一直为 0：hold 超时后回落到 listening（有声源语义）
  m.update(1000 + HOLD)
  assert.equal(m.activity, 'listening')

  m.applyActivity('idle', 5000)
  assert.equal(m.activity, 'idle')
  m.applyActivity('listening', 6000)
  assert.equal(m.activity, 'listening')
})

test('session 结束立即回 idle 且嘴闭；此后纯电平可重新激活（新会话）', () => {
  const m = new VoiceStateMachine()
  m.applySession(true, 0)
  m.applyLevel(0.8, 10)
  assert.equal(m.activity, 'speaking')

  m.applySession(false, 100)
  assert.equal(m.activity, 'idle')
  assert.equal(m.level, 0)
  assert.equal(m.mouthTarget(), 0)
  // update 不应把 idle 变成别的
  m.update(100 + HOLD * 2)
  assert.equal(m.activity, 'idle')

  m.applyLevel(0.5, 5000)
  assert.equal(m.activity, 'speaking')
})

test('applyEvent：state 事件 phase 映射（active→listening、inactive→idle）', () => {
  const m = new VoiceStateMachine()
  m.applyEvent({ type: 'state', state: { phase: 'active' } }, 0)
  assert.equal(m.activity, 'listening')

  m.applyEvent({ type: 'state', state: { phase: 'active', activity: 'speaking' } }, 10)
  assert.equal(m.activity, 'speaking')

  m.applyEvent({ type: 'audio-level', level: 0.3 }, 20)
  assert.equal(m.level, 0.3)
  assert.ok(m.mouthTarget() > 0)

  m.applyEvent({ type: 'state', state: { phase: 'inactive' } }, 30)
  assert.equal(m.activity, 'idle')
  assert.equal(m.mouthTarget(), 0)
})

test('applyEvent：state 仅 activity 省略 phase 时直接映射', () => {
  const m = new VoiceStateMachine()
  m.applyEvent({ type: 'state', state: { activity: 'speaking' } }, 100)
  assert.equal(m.activity, 'speaking')
  m.applyEvent({ type: 'state', state: { activity: 'listening' } }, 200)
  assert.equal(m.activity, 'listening')
})

test('嘴参目标：非 speaking 或 level 低于 audibleFloor 时为 0', () => {
  const m = new VoiceStateMachine()
  m.applySession(true, 0)
  assert.equal(m.mouthTarget(), 0)

  // 高于 speechThreshold 才进入 speaking；speaking 后回落到 floor 以下 → 目标 0
  m.applyLevel(0.05, 10)
  assert.equal(m.activity, 'speaking')
  assert.ok(m.mouthTarget() > 0)
  m.applyLevel(VOICE_DEFAULTS.audibleFloor, 20)
  assert.equal(m.mouthTarget(), 0)
})

test('LevelSmoother：上升快（attack）下降慢（release），收敛到目标', () => {
  const s = new LevelSmoother({ attackMs: 55, releaseMs: 100 })
  // 上升：55ms 一阶常数，约 5 个常数级（~275ms）基本到顶
  let v = 0
  for (let i = 0; i < 20; i++) v = s.tick(16.7, 1)
  assert.ok(v > 0.9, `20 帧后应接近 1，实际 ${v}`)

  // 下降：release 更慢——同帧数下离目标更远
  const peak = s.value
  let down = peak
  for (let i = 0; i < 20; i++) down = s.tick(16.7, 0)
  assert.ok(down > 0 && down < peak, `下降应进行中，实际 ${down}`)

  // 单调性：上升段严格递增
  const s2 = new LevelSmoother({ attackMs: 55, releaseMs: 100 })
  let prev = -1
  for (let i = 0; i < 10; i++) {
    const cur = s2.tick(16.7, 1)
    assert.ok(cur > prev, '上升段应严格递增')
    prev = cur
  }
})

test('LevelSmoother：dt 非法时不变；贴近目标后吸附避免抖动', () => {
  const s = new LevelSmoother()
  assert.equal(s.tick(0, 1), 0)
  assert.equal(s.tick(Number.NaN, 1), 0)
  for (let i = 0; i < 200; i++) s.tick(16.7, 1)
  assert.equal(s.value, 1) // 吸附到精确目标
  s.reset()
  assert.equal(s.value, 0)
})

test('resolveMouthParamId：首选 ParamMouthOpenY，兼容别名与大小写，无匹配返回 null', () => {
  assert.equal(MOUTH_PARAM_ALIASES[0], 'ParamMouthOpenY')
  assert.equal(
    resolveMouthParamId(['ParamAngleZ', 'ParamMouthOpenY', 'ParamEyeLOpen']),
    'ParamMouthOpenY',
  )
  assert.equal(resolveMouthParamId(['PARAM_MOUTH_OPEN_Y']), 'PARAM_MOUTH_OPEN_Y')
  assert.equal(resolveMouthParamId(['parammouthopeny']), 'parammouthopeny') // 大小写不敏感，返回原 id
  assert.equal(resolveMouthParamId(['ParamMouthOpen']), 'ParamMouthOpen')
  assert.equal(resolveMouthParamId(['ParamAngleZ']), null)
  assert.equal(resolveMouthParamId([]), null)
})

test('可配置常量：自定义 silenceHoldMs 生效', () => {
  const m = new VoiceStateMachine({ silenceHoldMs: 200 })
  m.applyLevel(0.6, 0)
  m.applyLevel(0, 50)
  m.update(249)
  assert.equal(m.activity, 'speaking')
  m.update(250)
  assert.equal(m.activity, 'listening')
})
