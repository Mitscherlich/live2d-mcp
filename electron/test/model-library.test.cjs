'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ModelLibrary, ImportError } = require('../model-library.cjs')
const { mayukaHome, isValidModelId } = require('../mayuka-paths.cjs')

const FIXTURES = path.resolve(__dirname, '../../.temp/fixtures')
const hasFixtures = fs.existsSync(path.join(FIXTURES, 'hiyori-ok.zip'))
const fixture = (name) => path.join(FIXTURES, name)

function withHome(callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mayuka-lib-test-'))
  return Promise.resolve(callback(home, new ModelLibrary({ home }))).finally(() => fs.rmSync(home, { recursive: true, force: true }))
}

/** Build a zip with the system `zip` tool; entries are `{ name: content }`. */
function makeZip(dir, name, files) {
  const src = fs.mkdtempSync(path.join(dir, 'src-'))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true })
    fs.writeFileSync(path.join(src, rel), content)
  }
  const out = path.join(dir, name)
  execFileSync('zip', ['-qr', out, '.'], { cwd: src })
  return out
}

const MODEL3 = (extra = {}) => JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: ['t.png'], ...extra } })

function assertNoResidue(home) {
  const models = path.join(home, 'models')
  assert.deepEqual(fs.existsSync(models) ? fs.readdirSync(models) : [], [])
  const tmp = path.join(home, '.tmp')
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [])
}

test('mayukaHome prefers MAYUKA_HOME and falls back to ~/.mayuka', () => {
  assert.equal(mayukaHome({ env: { MAYUKA_HOME: '/tmp/x' }, homedir: () => '/h' }), '/tmp/x')
  assert.equal(mayukaHome({ env: {}, homedir: () => '/h' }), path.join('/h', '.mayuka'))
  assert.equal(isValidModelId('hiyori-3fa9'), true)
  assert.equal(isValidModelId('../x'), false)
  assert.equal(isValidModelId('A'), false)
})

test('imports a valid model zip: manifest, atomic install, scan', { skip: !hasFixtures }, () => withHome(async (home, lib) => {
  const steps = []
  const { id, manifest } = await lib.importModelZip(fixture('hiyori-ok.zip'), (p) => steps.push(p.step))
  assert.deepEqual(steps, [0, 1, 2, 3])
  assert.match(id, /^hiyori_pro_t11-[0-9a-f]{4}$/)
  assert.equal(manifest.entry, 'hiyori_pro_t11.model3.json')
  assert.ok(manifest.motions.includes('Idle'))
  assert.ok(manifest.parts.length > 0)
  assert.ok(fs.existsSync(path.join(home, 'models', id, 'hiyori_pro_t11.moc3')))
  assert.deepEqual(fs.readdirSync(path.join(home, '.tmp')), [])

  const { models, warnings } = lib.scan()
  assert.equal(models.length, 1)
  assert.equal(models[0].id, id)
  assert.deepEqual(warnings, [])
  assert.deepEqual(lib.readiness(id), { core: false, model: true })
}))

for (const [name, pattern] of [
  ['broken-no-model3.zip', /model3\.json/],
  ['broken-missing-texture.zip', /does not exist|moc3/],
  ['evil-zip-slip.zip', /unsafe path|valid zip/],
]) {
  test(`rejects ${name} and leaves nothing behind`, { skip: !hasFixtures }, () => withHome(async (home, lib) => {
    await assert.rejects(lib.importModelZip(fixture(name)), (error) => error instanceof ImportError && pattern.test(error.message))
    assertNoResidue(home)
  }))
}

test('rejects non-zip input, missing files and oversize archives', () => withHome(async (home, lib) => {
  const junk = path.join(home, 'junk.zip')
  fs.writeFileSync(junk, 'not a zip')
  await assert.rejects(lib.importModelZip(junk), /valid zip/)
  await assert.rejects(lib.importModelZip(path.join(home, 'missing.zip')), /Cannot read/)
  const small = new ModelLibrary({ home, limits: { zipBytes: 4 } })
  await assert.rejects(small.importModelZip(junk), /too large/)
  assertNoResidue(home)
}))

