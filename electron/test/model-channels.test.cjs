'use strict'

/**
 * Model channels exist twice: here (authoritative, required by main) and inlined in the two
 * sandboxed preloads. Read the preload sources so drift becomes a red test instead of a silent
 * dead channel.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const channels = require('../model-channels.cjs')
const { loadSourceProbe } = require('./helpers/source-probe.cjs')

test('model channel constants are pinned', () => {
  assert.deepEqual(channels, {
    CORE_IMPORT_CHANNEL: 'live2d:core:import',
    MODEL_CHANGED_CHANNEL: 'live2d:model:changed',
    MODEL_GET_ACTIVE_CHANNEL: 'live2d:model:get-active',
    MODEL_IMPORT_CHANNEL: 'live2d:model:import',
    MODEL_LOAD_RESULT_CHANNEL: 'live2d:model:load-result',
    MODEL_PROGRESS_CHANNEL: 'live2d:model:progress',
    MODEL_SAVE_THUMB_CHANNEL: 'live2d:model:save-thumb',
  })
})

test('preload.cjs inlines the avatar-side channels', () => {
  const preload = loadSourceProbe('preload.cjs')
  for (const name of ['MODEL_GET_ACTIVE_CHANNEL', 'MODEL_CHANGED_CHANNEL', 'MODEL_LOAD_RESULT_CHANNEL']) {
    assert.equal(preload.stringConst(name), channels[name], name)
  }
})

test('settings-preload.cjs inlines the settings-side channels', () => {
  const preload = loadSourceProbe('settings-preload.cjs')
  for (const name of ['MODEL_IMPORT_CHANNEL', 'MODEL_PROGRESS_CHANNEL', 'CORE_IMPORT_CHANNEL', 'MODEL_SAVE_THUMB_CHANNEL']) {
    assert.equal(preload.stringConst(name), channels[name], name)
  }
})

test('main does not re-inline model channel literals', () => {
  const main = loadSourceProbe('companion-app.cjs')
  for (const name of Object.keys(channels)) assert.throws(() => main.stringConst(name))
})
