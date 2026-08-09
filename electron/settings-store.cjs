'use strict'

/**
 * userData JSON 设置存储（ADR 0001 · F7 · FR-S1）。写入前复用
 * voice-source.cjs 的权威 sanitize；临时文件 + rename 避免半写损坏。
 * 窗口状态模型（sanitize/常量）唯一实现点在 window-state.cjs。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_VOICE_SOURCE, sanitizeVoiceSource } = require('./voice-source.cjs')
const { DEFAULT_WINDOW_STATE, sanitizeWindowState } = require('./window-state.cjs')

const SETTINGS_VERSION = 1

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    voiceSource: { ...DEFAULT_VOICE_SOURCE },
    window: { ...DEFAULT_WINDOW_STATE },
  }
}

function sanitizeSettings(value) {
  return {
    version: SETTINGS_VERSION,
    voiceSource: sanitizeVoiceSource(value?.voiceSource),
    window: sanitizeWindowState(value?.window),
  }
}

/**
 * 设置存储（带内存缓存的唯一真值）。load() 后 `current` 恒为最近一份合法
 * settings；save* 系原子落盘并同步缓存。调用方不再自持 settings 副本。
 */
class SettingsStore {
  constructor({ filePath }) {
    if (typeof filePath !== 'string' || !filePath) {
      throw new TypeError('settings store filePath 必填')
    }
    this.filePath = filePath
    this._current = defaultSettings()
  }

  /** 最近一份合法 settings（未 load 时为默认） */
  get current() {
    return this._current
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this._current = defaultSettings()
      return { settings: this._current, warnings: [] }
    }
    try {
      this._current = sanitizeSettings(JSON.parse(fs.readFileSync(this.filePath, 'utf8')))
      return { settings: this._current, warnings: [] }
    } catch (error) {
      this._current = defaultSettings()
      return {
        settings: this._current,
        warnings: [`设置读取失败，已回退 automatic：${error instanceof Error ? error.message : String(error)}`],
      }
    }
  }

  /** 全量替换语义：sanitize → 原子落盘 → 更新缓存，返回落盘的 settings */
  save(value) {
    const settings = sanitizeSettings(value)
    const directory = path.dirname(this.filePath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tempPath, this.filePath)
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
    this._current = settings
    return settings
  }

  /** 只更新窗口状态（保留其余字段） */
  saveWindowState(state) {
    return this.save({ ...this._current, window: state })
  }

  /** 只更新 voice source（保留其余字段） */
  saveVoiceSource(voiceSource) {
    return this.save({ ...this._current, voiceSource })
  }
}

module.exports = {
  SETTINGS_VERSION,
  SettingsStore,
  defaultSettings,
  sanitizeSettings,
}
