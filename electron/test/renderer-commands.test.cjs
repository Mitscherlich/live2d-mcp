'use strict'

/**
 * electron/renderer-commands.cjs 单测（ADR 0001 · F5）
 *
 * main ↔ renderer 命令通道的纯函数面：channel 常量、type 白名单、
 * 命令帧形状校验（preload 浅校验同构）、结果帧规范化（main 侧防御）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  COMMAND_CHANNEL,
  COMMAND_RESULT_CHANNEL,
  COMMAND_READY_CHANNEL,
  COMMAND_TIMEOUT_MS,
  COMMAND_TYPES,
  isCommandType,
  isCommandFrameShape,
  normalizeCommandResult,
  normalizeCommandResultFrame,
} = require('../renderer-commands.cjs')

test('channel 常量与 preload 内联值一致（防漂移）', () => {
  assert.equal(COMMAND_CHANNEL, 'live2d:command')
  assert.equal(COMMAND_RESULT_CHANNEL, 'live2d:command-result')
  assert.equal(COMMAND_READY_CHANNEL, 'live2d:command-ready')
  assert.ok(COMMAND_TIMEOUT_MS > 0)
})

test('type 白名单：恰好为 SPEC §6.4 视觉命令面', () => {
  assert.deepEqual(
    [...COMMAND_TYPES].sort(),
    ['getModelInfo', 'lookAt', 'playMotion', 'reset', 'setExpression', 'setParameter'].sort(),
  )
  assert.equal(isCommandType('setExpression'), true)
  assert.equal(isCommandType('speak'), false)
  assert.equal(isCommandType('lipSync'), false)
  assert.equal(isCommandType('eval'), false)
  assert.equal(isCommandType(42), false)
})

test('isCommandFrameShape：requestId + type 白名单 + params 对象缺一不可', () => {
  assert.equal(
    isCommandFrameShape({ requestId: 'r1', type: 'setExpression', params: { expression: 'happy' } }),
    true,
  )
  assert.equal(isCommandFrameShape({ requestId: 'r1', type: 'reset', params: {} }), true)
  // 缺字段 / 非法形状一律拒绝
  assert.equal(isCommandFrameShape(null), false)
  assert.equal(isCommandFrameShape([]), false)
  assert.equal(isCommandFrameShape({ type: 'reset', params: {} }), false)
  assert.equal(isCommandFrameShape({ requestId: '', type: 'reset', params: {} }), false)
  assert.equal(isCommandFrameShape({ requestId: 'x'.repeat(65), type: 'reset', params: {} }), false)
  assert.equal(isCommandFrameShape({ requestId: 'r1', type: 'speak', params: {} }), false)
  assert.equal(isCommandFrameShape({ requestId: 'r1', type: 'reset', params: [] }), false)
  assert.equal(isCommandFrameShape({ requestId: 'r1', type: 'reset', params: null }), false)
})

test('normalizeCommandResultFrame：合法结果帧通过，error 截断，非法帧拒绝', () => {
  assert.deepEqual(
    normalizeCommandResultFrame({ requestId: 'r1', result: { ok: true, data: { a: 1 } } }),
    { requestId: 'r1', result: { ok: true, data: { a: 1 } } },
  )
  assert.deepEqual(
    normalizeCommandResultFrame({ requestId: 'r1', result: { ok: false, error: 'boom' } }),
    { requestId: 'r1', result: { ok: false, error: 'boom' } },
  )
  // error 超长截断 500
  const long = normalizeCommandResultFrame({
    requestId: 'r1',
    result: { ok: false, error: 'e'.repeat(1000) },
  })
  assert.equal(long.result.error.length, 500)
  // 非法形状 → null
  assert.equal(normalizeCommandResultFrame(null), null)
  assert.equal(normalizeCommandResultFrame({ result: { ok: true } }), null)
  assert.equal(normalizeCommandResultFrame({ requestId: 'r1' }), null)
  assert.equal(normalizeCommandResultFrame({ requestId: 'r1', result: 'ok' }), null)
  assert.equal(normalizeCommandResultFrame({ requestId: 'r1', result: { ok: 'yes' } }), null)
  assert.equal(
    normalizeCommandResultFrame({ requestId: 'r1', result: { ok: false, error: 42 } }),
    null,
  )
})

test('normalizeCommandResult：ok 必须为布尔；data 原样透传（renderer 内部模型信息）', () => {
  assert.deepEqual(normalizeCommandResult({ ok: true }), { ok: true })
  assert.deepEqual(normalizeCommandResult({ ok: true, data: null }), { ok: true, data: null })
  assert.equal(normalizeCommandResult({}), null)
  assert.equal(normalizeCommandResult({ ok: 1 }), null)
  assert.equal(normalizeCommandResult(null), null)
})
