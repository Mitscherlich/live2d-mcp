'use strict'

/**
 * electron/settings-channels.cjs 单测（ADR 0001 · F7）
 *
 * 设置窗通道名在两处存在：main.cjs 经 require 复用本模块（无漂移空间），
 * settings-preload.cjs 因 sandbox 限制只能内联字面量。本测试读 preload 源文本
 * 比对，把内联副本的漂移变成红灯——否则设置窗只会静默失效（invoke 无 handler）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  SETTINGS_GET_CHANNEL,
  SETTINGS_SAVE_CHANNEL,
  SETTINGS_COPY_CHANNEL,
  SETTINGS_CHANGED_CHANNEL,
} = require('../settings-channels.cjs')
const { loadSourceProbe } = require('./helpers/source-probe.cjs')

test('channel 常量固定为 F7 线协议值', () => {
  assert.equal(SETTINGS_GET_CHANNEL, 'live2d:settings:get')
  assert.equal(SETTINGS_SAVE_CHANNEL, 'live2d:settings:save')
  assert.equal(SETTINGS_COPY_CHANNEL, 'live2d:settings:copy-command')
  assert.equal(SETTINGS_CHANGED_CHANNEL, 'live2d:settings:changed')
})

test('settings-preload.cjs 内联 channel 与本模块一致（防漂移：真读 preload 源文本）', () => {
  const preload = loadSourceProbe('settings-preload.cjs')
  assert.equal(preload.stringConst('SETTINGS_GET_CHANNEL'), SETTINGS_GET_CHANNEL)
  assert.equal(preload.stringConst('SETTINGS_SAVE_CHANNEL'), SETTINGS_SAVE_CHANNEL)
  assert.equal(preload.stringConst('SETTINGS_COPY_CHANNEL'), SETTINGS_COPY_CHANNEL)
  assert.equal(preload.stringConst('SETTINGS_CHANGED_CHANNEL'), SETTINGS_CHANGED_CHANNEL)
})

test('main.cjs 复用本模块而非内联副本（避免第三份漂移源）', () => {
  const main = loadSourceProbe('main.cjs')
  // main.cjs 有模块级副作用不能被 require，改用源文本确认 require 关系存在
  // 且没有重新内联 —— 内联一旦回潮，stringConst 会提取成功从而使断言失败。
  assert.throws(
    () => main.stringConst('SETTINGS_GET_CHANNEL'),
    /未能从 main\.cjs 提取/,
    'main.cjs 不应再内联 settings channel 字面量，应 require ./settings-channels.cjs',
  )
})
