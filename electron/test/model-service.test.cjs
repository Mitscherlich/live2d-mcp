'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ModelLibrary } = require('../model-library.cjs')
const { ModelService } = require('../model-service.cjs')
const { SettingsStore } = require('../settings-store.cjs')
const { MODEL_CHANGED_CHANNEL } = require('../model-channels.cjs')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')])

function setup({ legacy = null, reply = (service, msg) => service.handleLoadResult({ requestId: msg.requestId, ok: true }) } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mayuka-svc-test-'))
  const library = new ModelLibrary({ home })
  const store = new SettingsStore({ filePath: path.join(home, 'settings', 'settings.json') })
  const sent = []
  let changed = 0
  let service
  const win = {
    isDestroyed: () => false,
    webContents: {
      isLoading: () => false,
      send(channel, msg) {
        sent.push({ channel, msg })
        setImmediate(() => reply(service, msg))
      },
    },
  }
  service = new ModelService({ library, settingsStore: store, getAvatarWindow: () => win, onChanged: () => { changed += 1 }, legacy, swapTimeoutMs: 50 })
  const addModel = (id, entry = `${id}.model3.json`) => {
    const dir = path.join(home, 'models', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mayuka-model.json'), JSON.stringify({ version: 1, id, name: id, entry, motions: ['Idle'], expressions: [], parts: [], overrides: { motionNames: { 'Idle:0': 'x' } } }))
  }
  const addCore = () => {
    fs.mkdirSync(path.join(home, 'core'), { recursive: true })
    fs.writeFileSync(path.join(home, 'core', 'live2dcubismcore.min.js'), 'var Live2DCubismCore')
  }
  return { home, library, store, service, sent, win, addModel, addCore, changes: () => changed, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('getActiveModel reports what is missing: core first, then model', () => {
  const t = setup()
  try {
    assert.deepEqual(t.service.getActiveModel(), { missing: 'core' })
    t.addCore()
    assert.deepEqual(t.service.getActiveModel(), { missing: 'model' })
    assert.deepEqual(t.service.readiness(), { core: true, model: false })
    t.addModel('a-1111')
    // Library has a model but none is active yet.
    assert.deepEqual(t.service.getActiveModel(), { missing: 'model' })
  } finally { t.cleanup() }
})

test('activate persists, notifies the avatar, and exposes URLs + overrides', async () => {
  const t = setup()
  try {
    t.addCore()
    t.addModel('a-1111', '大肥鱼.model3.json')
    assert.deepEqual(await t.service.activate('a-1111'), { ok: true })
    assert.equal(t.store.current.model.activeId, 'a-1111')
    assert.equal(t.sent.length, 1)
    assert.equal(t.sent[0].channel, MODEL_CHANGED_CHANNEL)
    const active = t.service.getActiveModel()
    assert.equal(active.modelUrl, `/user-models/a-1111/${encodeURIComponent('大肥鱼.model3.json')}`)
    assert.equal(active.coreUrl, '/user-core/live2dcubismcore.min.js')
    assert.deepEqual(active.overrides.motionNames, { 'Idle:0': 'x' })
    assert.deepEqual(await t.service.activate('a-1111'), { ok: true, unchanged: true })
    assert.equal(t.sent.length, 1)
  } finally { t.cleanup() }
})

test('a failed swap rolls activeId back to the previous model', async () => {
  const t = setup({ reply: (service, msg) => service.handleLoadResult({ requestId: msg.requestId, ok: msg.active.id !== 'bad-2222', error: 'boom' }) })
  try {
    t.addCore(); t.addModel('good-1111'); t.addModel('bad-2222')
    await t.service.activate('good-1111')
    const result = await t.service.activate('bad-2222')
    assert.deepEqual(result, { ok: false, error: 'boom' })
    assert.equal(t.store.current.model.activeId, 'good-1111')
  } finally { t.cleanup() }
})

test('a silent avatar times out and rolls back', async () => {
  const t = setup({ reply: () => {} })
  try {
    t.addCore(); t.addModel('a-1111')
    const result = await t.service.activate('a-1111')
    assert.equal(result.ok, false)
    assert.match(result.error, /Timed out/)
    assert.equal(t.store.current.model.activeId, null)
  } finally { t.cleanup() }
})

test('activate rejects unknown ids, bad ids, and missing core', async () => {
  const t = setup()
  try {
    t.addModel('a-1111')
    assert.match((await t.service.activate('a-1111')).error, /Core/)
    t.addCore()
    assert.match((await t.service.activate('nope-0000')).error, /not found/)
    assert.match((await t.service.activate('../x')).error, /Invalid/)
  } finally { t.cleanup() }
})

test('rapid activations are serialized and the last one wins', async () => {
  const t = setup()
  try {
    t.addCore(); t.addModel('a-1111'); t.addModel('b-2222'); t.addModel('c-3333')
    const results = await Promise.all([t.service.activate('a-1111'), t.service.activate('b-2222'), t.service.activate('c-3333')])
    assert.ok(results.every((r) => r.ok))
    assert.equal(t.store.current.model.activeId, 'c-3333')
    assert.deepEqual(t.sent.map((s) => s.msg.active.id), ['a-1111', 'b-2222', 'c-3333'])
  } finally { t.cleanup() }
})

test('reconcile drops a dangling activeId; remove refuses the active model', async () => {
  const t = setup()
  try {
    t.addCore(); t.addModel('a-1111'); t.addModel('b-2222')
    t.store.saveActiveModel('ghost-0000')
    t.service.reconcile()
    assert.equal(t.store.current.model.activeId, null)
    await t.service.activate('a-1111')
    assert.match(t.service.removeModel('a-1111').error, /active/)
    assert.deepEqual(t.service.removeModel('b-2222'), { ok: true })
    assert.equal(t.service.describe().models.length, 1)
  } finally { t.cleanup() }
})

test('with no live renderer activate still succeeds (avatar reads state on boot)', async () => {
  const t = setup()
  try {
    t.addCore(); t.addModel('a-1111')
    t.win.webContents.isLoading = () => true
    assert.deepEqual(await t.service.activate('a-1111'), { ok: true })
    assert.equal(t.sent.length, 0)
  } finally { t.cleanup() }
})

test('dev legacy fallback serves renderer/public only when the library is empty', () => {
  const t = setup({ legacy: { coreUrl: '/live2dcubismcore.min.js', modelUrl: '/model/DeepSeek/x.model3.json' } })
  try {
    const active = t.service.getActiveModel()
    assert.equal(active.coreUrl, '/live2dcubismcore.min.js')
    assert.equal(active.modelUrl, '/model/DeepSeek/x.model3.json')
    assert.ok(active.overrides.physicsInputDrives.length > 0)
    t.addModel('a-1111')
    assert.deepEqual(t.service.getActiveModel(), { missing: 'model' })
  } finally { t.cleanup() }
})

test('saveThumbnail accepts PNGs only and describe exposes them as data URLs', () => {
  const t = setup()
  try {
    t.addModel('a-1111')
    assert.equal(t.service.saveThumbnail('a-1111', Buffer.from('nope-not-png')).ok, false)
    assert.equal(t.service.saveThumbnail('../x', PNG).ok, false)
    assert.equal(t.service.saveThumbnail('missing-0000', PNG).ok, false)
    assert.equal(t.service.saveThumbnail('a-1111', PNG).ok, true)
    assert.match(t.service.describe().models[0].thumb, /^data:image\/png;base64,/)
  } finally { t.cleanup() }
})
