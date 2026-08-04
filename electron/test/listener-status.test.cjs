'use strict'

/**
 * listener-status.cjs 单测（ADR 0001 · F6 · goal 验证 3/4）
 * buildListenerSummary：external→disabled、非 darwin→unavailable(platform)、
 * 瞬时 starting、running（含 lastLevel）、idle 细分、权限/缺失/错误分类；
 * 枚举封闭、摘要不含用户内容字段。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  LISTENER_STATUSES,
  PERMISSION_REMEDY,
  buildListenerSummary,
} = require('../listener-status.cjs')

test('状态枚举封闭且含 goal 要求的明确状态', () => {
  assert.deepEqual([...LISTENER_STATUSES].sort(), [
    'disabled',
    'error',
    'idle',
    'permission-denied',
    'running',
    'starting',
    'unavailable',
  ])
})

test('external 模式 → disabled（任何平台，不查 native 负载）', () => {
  const summary = buildListenerSummary({ mode: 'external', platform: 'darwin' })
  assert.equal(summary.status, 'disabled')
  assert.equal(summary.mode, 'external')
  assert.match(summary.note, /仅消费 \/events/)
  const linux = buildListenerSummary({ mode: 'external', platform: 'linux' })
  assert.equal(linux.status, 'disabled')
})

test('非 darwin 且非 external → unavailable/platform-not-supported（linux/win 预留）', () => {
  for (const platform of ['linux', 'win32']) {
    const summary = buildListenerSummary({ mode: 'automatic', platform })
    assert.deepEqual(summary, { mode: 'automatic', status: 'unavailable', detail: 'platform-not-supported' })
  }
})

test('native 负载为 null → starting 瞬时态（listener 尚未上报）', () => {
  const summary = buildListenerSummary({ mode: 'automatic', platform: 'darwin', native: null })
  assert.deepEqual(summary, { mode: 'automatic', status: 'starting' })
})

test('capturing → running（source + lastLevel 取整附带）', () => {
  const summary = buildListenerSummary({
    mode: 'automatic',
    platform: 'darwin',
    native: { available: true, capturing: true, monitoring: true, source: 'macOS process audio', matched: 1, detail: null, error: null, permissionHint: true },
    lastLevel: 0.423456,
  })
  assert.deepEqual(summary, {
    mode: 'automatic',
    status: 'running',
    source: 'macOS process audio',
    lastLevel: 0.4235,
  })
  // lastLevel 缺失/非法 → 不附带字段
  const noLevel = buildListenerSummary({
    mode: 'automatic',
    platform: 'darwin',
    native: { capturing: true, source: null },
    lastLevel: Number.NaN,
  })
  assert.equal(noLevel.status, 'running')
  assert.equal('lastLevel' in noLevel, false)
})

test('idle 细分：无匹配进程 / 等待目标出声（matched 计数附带）', () => {
  const noMatch = buildListenerSummary({
    mode: 'automatic',
    platform: 'darwin',
    native: { available: true, capturing: false, monitoring: true, source: null, matched: 0, detail: 'no-matching-process', error: null, permissionHint: null },
  })
  assert.deepEqual(noMatch, { mode: 'automatic', status: 'idle', detail: 'no-matching-process' })

  const waiting = buildListenerSummary({
    mode: 'custom',
    platform: 'darwin',
    native: { available: true, capturing: false, monitoring: true, source: null, matched: 2, detail: 'waiting-for-audio', error: null, permissionHint: false },
  })
  assert.deepEqual(waiting, { mode: 'custom', status: 'idle', detail: 'waiting-for-audio', matched: 2 })
})

test('tap-create-failed + permissionHint:false → permission-denied（附 remedy）', () => {
  const summary = buildListenerSummary({
    mode: 'automatic',
    platform: 'darwin',
    native: { available: true, capturing: false, monitoring: true, source: null, matched: 1, detail: 'tap-create-failed', error: 'Unable to create a Core Audio process tap. (OSStatus -1)', permissionHint: false },
  })
  assert.equal(summary.status, 'permission-denied')
  assert.equal(summary.detail, 'tap-create-failed')
  assert.equal(summary.remedy, PERMISSION_REMEDY)
  assert.match(summary.remedy, /屏幕与系统音频录制/)
  assert.match(summary.remedy, /LIVE2D_VOICE_SOURCE_MODE=external/)
})

test('tap-create-failed + permissionHint:true → error（非权限问题，不误报权限）', () => {
  const summary = buildListenerSummary({
    mode: 'automatic',
    platform: 'darwin',
    native: { available: true, capturing: false, monitoring: true, source: null, matched: 1, detail: 'tap-create-failed', error: 'boom', permissionHint: true },
  })
  assert.equal(summary.status, 'error')
  assert.equal(summary.detail, 'tap-create-failed')
  assert.equal(summary.error, 'boom')
})

test('helper-missing / spawn-failed / unsupported-os → unavailable', () => {
  for (const detail of ['helper-missing', 'spawn-failed', 'unsupported-os', 'platform-not-supported']) {
    const summary = buildListenerSummary({
      mode: 'automatic',
      platform: 'darwin',
      native: { available: false, capturing: false, monitoring: false, source: null, matched: 0, detail, error: 'x'.repeat(500), permissionHint: null },
    })
    assert.equal(summary.status, 'unavailable', detail)
    assert.equal(summary.detail, detail)
    assert.ok(summary.error.length <= 161, '错误文本截断')
  }
})

test('helper 异常退出/未分类错误 → error', () => {
  const exited = buildListenerSummary({
    mode: 'automatic',
    platform: 'darwin',
    native: { available: true, capturing: false, monitoring: true, source: null, matched: 1, detail: 'helper-exited', error: 'native helper 意外退出（code 3）', permissionHint: null },
  })
  assert.equal(exited.status, 'error')
  assert.equal(exited.detail, 'helper-exited')
})

test('摘要不含用户内容字段（命令行/文本/音频）', () => {
  const summary = buildListenerSummary({
    mode: 'automatic',
    platform: 'darwin',
    native: { available: true, capturing: true, monitoring: true, source: 'macOS process audio', matched: 1, detail: null, error: null, permissionHint: true },
    lastLevel: 0.5,
  })
  for (const key of ['command', 'commandLine', 'text', 'transcript', 'audio', 'samples']) {
    assert.equal(key in summary, false, key)
  }
})
