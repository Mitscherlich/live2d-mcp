'use strict'

/**
 * audio-listener.cjs 单测（ADR 0001 · F6 · FR-V4）
 * 工厂：external → null（不启 native）；非 darwin → null + plan unsupported；
 * darwin 非 external → NativeProcessAudioListener 实例。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { createAudioListener, resolveListenerPlan } = require('../audio-listener.cjs')
const { NativeProcessAudioListener } = require('../native-process-audio-listener.cjs')

test('resolveListenerPlan：external → kind external（任何平台）', () => {
  assert.deepEqual(resolveListenerPlan({ voiceSource: { mode: 'external' }, platform: 'darwin' }), {
    kind: 'external',
    mode: 'external',
  })
  assert.equal(resolveListenerPlan({ voiceSource: { mode: 'external' }, platform: 'linux' }).kind, 'external')
})

test('resolveListenerPlan：非 darwin 非 external → unsupported-platform', () => {
  for (const mode of ['automatic', 'application', 'custom']) {
    const source =
      mode === 'custom'
        ? { mode, process_pattern: 'codex' }
        : mode === 'application'
          ? { mode, source_id: 'process:darwin:Q2hhdEdQVA', source_name: 'ChatGPT' }
          : { mode }
    const plan = resolveListenerPlan({ voiceSource: source, platform: 'linux' })
    assert.equal(plan.kind, 'unsupported-platform', mode)
    assert.equal(plan.platform, 'linux')
  }
})

test('resolveListenerPlan：darwin 非 external → native（非法 source 回退 automatic）', () => {
  assert.deepEqual(resolveListenerPlan({ voiceSource: { mode: 'automatic' }, platform: 'darwin' }), {
    kind: 'native',
    mode: 'automatic',
    platform: 'darwin',
  })
  // 非法 source（normalize 回退 automatic）仍走 native
  assert.equal(resolveListenerPlan({ voiceSource: { mode: 'nope' }, platform: 'darwin' }).kind, 'native')
})

test('createAudioListener：external → null（不创建任何监听器/进程）', () => {
  assert.equal(createAudioListener({ voiceSource: { mode: 'external' }, platform: 'darwin' }), null)
})

test('createAudioListener：非 darwin → null（plan 层报 unsupported，不 spawn）', () => {
  assert.equal(createAudioListener({ voiceSource: { mode: 'automatic' }, platform: 'linux' }), null)
  assert.equal(createAudioListener({ voiceSource: { mode: 'automatic' }, platform: 'win32' }), null)
})

test('createAudioListener：darwin automatic → NativeProcessAudioListener 实例（未启动）', () => {
  const listener = createAudioListener({
    voiceSource: { mode: 'automatic' },
    platform: 'darwin',
    helperPath: '/nonexistent/helper', // 仅构造，不 start
  })
  assert.ok(listener instanceof NativeProcessAudioListener)
  assert.equal(listener.helperPath, '/nonexistent/helper')
  assert.equal(listener.stopped, true)
})
