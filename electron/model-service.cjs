'use strict'

/**
 * Model service: the main-process brain of model management. It combines the ModelLibrary
 * (files), SettingsStore (activeId) and the avatar window (hot swap), keeping
 * companion-app.cjs thin. Electron is never required here; the avatar window and the
 * notification hooks are injected.
 */

const path = require('node:path')
const { CORE_FILE_NAME, THUMB_FILE_NAME, isValidModelId } = require('./mayuka-paths.cjs')
const { MODEL_CHANGED_CHANNEL } = require('./model-channels.cjs')
const { ImportError } = require('./model-library.cjs')
const { OVERRIDE_SEEDS, DAFEIYU_ENTRY } = require('./model-override-seeds.cjs')

const SWAP_TIMEOUT_MS = 30_000
const MAX_THUMB_BYTES = 2 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function userModelUrl(id, entry) {
  return `/user-models/${id}/${encodeURIComponent(entry)}`
}

class ModelService {
  /**
   * @param {object} deps
   * @param {import('./model-library.cjs').ModelLibrary} deps.library
   * @param {import('./settings-store.cjs').SettingsStore} deps.settingsStore
   * @param {() => any} deps.getAvatarWindow
   * @param {() => void} deps.onChanged called after any state change (settings/popover refresh, tray rebuild)
   * @param {{ coreUrl: string|null, modelUrl: string|null }} [deps.legacy] dev-only fallback served from renderer/public
   * @param {object} [deps.logger]
   * @param {number} [deps.swapTimeoutMs]
   */
  constructor({ library, settingsStore, getAvatarWindow, onChanged = () => {}, legacy = null, logger = console, swapTimeoutMs = SWAP_TIMEOUT_MS }) {
    this._library = library
    this._store = settingsStore
    this._getWindow = getAvatarWindow
    this._onChanged = onChanged
    this._legacy = legacy
    this._logger = logger
    this._swapTimeoutMs = swapTimeoutMs
    this._pending = new Map()
    this._seq = 0
    this._swapQueue = Promise.resolve()
  }

  /** Active id that still exists in the library, else null. */
  activeId() {
    const id = this._store.current.model?.activeId ?? null
    return id && this._library.scan().models.some((m) => m.id === id) ? id : null
  }

  /** Called at startup: drop a dangling activeId and clean stale temp dirs. */
  reconcile() {
    this._library.cleanupStaleTmp()
    const stored = this._store.current.model?.activeId ?? null
    if (stored && stored !== this.activeId()) this._store.saveActiveModel(null)
  }

  /** What the avatar renderer needs to boot, or `{ missing }`. */
  getActiveModel() {
    const { models } = this._library.scan()
    const id = this.activeId()
    const model = id ? models.find((m) => m.id === id) : null
    const coreInstalled = this._library.coreInfo().installed
    const legacyCore = !coreInstalled && this._legacy?.coreUrl
    const coreUrl = coreInstalled ? `/user-core/${CORE_FILE_NAME}` : (legacyCore || null)
    if (!coreUrl) return { missing: 'core' }
    if (model) {
      return { id: model.id, name: model.name, coreUrl, modelUrl: userModelUrl(model.id, model.entry), overrides: model.overrides ?? {} }
    }
    if (this._legacy?.modelUrl && models.length === 0) {
      return { id: null, name: 'legacy', coreUrl, modelUrl: this._legacy.modelUrl, overrides: OVERRIDE_SEEDS[DAFEIYU_ENTRY] }
    }
    return { missing: 'model' }
  }

  readiness() {
    const active = this.getActiveModel()
    return { core: active.missing !== 'core', model: !active.missing }
  }

