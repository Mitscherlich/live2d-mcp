/**
 * command-dispatcher.ts 单测（ADR 0001 · F5）
 *
 * 模块零运行时 import（model-config.ts 为纯常量/纯函数），Node type-stripping
 * 直载；window 全局在测试进程不存在，构造前补空壳承接 __live2dCommandDebug。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandDispatcher } from '../src/command-dispatcher.ts'

interface FakeResult {
  ok: boolean
  data?: unknown
  error?: string
}
type Handler = (command: { type: string; params: Record<string, unknown> }) => FakeResult

;(globalThis as Record<string, unknown>).window ??= {}

function makeHarness({ loaded = true } = {}) {
  const appCalls: Array<unknown[]> = []
  const app = {
    isLoaded: () => loaded,
    getModelInfo: () => ({ expressions: ['normal'], motionGroups: { Idle: 3 }, parameters: [] }),
    setExpression: (...args: unknown[]) => {
      appCalls.push(['setExpression', ...args])
      return args[0] !== 'nope'
    },
    playMotion: (...args: unknown[]) => {
      appCalls.push(['playMotion', ...args])
      return args[0] !== 'Nope'
    },
    lookAt: (...args: unknown[]) => {
      appCalls.push(['lookAt', ...args])
      return true
    },
    setParameter: (...args: unknown[]) => {
      appCalls.push(['setParameter', ...args])
      return args[0] !== ''
    },
    reset: () => {
      appCalls.push(['reset'])
      return true
    },
  }
  const statusNotes: Array<unknown[]> = []
  const statusBar = {
    noteExpression: (...args: unknown[]) => statusNotes.push(['noteExpression', ...args]),
    noteMotion: (...args: unknown[]) => statusNotes.push(['noteMotion', ...args]),
    resetExpressionMotion: () => statusNotes.push(['resetExpressionMotion']),
  }
  let handler: Handler | null = null
  const api = {
    onCommand: (h: Handler) => {
      handler = h
      return () => {}
    },
  }
  new CommandDispatcher(app as never, api as never, statusBar as never)
  const send = (type: string, params: Record<string, unknown> = {}): FakeResult =>
    handler!({ type, params })
  const snapshot = () =>
    (globalThis.window as Record<string, { snapshot: () => Record<string, unknown> }>)
      .__live2dCommandDebug.snapshot()
  return { appCalls, statusNotes, send, snapshot }
}

test('模型缺失时全部命令降级为 MODEL_MISSING 文案，不触碰 app', () => {
  const { appCalls, send, snapshot } = makeHarness({ loaded: false })
  const info = send('getModelInfo')
  assert.equal(info.ok, false)
  assert.match(info.error!, /模型未加载/)
  const expr = send('setExpression', { expression: 'normal' })
  assert.equal(expr.ok, false)
  assert.match(expr.error!, /模型未加载/)
  assert.deepEqual(appCalls, [], '降级路径不得调用 app 方法')
  assert.deepEqual(snapshot().counts, { getModelInfo: 1, setExpression: 1 })
  assert.equal(snapshot().modelLoaded, false)
  assert.match(snapshot().lastError as string, /模型未加载/)
})

test('getModelInfo 返回模型信息；channelAttached 为 true', () => {
  const { send, snapshot } = makeHarness()
  const result = send('getModelInfo')
  assert.equal(result.ok, true)
  assert.deepEqual((result.data as { expressions: string[] }).expressions, ['normal'])
  assert.equal(snapshot().channelAttached, true)
})

test('setExpression 成功写状态栏；失败回错并带 get_model_info 提示', () => {
  const { statusNotes, send, snapshot } = makeHarness()
  const ok = send('setExpression', { expression: 'smile' })
  assert.deepEqual(ok, { ok: true, data: { expression: 'smile' } })
  assert.deepEqual(statusNotes, [['noteExpression', 'smile']])

  const bad = send('setExpression', { expression: 'nope' })
  assert.equal(bad.ok, false)
  assert.match(bad.error!, /表情 "nope" 不存在或不可用（用 get_model_info 查询可用表情）/)
  assert.equal(snapshot().lastError, '表情 "nope" 不存在或不可用')
})

test('playMotion 参数窄化（index/priority 取整）并以 motionTag 写状态栏', () => {
  const { appCalls, statusNotes, send } = makeHarness()
  const ok = send('playMotion', { group: 'Idle', index: 1.9, priority: 2.5 })
  assert.deepEqual(ok, { ok: true, data: { group: 'Idle', index: 1, priority: 2 } })
  assert.deepEqual(appCalls[0], ['playMotion', 'Idle', 1, 2])
  assert.deepEqual(statusNotes[0], ['noteMotion', 'Idle[1]'])

  send('playMotion', { group: 'Tap' })
  assert.deepEqual(statusNotes[1], ['noteMotion', 'Tap[rand]'])

  const bad = send('playMotion', { group: 'Nope' })
  assert.equal(bad.ok, false)
  assert.match(bad.error!, /动作分组 "Nope" 不存在或不可用/)
})

test('lookAt / setParameter / reset 映射与返回值形状', () => {
  const { appCalls, statusNotes, send } = makeHarness()
  assert.deepEqual(send('lookAt', { x: 0.5, y: -0.5 }), { ok: true, data: { x: 0.5, y: -0.5 } })
  assert.deepEqual(appCalls[0], ['lookAt', 0.5, -0.5])

  const badParam = send('setParameter', { param_id: 'P', value: 'NaN-ish' })
  assert.equal(badParam.ok, false)
  assert.match(badParam.error!, /参数 "P" 写入失败/)

  assert.deepEqual(send('setParameter', { param_id: 'P', value: 0.7 }), {
    ok: true,
    data: { param_id: 'P', value: 0.7 },
  })
  assert.deepEqual(send('reset'), { ok: true })
  assert.deepEqual(statusNotes, [['resetExpressionMotion']])
})

test('lastCommand 追踪最近命令；快照 counts 逐命令累计', () => {
  const { send, snapshot } = makeHarness()
  send('lookAt', { x: 0, y: 0 })
  send('lookAt', { x: 1, y: 1 })
  send('reset')
  assert.deepEqual(snapshot().counts, { lookAt: 2, reset: 1 })
  assert.equal(snapshot().lastCommand, 'reset')
})
