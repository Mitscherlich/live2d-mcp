'use strict'

/**
 * userData JSON 设置存储（ADR 0001 · F7 · FR-S1）。写入前复用
 * voice-source.cjs 的权威 sanitize；临时文件 + rename 避免半写损坏。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_VOICE_SOURCE, sanitizeVoiceSource } = require('./voice-source.cjs')

const SETTINGS_VERSION = 1
const MIN_WINDOW_WIDTH = 360
const MAX_WINDOW_WIDTH = 4096
const MIN_WINDOW_HEIGHT = 480
const MAX_WINDOW_HEIGHT = 4096
const MIN_WINDOW_SCALE = 0.5
const MAX_WINDOW_SCALE = 1.75

const DEFAULT_WINDOW_STATE = Object.freeze({
  x: null,
  y: null,
  width: 600,
  height: 640,
  scale: 1,
})

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function sanitizePosition(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function sanitizeDimension(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return clamp(Math.round(value), min, max)
}

function sanitizeScale(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WINDOW_STATE.scale
  return Math.round(clamp(value, MIN_WINDOW_SCALE, MAX_WINDOW_SCALE) * 100) / 100
}

function sanitizeWindowState(value) {
  return {
    x: sanitizePosition(value?.x),
    y: sanitizePosition(value?.y),
    width: sanitizeDimension(value?.width, DEFAULT_WINDOW_STATE.width, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
    height: sanitizeDimension(value?.height, DEFAULT_WINDOW_STATE.height, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT),
    scale: sanitizeScale(value?.scale),
  }
}

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

function createSettingsStore({ filePath }) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('settings store filePath 必填')
  }

  return {
    filePath,
    load() {
      if (!fs.existsSync(filePath)) return { settings: defaultSettings(), warnings: [] }
      try {
        const settings = sanitizeSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')))
        return { settings, warnings: [] }
      } catch (error) {
        return {
          settings: defaultSettings(),
          warnings: [`设置读取失败，已回退 automatic：${error instanceof Error ? error.message : String(error)}`],
        }
      }
    },
    save(value) {
      const settings = sanitizeSettings(value)
      const directory = path.dirname(filePath)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      try {
        fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
        fs.renameSync(tempPath, filePath)
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      }
      return settings
    },
  }
}

module.exports = {
  DEFAULT_WINDOW_STATE,
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_SCALE,
  MAX_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_SCALE,
  MIN_WINDOW_WIDTH,
  SETTINGS_VERSION,
  createSettingsStore,
  defaultSettings,
  sanitizeWindowState,
  sanitizeSettings,
}