  /** View-model slice for the settings windows. */
  describe(readFile = require('node:fs').readFileSync) {
    const { models } = this._library.scan()
    return {
      root: this._library.paths.home,
      core: this._library.coreInfo(),
      activeId: this.activeId(),
      readiness: this.readiness(),
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        author: typeof m.author === 'string' ? m.author : null,
        bytes: m.bytes ?? 0,
        importedAt: m.importedAt ?? null,
        motions: m.motions ?? [],
        expressions: m.expressions ?? [],
        parts: m.parts ?? [],
        thumb: m.hasThumb ? this._thumbDataUrl(m.id, readFile) : null,
      })),
    }
  }

  _thumbDataUrl(id, readFile) {
    try {
      const file = this._library.modelFilePath(id, THUMB_FILE_NAME)
      return file ? `data:image/png;base64,${readFile(file).toString('base64')}` : null
    } catch {
      return null
    }
  }

  async importModel(zipPath, onProgress) {
    if (typeof zipPath !== 'string' || !zipPath) return { ok: false, error: 'No file selected' }
    try {
      const { id } = await this._library.importModelZip(zipPath, onProgress)
      // First model ever: make it current so onboarding ends with a visible character.
      let activated = null
      if (!this.activeId()) activated = await this.activate(id)
      this._onChanged()
      return { ok: true, id, ...(activated && !activated.ok ? { warning: activated.error } : {}) }
    } catch (error) {
      return { ok: false, error: error instanceof ImportError ? error.message : 'Import failed', step: error instanceof ImportError ? error.step : -1 }
    }
  }

  async importCore(sourcePath) {
    if (typeof sourcePath !== 'string' || !sourcePath) return { ok: false, error: 'No file selected' }
    try {
      await this._library.importCore(sourcePath)
    } catch (error) {
      return { ok: false, error: error instanceof ImportError ? error.message : 'Import failed' }
    }
    // The avatar may be sitting in its empty state waiting for Core: let it re-boot.
    this._pushToAvatar()
    this._onChanged()
    return { ok: true }
  }

  removeModel(id) {
    if (!isValidModelId(id)) return { ok: false, error: 'Invalid model id' }
    try {
      this._library.removeModel(id, { activeId: this.activeId() })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Remove failed' }
    }
    this._onChanged()
    return { ok: true }
  }

  saveThumbnail(id, png) {
    if (!isValidModelId(id)) return { ok: false, error: 'Invalid model id' }
    const buffer = Buffer.isBuffer(png) ? png : Buffer.from(png ?? [])
    if (buffer.length < PNG_MAGIC.length || buffer.length > MAX_THUMB_BYTES || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
      return { ok: false, error: 'Invalid thumbnail' }
    }
    const file = this._library.modelFilePath(id, THUMB_FILE_NAME)
    const dir = file && path.dirname(file)
    const fs = require('node:fs')
    if (!file || !fs.existsSync(dir)) return { ok: false, error: 'Model not found' }
    fs.writeFileSync(file, buffer)
    this._onChanged()
    return { ok: true }
  }

  /**
   * Switch the active model. The avatar loads the new model first and only then drops the old
   * one; on failure activeId is rolled back and the old model keeps running.
   * Calls are serialized so rapid clicks cannot interleave swaps.
   */
  activate(id) {
    const run = this._swapQueue.then(() => this._activate(id))
    this._swapQueue = run.catch(() => {})
    return run
  }

  async _activate(id) {
    if (!isValidModelId(id)) return { ok: false, error: 'Invalid model id' }
    const model = this._library.scan().models.find((m) => m.id === id)
    if (!model) return { ok: false, error: 'Model not found' }
    if (id === this.activeId()) return { ok: true, unchanged: true }
    if (!this._library.coreInfo().installed && !this._legacy?.coreUrl) return { ok: false, error: 'Cubism Core is not installed' }
    const previous = this._store.current.model?.activeId ?? null
    this._store.saveActiveModel(id)
    const result = await this._pushToAvatar()
    if (!result.ok) {
      this._store.saveActiveModel(previous && this._library.scan().models.some((m) => m.id === previous) ? previous : null)
      this._onChanged()
      return { ok: false, error: result.error || 'Failed to load the model' }
    }
    this._onChanged()
    return { ok: true }
  }

  /** Ask the avatar window to (re)load the current active model; resolves when it reports back. */
  _pushToAvatar() {
    const win = this._getWindow()
    if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isLoading?.()) {
      // No live renderer: it will read the active model itself when it boots.
      return Promise.resolve({ ok: true })
    }
    const requestId = ++this._seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId)
        resolve({ ok: false, error: 'Timed out loading the model' })
      }, this._swapTimeoutMs)
      timer.unref?.()
      this._pending.set(requestId, (outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      })
      win.webContents.send(MODEL_CHANGED_CHANNEL, { requestId, active: this.getActiveModel() })
    })
  }

  /** Renderer -> main: result of a MODEL_CHANGED request. */
  handleLoadResult(payload) {
    const requestId = payload?.requestId
    const resolve = this._pending.get(requestId)
    if (!resolve) return { ok: false }
    this._pending.delete(requestId)
    resolve({ ok: payload.ok === true, error: typeof payload.error === 'string' ? payload.error.slice(0, 200) : undefined })
    return { ok: true }
  }
}

module.exports = { ModelService, userModelUrl }
