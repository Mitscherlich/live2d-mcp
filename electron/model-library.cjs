'use strict'

/**
 * Model library: scans, imports and removes user-supplied Live2D models and
 * the Cubism Core under the Mayuka home directory (docs/drafts/model-management.md §3-4).
 *
 * Imported files are untrusted. The pipeline extracts into `<home>/.tmp/`, validates there,
 * and only then renames into `models/<id>`, so nothing partial is ever visible. Nothing
 * imported is executed. All side effects are injectable (fs, zip opener, clock).
 */

const nodeFs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const {
  CORE_FILE_NAME,
  MANIFEST_FILE_NAME,
  THUMB_FILE_NAME,
  isValidModelId,
  resolvePaths,
} = require('./mayuka-paths.cjs')

const MANIFEST_VERSION = 1
const DEFAULT_LIMITS = Object.freeze({
  zipBytes: 512 * 1024 * 1024,
  entries: 5000,
  uncompressedBytes: 1024 * 1024 * 1024,
  coreBytes: 8 * 1024 * 1024,
})
const STALE_TMP_MS = 60 * 60 * 1000
const IMPORT_STEPS = Object.freeze([
  'validate zip',
  'extract',
  'check model3.json and referenced files',
  'install',
])
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

/** Error whose message is safe to show in the UI. */
class ImportError extends Error {
  constructor(message, { step = -1 } = {}) {
    super(message)
    this.name = 'ImportError'
    this.step = step
  }
}

function defaultOpenZip(zipPath) {
  const yauzl = require('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: false }, (error, zip) => (error ? reject(error) : resolve(zip)))
  })
}

/**
 * Zip names without the UTF-8 flag are not necessarily CP437: many tools write raw UTF-8 or GBK
 * without setting it, and model3.json references the real name. Try strict UTF-8, then GBK, then latin1.
 */
function decodeZipName(raw, utf8Flag) {
  if (typeof raw === 'string') return raw
  if (utf8Flag) return raw.toString('utf8')
  for (const label of ['utf-8', 'gbk']) {
    try { return new TextDecoder(label, { fatal: true }).decode(raw) } catch { /* try next */ }
  }
  return raw.toString('latin1')
}

/** Iterate zip entries. `visit(entry, openStream)` may return false to stop early. */
function walkZip(zip, visit) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      try { zip.close() } catch { /* already closed */ }
      error ? reject(error) : resolve()
    }
    const openStream = (entry) => new Promise((res, rej) => {
      zip.openReadStream(entry, (error, stream) => (error ? rej(error) : res(stream)))
    })
    zip.on('error', finish)
    zip.on('end', () => finish())
    zip.on('entry', (entry) => {
      entry.fileName = decodeZipName(entry.fileName, ((entry.generalPurposeBitFlag ?? 0) & 0x800) !== 0)
      Promise.resolve(visit(entry, openStream)).then((keepGoing) => {
        if (keepGoing === false) finish()
        else zip.readEntry()
      }, finish)
    })
    zip.readEntry()
  })
}

function isSymlink(entry) {
  return ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK
}

/** Returns the safe relative path (POSIX separators) or throws ImportError. */
function safeEntryPath(fileName) {
  const normalized = fileName.replace(/\/+$/, '')
  if (!normalized || fileName.includes('\\') || fileName.includes('\0') || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new ImportError('The archive contains an unsafe path', { step: 1 })
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..' || part === '.' || part === '')) {
    throw new ImportError('The archive contains an unsafe path', { step: 1 })
  }
  return parts.join('/')
}

function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug || 'model'
}

function readJson(fs, file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new ImportError(`${what} is not valid JSON`, { step: 2 })
  }
}

/** Shallowest `*.model3.json` under root; several at the same depth is an error. */
function findModel3(fs, root) {
  const found = []
  const visit = (dir, depth) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name)
      if (dirent.isDirectory()) visit(full, depth + 1)
      else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.model3.json')) found.push({ full, depth })
    }
  }
  visit(root, 0)
  if (found.length === 0) throw new ImportError('Missing *.model3.json', { step: 2 })
  const shallowest = Math.min(...found.map((item) => item.depth))
  const top = found.filter((item) => item.depth === shallowest)
  if (top.length > 1) throw new ImportError('The archive contains several model3.json files at the same level', { step: 2 })
  return top[0].full
}

