/**
 * voice-state.ts 单测（ADR 0001 · F3）
 *
 * 运行：根 package.json `bun test`（Node ≥22.6 type-stripping 直接加载 .ts）。
 * 覆盖：activity 状态机（idle/listening/speaking）、level clamp、
 * 900ms 短静音保持、平滑曲线、嘴参别名解析。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import {
  VoiceStateMachine,
  LevelSmoother,
  PseudoVisemeMapper,
  resolveMouthParamId,
  resolveMouthFormParamId,
  selectVoiceBodyMotion,
  mapOpenToParamRange,
  mapFormToParamRange,
  clamp01,
  VOICE_DEFAULTS,
  MOUTH_PARAM_ALIASES,
  MOUTH_FORM_PARAM_ALIASES,
} from '../src/voice-state.ts'
import { createVoiceLipSync } from '../src/lip-sync.ts'

const HOLD = VOICE_DEFAULTS.silenceHoldMs // 900

const requireCjs = createRequire(import.meta.url)

test('跨侧一致性：native listener 的会话可闻阈值 === VOICE_DEFAULTS.audibleFloor', () => {
  // main 侧 SESSION_AUDIBLE_LEVEL 决定「这段声音算不算一次会话」，renderer 侧
  // audibleFloor 决定「这段声音要不要张嘴」。两者是同一条 level 流上的同一个判定，
  // 一旦漂移，会出现「会话已开但嘴不动」或反之的错位。native listener 为纯 Node
  // 模块（import 期只 require fs/path/child_process 与纯模块，无副作用），可直接 require。
  const { SESSION_AUDIBLE_LEVEL } = requireCjs('../../electron/native-process-audio-listener.cjs')
  assert.equal(SESSION_AUDIBLE_LEVEL, VOICE_DEFAULTS.audibleFloor)
})

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

test('resolveMouthFormParamId：解析 ParamMouthForm 别名，无匹配 null', () => {
  assert.equal(MOUTH_FORM_PARAM_ALIASES[0], 'ParamMouthForm')
  assert.equal(
    resolveMouthFormParamId(['ParamMouthOpenY', 'ParamMouthForm']),
    'ParamMouthForm',
  )
  assert.equal(resolveMouthFormParamId(['PARAM_MOUTH_FORM']), 'PARAM_MOUTH_FORM')
  assert.equal(resolveMouthFormParamId(['ParamMouthOpenY']), null)
})

test('selectVoiceBodyMotion：speaking 与 idle/listening 在 Idle index 与 priority 上可区分', () => {
  const speaking = selectVoiceBodyMotion('speaking')
  const listening = selectVoiceBodyMotion('listening')
  const idle = selectVoiceBodyMotion('idle')
  assert.equal(speaking.group, 'Idle')
  assert.equal(listening.group, 'Idle')
  assert.equal(idle.group, 'Idle')
  // 行为差：index 与 priority 至少一项不同
  assert.notEqual(
    `${speaking.index}:${speaking.priority}`,
    `${listening.index}:${listening.priority}`,
  )
  assert.deepEqual(listening, idle)
  assert.equal(speaking.index, 1)
  assert.equal(speaking.priority, 2)
  assert.equal(listening.index, 0)
  assert.equal(listening.priority, 1)
})

test('PseudoVisemeMapper：峰值 cap、静音归零、相位推进使 open/form 变化', () => {
  const v = new PseudoVisemeMapper()
  // 静音
  const z = v.tick(16.7, 0)
  assert.equal(z.open, 0)
  assert.equal(z.form, 0)

  const opens: number[] = []
  const forms: number[] = []
  for (let i = 0; i < 90; i++) {
    const o = v.tick(16.7, 1)
    opens.push(o.open)
    forms.push(o.form)
    assert.ok(o.open <= VOICE_DEFAULTS.peakCap + 1e-9, `open 应 ≤ peakCap，实际 ${o.open}`)
    assert.ok(o.open >= 0)
    assert.ok(o.form >= -1 && o.form <= 1)
  }
  assert.ok(Math.max(...opens) > 0.2, '高强度应有可观开合')
  assert.ok(Math.max(...opens) <= VOICE_DEFAULTS.peakCap + 1e-9)
  // form 在说话期间应出现变化（非恒定）
  const formDistinct = new Set(forms.map((f) => f.toFixed(2)))
  assert.ok(formDistinct.size > 2, `form 应随相位变化，distinct=${formDistinct.size}`)
  const openDistinct = new Set(opens.map((o) => o.toFixed(2)))
  assert.ok(openDistinct.size > 1, 'open 应有 flutter/相位引起的变化')

  // 归零
  const closed = v.tick(16.7, 0)
  assert.equal(closed.open, 0)
  assert.equal(closed.form, 0)
})

test('mapOpen/mapForm：范围映射保留 cap 与 form 对称域', () => {
  assert.equal(mapOpenToParamRange(0, 0, 1), 0)
  assert.ok(Math.abs(mapOpenToParamRange(0.62, 0, 1) - 0.62) < 1e-9)
  assert.equal(mapFormToParamRange(-1, -1, 1), -1)
  assert.equal(mapFormToParamRange(1, -1, 1), 1)
  assert.ok(Math.abs(mapFormToParamRange(0, -1, 1) - 0) < 1e-9)
  assert.equal(mapFormToParamRange(0, 0, 1), 0.5)
})

test('createVoiceLipSync 多维写参：开合+嘴形双 id、峰值 cap、静音回落、silenceHold', () => {
  const writes: Array<{ paramId: string | null; value: number }> = []
  let now = 0
  const lip = createVoiceLipSync({
    mouthParam: { id: 'ParamMouthOpenY', min: 0, max: 1 },
    formParam: { id: 'ParamMouthForm', min: -1, max: 1 },
    writeMouth: (paramId, value) => writes.push({ paramId, value }),
    now: () => now,
  })
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      now += 16.7
      lip.tick(16.7)
    }
  }

  frames(5)
  assert.equal(writes.length, 0, 'idle 不写嘴')

  // 持续注入 level，避免 silenceHold 看门狗在无后续 level 时把 speaking 收回
  for (let i = 0; i < 50; i++) {
    lip.handleEvent({ type: 'audio-level', level: 0.9 })
    now += 16.7
    lip.tick(16.7)
  }
  const openWrites = writes.filter((w) => w.paramId === 'ParamMouthOpenY')
  const formWrites = writes.filter((w) => w.paramId === 'ParamMouthForm')
  assert.ok(openWrites.length > 0, '应写开合')
  assert.ok(formWrites.length > 0, '应写嘴形')
  assert.ok(
    openWrites.every((w) => w.value <= VOICE_DEFAULTS.peakCap + 0.02),
    '开合受 peakCap 约束',
  )
  const formVals = new Set(formWrites.map((w) => w.value.toFixed(2)))
  assert.ok(formVals.size > 1, `嘴形应非恒定 distinct=${formVals.size}`)

  const snap = lip.snapshot()
  assert.equal(snap.activity, 'speaking')
  assert.equal(snap.mouthParamId, 'ParamMouthOpenY')
  assert.equal(snap.formParamId, 'ParamMouthForm')
  assert.ok(snap.openWrites > 0 && snap.formWrites > 0)

  // 静音：嘴回落，activity 在 hold 内仍 speaking
  lip.handleEvent({ type: 'audio-level', level: 0 })
  frames(30) // ~500ms
  assert.equal(lip.snapshot().activity, 'speaking')
  assert.ok(lip.snapshot().smoothedMouth < 0.25)
  frames(40) // 累计 >900ms
  assert.equal(lip.snapshot().activity, 'listening')
  frames(40)
  assert.ok(lip.snapshot().lastMouthWrite < 0.02)
  assert.ok(Math.abs(lip.snapshot().lastFormWrite) < 0.05)
})

test('createVoiceLipSync：缺 form 参时仅写开合，form 快照仍推进；缺开合 no-op 不抛', () => {
  const writes: Array<{ paramId: string | null; value: number }> = []
  let now = 0
  const lip = createVoiceLipSync({
    mouthParam: { id: 'ParamMouthOpenY', min: 0, max: 1 },
    formParam: null,
    writeMouth: (paramId, value) => writes.push({ paramId, value }),
    now: () => now,
  })
  lip.handleEvent({ type: 'audio-level', level: 0.7 })
  for (let i = 0; i < 40; i++) {
    now += 16.7
    lip.tick(16.7)
  }
  assert.ok(writes.every((w) => w.paramId === 'ParamMouthOpenY'))
  assert.ok(lip.snapshot().formWrites === 0)
  // form 归一化值仍可能非零（快照），但不写模型
  assert.equal(lip.snapshot().formParamId, null)

  const lip2 = createVoiceLipSync({
    mouthParam: null,
    formParam: null,
    writeMouth: (paramId, value) => writes.push({ paramId, value }),
    now: () => now,
  })
  lip2.handleEvent({ type: 'audio-level', level: 0.5 })
  assert.doesNotThrow(() => {
    for (let i = 0; i < 10; i++) {
      now += 16.7
      lip2.tick(16.7)
    }
  })
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
