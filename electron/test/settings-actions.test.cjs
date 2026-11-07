'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_HEIGHT,
  SETTINGS_ACTION_TYPES,
  parseCopyKind,
  parseSettingsAction,
} = require('../settings-actions.cjs')

test('无参 action 原样通过，并丢弃多余字段', () => {
  for (const type of ['avatar-show', 'avatar-hide', 'avatar-reset', 'close-popover', 'quit']) {
    assert.deepEqual(parseSettingsAction({ type, url: 'https://evil.example' }), { type })
  }
})

test('set-scale 只接受有限数', () => {
  assert.deepEqual(parseSettingsAction({ type: 'set-scale', scale: 1.25 }), { type: 'set-scale', scale: 1.25 })
  assert.throws(() => parseSettingsAction({ type: 'set-scale', scale: '1.2' }), TypeError)
  assert.throws(() => parseSettingsAction({ type: 'set-scale', scale: Number.NaN }), TypeError)
})

test('open-full 的 section 走白名单，缺省为 null', () => {
  assert.deepEqual(parseSettingsAction({ type: 'open-full' }), { type: 'open-full', section: null })
  assert.deepEqual(parseSettingsAction({ type: 'open-full', section: 'voice' }), { type: 'open-full', section: 'voice' })
  assert.throws(() => parseSettingsAction({ type: 'open-full', section: '../etc' }), TypeError)
})

test('fit-popover 高度收敛到弹窗范围并取整', () => {
  assert.equal(parseSettingsAction({ type: 'fit-popover', height: 10 }).height, POPOVER_MIN_HEIGHT)
  assert.equal(parseSettingsAction({ type: 'fit-popover', height: 9999 }).height, POPOVER_MAX_HEIGHT)
  assert.equal(parseSettingsAction({ type: 'fit-popover', height: 401.4 }).height, 401)
  assert.throws(() => parseSettingsAction({ type: 'fit-popover' }), TypeError)
})

test('set-login-item 需要布尔值', () => {
  assert.deepEqual(parseSettingsAction({ type: 'set-login-item', enabled: false }), {
    type: 'set-login-item',
    enabled: false,
  })
  assert.throws(() => parseSettingsAction({ type: 'set-login-item', enabled: 'yes' }), TypeError)
})

test('未知 type 与非对象负载被拒绝', () => {
  assert.throws(() => parseSettingsAction({ type: 'open-url', url: 'https://x' }), /未知设置 action/)
  assert.throws(() => parseSettingsAction(null), TypeError)
  assert.throws(() => parseSettingsAction([]), TypeError)
  assert.throws(() => parseSettingsAction({}), TypeError)
})

test('白名单与 docs/specs/settings-ui.md §4.2 一致', () => {
  assert.deepEqual([...SETTINGS_ACTION_TYPES].sort(), [
    'avatar-hide',
    'avatar-reset',
    'avatar-show',
    'close-popover',
    'fit-popover',
    'model-activate',
    'model-preview',
    'model-remove',
    'open-full',
    'open-permission-settings',
    'open-wizard',
    'quit',
    'reveal-core',
    'reveal-models-dir',
    'reveal-settings-file',
    'set-login-item',
    'set-scale',
  ])
})

test('复制类型缺省 codex，非法值抛错', () => {
  assert.equal(parseCopyKind(undefined), 'codex')
  assert.equal(parseCopyKind('claude'), 'claude')
  assert.equal(parseCopyKind('url'), 'url')
  assert.throws(() => parseCopyKind('rm -rf'), TypeError)
})

test('model actions require a valid slug id; model is a valid section', () => {
  assert.deepEqual(parseSettingsAction({ type: 'model-activate', id: 'hiyori-3fa9', extra: 1 }), { type: 'model-activate', id: 'hiyori-3fa9' })
  assert.deepEqual(parseSettingsAction({ type: 'model-remove', id: 'a_b-1' }), { type: 'model-remove', id: 'a_b-1' })
  assert.deepEqual(parseSettingsAction({ type: 'model-preview', id: 'a_b-1' }), { type: 'model-preview', id: 'a_b-1' })
  assert.throws(() => parseSettingsAction({ type: 'model-preview', id: '../x' }), TypeError)
  for (const id of [undefined, '', '../x', 'A', 'a b', 5, 'x'.repeat(81)]) {
    assert.throws(() => parseSettingsAction({ type: 'model-activate', id }), TypeError)
  }
  assert.deepEqual(parseSettingsAction({ type: 'open-full', section: 'model' }), { type: 'open-full', section: 'model' })
  assert.deepEqual(parseSettingsAction({ type: 'open-wizard' }), { type: 'open-wizard' })
})