function referencedFiles(refs) {
  const files = []
  const add = (value) => { if (typeof value === 'string' && value) files.push(value) }
  add(refs.Moc)
  add(refs.Physics)
  add(refs.Pose)
  add(refs.DisplayInfo)
  add(refs.UserData)
  for (const texture of Array.isArray(refs.Textures) ? refs.Textures : []) add(texture)
  for (const exp of Array.isArray(refs.Expressions) ? refs.Expressions : []) add(exp?.File)
  for (const group of Object.values(refs.Motions && typeof refs.Motions === 'object' ? refs.Motions : {})) {
    for (const motion of Array.isArray(group) ? group : []) {
      add(motion?.File)
      add(motion?.Sound)
    }
  }
  return files
}

function insideDir(root, target) {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

class ModelLibrary {
  constructor({ home, fs = nodeFs, openZip = defaultOpenZip, now = Date.now, limits = {}, overrideSeeds = {} }) {
    if (typeof home !== 'string' || !home) throw new TypeError('model library home is required')
    this.paths = resolvePaths(home)
    this._fs = fs
    this._openZip = openZip
    this._now = now
    this._limits = { ...DEFAULT_LIMITS, ...limits }
    this._seeds = overrideSeeds
  }

  /** Lists installed models. Broken manifests are skipped with a warning. */
  scan() {
    const fs = this._fs
    const models = []
    const warnings = []
    let names = []
    try {
      names = fs.readdirSync(this.paths.modelsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return { models, warnings }
    }
    for (const id of names.sort()) {
      if (!isValidModelId(id)) continue
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(this.paths.modelsDir, id, MANIFEST_FILE_NAME), 'utf8'))
        if (manifest.id !== id || typeof manifest.entry !== 'string') throw new Error('manifest does not match directory')
        if (!insideDir(path.join(this.paths.modelsDir, id), path.join(this.paths.modelsDir, id, manifest.entry))) throw new Error('entry escapes model directory')
        manifest.hasThumb = fs.existsSync(path.join(this.paths.modelsDir, id, THUMB_FILE_NAME))
        models.push(manifest)
      } catch (error) {
        warnings.push(`Skipped model "${id}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { models, warnings }
  }

  coreInfo() {
    try {
      const stat = this._fs.statSync(this.paths.coreFile)
      return stat.isFile() ? { installed: true, path: this.paths.coreFile, bytes: stat.size } : { installed: false }
    } catch {
      return { installed: false }
    }
  }

  /** `activeId` is optional; a model counts as ready when it exists in the library. */
  readiness(activeId = null) {
    const { models } = this.scan()
    return { core: this.coreInfo().installed, model: activeId ? models.some((m) => m.id === activeId) : models.length > 0 }
  }

  modelFilePath(id, rel = '') {
    if (!isValidModelId(id)) return null
    const root = path.join(this.paths.modelsDir, id)
    const target = path.join(root, rel)
    return target === root || insideDir(root, target) ? target : null
  }

  removeModel(id, { activeId = null } = {}) {
    if (!isValidModelId(id)) throw new Error('Invalid model id')
    if (id === activeId) throw new Error('The active model cannot be removed')
    const dir = path.join(this.paths.modelsDir, id)
    if (!this._fs.existsSync(dir)) throw new Error('Model not found')
    this._fs.rmSync(dir, { recursive: true, force: true })
  }

  /** Remove leftover temp directories from crashed imports. */
  cleanupStaleTmp() {
    const fs = this._fs
    let names = []
    try { names = fs.readdirSync(this.paths.tmpDir) } catch { return 0 }
    let removed = 0
    for (const name of names) {
      const full = path.join(this.paths.tmpDir, name)
      try {
        if (this._now() - fs.statSync(full).mtimeMs > STALE_TMP_MS) {
          fs.rmSync(full, { recursive: true, force: true })
          removed += 1
        }
      } catch { /* raced with another cleanup */ }
    }
    return removed
  }

  /**
   * Import a model zip. Resolves `{ id, manifest }`; throws ImportError (UI-safe message)
   * after cleaning the temp directory. `onProgress({ step, total, label })` fires per stage.
   */
  async importModelZip(zipPath, onProgress = () => {}) {
    const fs = this._fs
    const total = IMPORT_STEPS.length
    const progress = (step) => onProgress({ step, total, label: IMPORT_STEPS[step] })
    fs.mkdirSync(this.paths.tmpDir, { recursive: true, mode: 0o700 })
    const work = fs.mkdtempSync(path.join(this.paths.tmpDir, 'import-'))
    const extractRoot = path.join(work, 'x')
    try {
      progress(0)
      let size
      try { size = fs.statSync(zipPath).size } catch { throw new ImportError('Cannot read the file', { step: 0 }) }
      if (size > this._limits.zipBytes) throw new ImportError('The file is too large', { step: 0 })
      let zip
      try { zip = await this._openZip(zipPath) } catch { throw new ImportError('Not a valid zip file', { step: 0 }) }

      progress(1)
      fs.mkdirSync(extractRoot, { recursive: true })
      await this._extract(zip, extractRoot)

      progress(2)
      const model3Path = findModel3(fs, extractRoot)
      const modelRoot = path.dirname(model3Path)
      const entry = path.basename(model3Path)
      const model3 = readJson(fs, model3Path, entry)
      const refs = model3?.FileReferences
      if (!refs || typeof refs !== 'object' || typeof refs.Moc !== 'string') throw new ImportError(`${entry} has no Moc reference`, { step: 2 })
      for (const rel of referencedFiles(refs)) {
        let target
        try { target = path.resolve(modelRoot, decodeURIComponent(rel)) } catch { target = null }
        if (!target || !insideDir(modelRoot, target)) throw new ImportError(`Referenced file "${rel}" is outside the model`, { step: 2 })
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new ImportError(`Referenced file "${rel}" does not exist`, { step: 2 })
      }
      this._checkMoc3(path.join(modelRoot, refs.Moc))

      progress(3)
      const baseName = entry.replace(/\.model3\.json$/i, '')
      const id = this._newId(baseName)
      const manifest = {
        version: MANIFEST_VERSION,
        id,
        name: baseName,
        entry,
        importedAt: new Date(this._now()).toISOString(),
        source: path.basename(zipPath),
        bytes: size,
        motions: Object.keys(refs.Motions && typeof refs.Motions === 'object' ? refs.Motions : {}),
        expressions: (Array.isArray(refs.Expressions) ? refs.Expressions : []).map((e) => e?.Name).filter((n) => typeof n === 'string'),
        parts: this._readParts(modelRoot, refs.DisplayInfo),
        overrides: this._seeds[entry] ?? {},
      }
      fs.writeFileSync(path.join(modelRoot, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
      fs.mkdirSync(this.paths.modelsDir, { recursive: true, mode: 0o700 })
      try {
        fs.renameSync(modelRoot, path.join(this.paths.modelsDir, id))
      } catch {
        throw new ImportError('Installation failed', { step: 3 })
      }
      return { id, manifest }
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  }

  /** Install Cubism Core from a bare `.js` file or an SDK zip. */
  async importCore(sourcePath) {
    const fs = this._fs
    let buffer
    try {
      if (/\.zip$/i.test(sourcePath)) {
        buffer = await this._readCoreFromZip(sourcePath)
      } else {
        const stat = fs.statSync(sourcePath)
        if (!stat.isFile() || stat.size > this._limits.coreBytes) throw new ImportError('Not a valid Cubism Core file')
        buffer = fs.readFileSync(sourcePath)
      }
    } catch (error) {
      if (error instanceof ImportError) throw error
      throw new ImportError('Cannot read the file')
    }
    if (!buffer.includes('Live2DCubismCore')) throw new ImportError('Not a valid Cubism Core (no Live2DCubismCore found)')
    fs.mkdirSync(this.paths.coreDir, { recursive: true, mode: 0o700 })
    const temp = path.join(this.paths.coreDir, `.${CORE_FILE_NAME}.${process.pid}.${this._now()}.tmp`)
    try {
      fs.writeFileSync(temp, buffer, { mode: 0o600 })
      fs.renameSync(temp, this.paths.coreFile)
    } finally {
      fs.rmSync(temp, { force: true })
    }
    return this.coreInfo()
  }

  async _readCoreFromZip(zipPath) {
    let zip
    try { zip = await this._openZip(zipPath) } catch { throw new ImportError('Not a valid zip file') }
    let result = null
    await walkZip(zip, async (entry, openStream) => {
      if (/\/$/.test(entry.fileName) || !new RegExp(`(^|/)${CORE_FILE_NAME.replace(/\./g, '\\.')}$`, 'i').test(entry.fileName)) return true
      if (entry.uncompressedSize > this._limits.coreBytes) throw new ImportError('Not a valid Cubism Core file')
      const chunks = []
      for await (const chunk of await openStream(entry)) chunks.push(chunk)
      result = Buffer.concat(chunks)
      return false
    })
    if (!result) throw new ImportError(`${CORE_FILE_NAME} not found in the archive`)
    return result
  }

  async _extract(zip, extractRoot) {
    const fs = this._fs
    const limits = this._limits
    let count = 0
    let declared = 0
    const seen = new Set()
    try {
      await walkZip(zip, async (entry, openStream) => {
        count += 1
        if (count > limits.entries) throw new ImportError('The archive has too many files', { step: 1 })
        declared += entry.uncompressedSize
        if (declared > limits.uncompressedBytes) throw new ImportError('The archive is too large when extracted', { step: 1 })
        const isDir = /\/$/.test(entry.fileName)
        const rel = safeEntryPath(entry.fileName)
        if (isSymlink(entry)) throw new ImportError('The archive contains an unsafe path', { step: 1 })
        const key = rel.toLowerCase()
        if (seen.has(key)) throw new ImportError('The archive contains conflicting file names', { step: 1 })
        seen.add(key)
        const target = path.join(extractRoot, rel)
        if (!insideDir(extractRoot, target)) throw new ImportError('The archive contains an unsafe path', { step: 1 })
        if (isDir) {
          fs.mkdirSync(target, { recursive: true })
          return true
        }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const stream = await openStream(entry)
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(target, { flags: 'wx' })
          stream.on('error', reject)
          out.on('error', reject)
          out.on('finish', resolve)
          stream.pipe(out)
        })
        return true
      })
    } catch (error) {
      if (error instanceof ImportError) throw error
      throw new ImportError('Not a valid zip file', { step: 1 })
    }
  }

  _checkMoc3(file) {
    const fd = this._fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(5)
      const read = this._fs.readSync(fd, head, 0, 5, 0)
      if (read < 5 || head.toString('latin1', 0, 4) !== 'MOC3') throw new ImportError('Not a valid moc3 file', { step: 2 })
    } finally {
      this._fs.closeSync(fd)
    }
  }

  _readParts(modelRoot, displayInfo) {
    if (typeof displayInfo !== 'string') return []
    try {
      const cdi = JSON.parse(this._fs.readFileSync(path.join(modelRoot, displayInfo), 'utf8'))
      return (Array.isArray(cdi.Parts) ? cdi.Parts : []).map((p) => p?.Name ?? p?.Id).filter((n) => typeof n === 'string')
    } catch {
      return []
    }
  }

  _newId(baseName) {
    const slug = slugify(baseName)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const hash = crypto.createHash('sha1').update(`${baseName}:${this._now()}:${attempt}:${crypto.randomBytes(4).toString('hex')}`).digest('hex').slice(0, 4)
      const id = `${slug}-${hash}`
      if (!this._fs.existsSync(path.join(this.paths.modelsDir, id))) return id
    }
    throw new ImportError('Installation failed', { step: 3 })
  }
}

module.exports = {
  DEFAULT_LIMITS,
  IMPORT_STEPS,
  ImportError,
  ModelLibrary,
  MANIFEST_VERSION,
}
