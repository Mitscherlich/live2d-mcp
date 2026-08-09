'use strict'

/**
 * protocol-utils.cjs 单测（共享校验原语）
 *
 * 覆盖：isPlainObject / isFiniteNumber / clamp01（严格）/ clamp01Lenient（宽松）
 * 的语义差异与 isWindowSender 的归属判定。两版 clamp 语义不同，勿合并（见模块头注释）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  clamp01,
  clamp01Lenient,
  isFiniteNumber,
  isPlainObject,
  isWindowSender,
} = require('../protocol-utils.cjs')

test('isPlainObject：排除 null / 数组 / 原始值', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject('x'), false)
  assert.equal(isPlainObject(1), false)
})

test('isFiniteNumber：NaN / ±Infinity / 非数字一律 false', () => {
  assert.equal(isFiniteNumber(0.5), true)
  assert.equal(isFiniteNumber(NaN), false)
  assert.equal(isFiniteNumber(Infinity), false)
  assert.equal(isFiniteNumber('0.5'), false)
  assert.equal(isFiniteNumber(undefined), false)
})

test('clamp01（严格）：非有限数字返回 null（调用方按非法丢弃）', () => {
  assert.equal(clamp01(0.5), 0.5)
  assert.equal(clamp01(-1), 0)
  assert.equal(clamp01(2), 1)
  assert.equal(clamp01(NaN), null)
  assert.equal(clamp01('0.5'), null)
  assert.equal(clamp01(undefined), null)
})

test('clamp01Lenient（宽松）：调用方已确认有限数字，仅收敛 clamp 表达式', () => {
  assert.equal(clamp01Lenient(0.5), 0.5)
  assert.equal(clamp01Lenient(-1), 0)
  assert.equal(clamp01Lenient(2), 1)
})

test('isWindowSender：sender 归属与窗口销毁语义', () => {
  const webContents = {}
  const win = { isDestroyed: () => false, webContents }
  assert.equal(isWindowSender({ sender: webContents }, win), true)
  assert.equal(isWindowSender({ sender: {} }, win), false)
  assert.equal(isWindowSender({ sender: webContents }, { isDestroyed: () => true, webContents }), false)
  assert.equal(isWindowSender({ sender: webContents }, null), false)
  assert.equal(isWindowSender({}, win), false)
})
