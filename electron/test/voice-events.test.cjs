'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  VOICE_EVENT_CHANNEL,
  VOICE_INJECT_CHANNEL,
  normalizeVoiceEvent,
} = require('../voice-events.cjs')

test('IPC 通道名稳定（preload / renderer / F4 bridge 依赖其语义）', () => {
  assert.equal(VOICE_EVENT_CHANNEL, 'live2d:voice')
  assert.equal(VOICE_INJECT_CHANNEL, 'live2d:voice-inject')
})

test('audio-level：合法 level 原样通过', () => {
  assert.deepEqual(normalizeVoiceEvent({ type: 'audio-level', level: 0.31 }), {
    type: 'audio-level',
    level: 0.31,
  })
  assert.deepEqual(normalizeVoiceEvent({ type: 'audio-level', level: 0 }), {
    type: 'audio-level',
    level: 0,
  })
})

test('audio-level：level 越界 clamp 到 [0,1]（SPEC §8.2）', () => {
  assert.deepEqual(normalizeVoiceEvent({ type: 'audio-level', level: 1.9 }), {
    type: 'audio-level',
    level: 1,
  })
  assert.deepEqual(normalizeVoiceEvent({ type: 'audio-level', level: -2 }), {
    type: 'audio-level',
    level: 0,
  })
})

test('audio-level：非有限/非数字 level 拒绝', () => {
  assert.equal(normalizeVoiceEvent({ type: 'audio-level', level: Number.NaN }), null)
  assert.equal(normalizeVoiceEvent({ type: 'audio-level', level: Number.POSITIVE_INFINITY }), null)
  assert.equal(normalizeVoiceEvent({ type: 'audio-level', level: '0.5' }), null)
  assert.equal(normalizeVoiceEvent({ type: 'audio-level' }), null)
  assert.equal(normalizeVoiceEvent({ type: 'audio-level', level: null }), null)
})

test('state：SPEC §8.1 完整形状通过，字段白名单化', () => {
  const out = normalizeVoiceEvent({
    type: 'state',
    state: { phase: 'active', activity: 'speaking', microphoneMuted: false, outputMuted: true },
  })
  assert.deepEqual(out, {
    type: 'state',
    state: { phase: 'active', activity: 'speaking', microphoneMuted: false, outputMuted: true },
  })
})

test('state：仅 phase 或仅 activity 亦可；两者皆无则拒绝', () => {
  assert.deepEqual(normalizeVoiceEvent({ type: 'state', state: { phase: 'inactive' } }), {
    type: 'state',
    state: { phase: 'inactive' },
  })
  assert.deepEqual(normalizeVoiceEvent({ type: 'state', state: { activity: 'listening' } }), {
    type: 'state',
    state: { activity: 'listening' },
  })
  assert.equal(normalizeVoiceEvent({ type: 'state', state: {} }), null)
  assert.equal(normalizeVoiceEvent({ type: 'state' }), null)
})

test('state：枚举外 phase/activity 与非布尔 muted 拒绝（NFR-3）', () => {
  assert.equal(normalizeVoiceEvent({ type: 'state', state: { phase: 'speaking' } }), null)
  assert.equal(normalizeVoiceEvent({ type: 'state', state: { phase: 'ACTIVE' } }), null)
  assert.equal(normalizeVoiceEvent({ type: 'state', state: { activity: 'talking' } }), null)
  assert.equal(normalizeVoiceEvent({ type: 'state', state: { activity: 1 } }), null)
  assert.equal(
    normalizeVoiceEvent({ type: 'state', state: { phase: 'active', microphoneMuted: 'no' } }),
    null,
  )
})

test('顶层形状：非对象、未知 type、数组一律拒绝', () => {
  assert.equal(normalizeVoiceEvent(null), null)
  assert.equal(normalizeVoiceEvent(undefined), null)
  assert.equal(normalizeVoiceEvent('state'), null)
  assert.equal(normalizeVoiceEvent([]), null)
  assert.equal(normalizeVoiceEvent({ type: 'state', state: ['active'] }), null)
  assert.equal(normalizeVoiceEvent({ type: 'motion', group: 'Idle' }), null)
  assert.equal(normalizeVoiceEvent({ type: 42 }), null)
})

test('未知字段被剥离（不穿透到 renderer）', () => {
  assert.deepEqual(
    normalizeVoiceEvent({ type: 'audio-level', level: 0.5, hack: 'x', nested: { a: 1 } }),
    { type: 'audio-level', level: 0.5 },
  )
  assert.deepEqual(
    normalizeVoiceEvent({ type: 'state', state: { activity: 'speaking', evil: true } }),
    { type: 'state', state: { activity: 'speaking' } },
  )
})
