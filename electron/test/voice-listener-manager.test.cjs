'use strict'

/**
 * voice-listener-manager.cjs 单测（ADR 0001 · F6/F7）
 *
 * 覆盖：配置解析与热更新、世代号吸收陈旧 listener 回调（替代身份守卫）、
 * summary 形状、状态日志模板、start 失败路径。fake createAudioListener 注入，
 * 不触碰真实 native helper。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { VoiceListenerManager } = require('../voice-listener-manager.cjs')

function makeManager({ listenerFactory, environment = {}, onVoiceEvent, onStatusChanged, logger } = {}) {
  const events = []
  const statuses = []
  const logs = { log: [], warn: [], error: [] }
  const manager = new VoiceListenerManager({
    platform: 'darwin',
    isPackaged: false,
    resourcesPath: '/tmp',
    environment,
    onVoiceEvent: onVoiceEvent ?? ((event) => events.push(event)),
    onStatusChanged: onStatusChanged ?? (() => statuses.push('changed')),
    logger: logger ?? {
      log: (line) => logs.log.push(line),
      warn: (line) => logs.warn.push(line),
      error: (line) => logs.error.push(line),
    },
    createAudioListener: listenerFactory ?? (() => null),
  })
  return { manager, events, statuses, logs }
}

test('external 模式不创建 listener，summary 报 disabled 并打印状态行', () => {
  let factoryCalls = 0
  const { manager, logs } = makeManager({
    environment: { LIVE2D_VOICE_SOURCE_MODE: 'external' },
    listenerFactory: () => {
      factoryCalls += 1
      return null
    },
  })
  manager.start()
  assert.equal(factoryCalls, 1)
  const summary = manager.summary()
  assert.equal(summary.mode, 'external')
  assert.equal(summary.status, 'disabled')
  assert.match(logs.log[0], /^\[live2d\] voice listener: external\/disabled$/)
})

test('listener 回调产出 voice 事件；onStatus 记录 native 状态并通知', () => {
  const listener = {
    started: false,
    stopped: false,
    start() { this.started = true; return Promise.resolve() },
    stop() { this.stopped = true },
  }
  let options = null
  const { manager, events, statuses, logs } = makeManager({
    listenerFactory: (opts) => {
      options = opts
      return listener
    },
  })
  manager.start({ mode: 'automatic', process_pattern: null, source_id: null, source_name: null })
  assert.equal(listener.started, true)

  options.onSession(true)
  assert.deepEqual(events[0], {
    type: 'state',
    state: { phase: 'active', activity: 'listening' },
  })
  options.onLevel(0.5)
  assert.deepEqual(events[1], { type: 'audio-level', level: 0.5 })

  options.onStatus({ capturing: true, source: 'macOS process audio' })
  assert.equal(statuses.length, 1)
  const summary = manager.summary()
  assert.equal(summary.status, 'running')
  assert.equal(summary.lastLevel, 0.5)
  assert.match(logs.log.at(-1), /^\[live2d\] voice listener: automatic\/running lastLevel=0\.5$/)
})

test('世代号吸收陈旧回调：热更新后旧 listener 的回调不再生效', () => {
  const callbacks = []
  const listeners = []
  const { manager, events, statuses } = makeManager({
    listenerFactory: (opts) => {
      callbacks.push(opts)
      const listener = {
        stopped: false,
        start() { return Promise.resolve() },
        stop() { this.stopped = true },
      }
      listeners.push(listener)
      return listener
    },
  })
  manager.start({ mode: 'automatic', process_pattern: null, source_id: null, source_name: null })
  manager.applyPersisted({ mode: 'custom', process_pattern: 'afplay', source_id: null, source_name: null })

  assert.equal(listeners[0].stopped, true, '旧 listener 应被停止')
  assert.equal(callbacks.length, 2, '应重建 listener')

  const before = events.length
  callbacks[0].onSession(true) // 陈旧 listener 的迟到回调
  callbacks[0].onLevel(0.9)
  callbacks[0].onStatus({ capturing: true })
  assert.equal(events.length, before, '陈旧回调不得再产出事件')
  assert.equal(statuses.length, 0, '陈旧回调不得再触发状态通知')
  assert.equal(manager.summary().status, 'starting', 'native 状态应随 stop 清空')

  callbacks[1].onLevel(0.3)
  assert.deepEqual(events.at(-1), { type: 'audio-level', level: 0.3 })
  assert.equal(manager.config.source.mode, 'custom')
})

test('start 失败路径：记录 startup-failed 状态并打印错误', async () => {
  const listener = {
    start() { return Promise.reject(new Error('boom')) },
    stop() {},
  }
  const { manager, logs } = makeManager({ listenerFactory: () => listener })
  manager.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(logs.error[0], /voice listener 启动失败：boom/)
  const summary = manager.summary()
  assert.equal(summary.status, 'error')
  assert.equal(summary.detail, 'startup-failed')
})

test('配置 warnings 逐条打印；environmentOverridesVoice 透传', () => {
  const { manager, logs } = makeManager({
    environment: { LIVE2D_VOICE_SOURCE_MODE: 'nope' },
  })
  manager.start()
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /LIVE2D_VOICE_SOURCE_MODE/)
  assert.equal(manager.config.environmentOverridesVoice, true)
})