test('rejects bad moc3 header, missing reference, and duplicate model3 at the same level', () => withHome(async (home, lib) => {
  const badMoc = makeZip(home, 'bad-moc.zip', { 'a.model3.json': MODEL3(), 'a.moc3': 'XXXX1', 't.png': 'png' })
  await assert.rejects(lib.importModelZip(badMoc), /moc3/)
  const dup = makeZip(home, 'dup.zip', { 'a.model3.json': MODEL3(), 'b.model3.json': MODEL3(), 'a.moc3': 'MOC3\u0001', 't.png': 'x' })
  await assert.rejects(lib.importModelZip(dup), /several/)
  const outside = makeZip(home, 'out.zip', { 'a.model3.json': MODEL3({ Physics: '../secret.json' }), 'a.moc3': 'MOC3\u0001', 't.png': 'x' })
  await assert.rejects(lib.importModelZip(outside), /outside the model|does not exist/)
  assertNoResidue(home)
}))

test('enforces entry-count and uncompressed-size caps', () => withHome(async (home, lib) => {
  const zip = makeZip(home, 'ok.zip', { 'a.model3.json': MODEL3(), 'a.moc3': 'MOC3\u0001', 't.png': 'x' })
  await assert.rejects(new ModelLibrary({ home, limits: { entries: 2 } }).importModelZip(zip), /too many/)
  await assert.rejects(new ModelLibrary({ home, limits: { uncompressedBytes: 10 } }).importModelZip(zip), /too large/)
  assertNoResidue(home)
}))

test('imports a model nested in a wrapper directory', () => withHome(async (home, lib) => {
  const zip = makeZip(home, 'nested.zip', { 'wrap/a.model3.json': MODEL3(), 'wrap/a.moc3': 'MOC3\u0001', 'wrap/t.png': 'x', '__MACOSX/junk': 'j' })
  const { id } = await lib.importModelZip(zip)
  assert.ok(fs.existsSync(path.join(home, 'models', id, 'a.moc3')))
}))

test('removeModel refuses the active model and bad ids', () => withHome(async (home, lib) => {
  const zip = makeZip(home, 'ok.zip', { 'a.model3.json': MODEL3(), 'a.moc3': 'MOC3\u0001', 't.png': 'x' })
  const { id } = await lib.importModelZip(zip)
  assert.throws(() => lib.removeModel(id, { activeId: id }), /active/)
  assert.throws(() => lib.removeModel('../..'), /Invalid/)
  lib.removeModel(id, { activeId: null })
  assert.equal(lib.scan().models.length, 0)
}))

test('scan skips broken manifests with a warning', () => withHome(async (home, lib) => {
  fs.mkdirSync(path.join(home, 'models', 'broken'), { recursive: true })
  fs.writeFileSync(path.join(home, 'models', 'broken', 'mayuka-model.json'), '{nope')
  fs.mkdirSync(path.join(home, 'models', 'escape'), { recursive: true })
  fs.writeFileSync(path.join(home, 'models', 'escape', 'mayuka-model.json'), JSON.stringify({ id: 'escape', entry: '../../x.model3.json' }))
  const { models, warnings } = lib.scan()
  assert.equal(models.length, 0)
  assert.equal(warnings.length, 2)
}))

test('importCore accepts a bare js and an SDK zip, rejects look-alikes', () => withHome(async (home, lib) => {
  const good = path.join(home, 'core.js')
  fs.writeFileSync(good, 'var Live2DCubismCore;!function(){}()')
  assert.equal((await lib.importCore(good)).installed, true)
  assert.ok(fs.readFileSync(lib.paths.coreFile, 'utf8').includes('Live2DCubismCore'))
  assert.deepEqual(lib.readiness(null), { core: true, model: false })

  fs.rmSync(lib.paths.coreFile)
  const sdk = makeZip(home, 'sdk.zip', { 'CubismSdkForWeb/Core/live2dcubismcore.min.js': 'var Live2DCubismCore=1' })
  assert.equal((await lib.importCore(sdk)).installed, true)

  const bad = path.join(home, 'bad.js')
  fs.writeFileSync(bad, 'alert(1)')
  await assert.rejects(lib.importCore(bad), /valid Cubism Core/)
  const noCore = makeZip(home, 'nocore.zip', { 'readme.txt': 'x' })
  await assert.rejects(lib.importCore(noCore), /not found/)
}))

test('cleanupStaleTmp removes only old directories', () => withHome(async (home, lib) => {
  const old = path.join(home, '.tmp', 'old')
  const fresh = path.join(home, '.tmp', 'fresh')
  fs.mkdirSync(old, { recursive: true })
  fs.mkdirSync(fresh, { recursive: true })
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
  fs.utimesSync(old, past, past)
  assert.equal(lib.cleanupStaleTmp(), 1)
  assert.deepEqual(fs.readdirSync(path.join(home, '.tmp')), ['fresh'])
}))
