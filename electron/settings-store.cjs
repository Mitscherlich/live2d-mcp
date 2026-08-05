'use strict'

/**
 * userData JSON 设置存储（ADR 0001 · F7 · FR-S1）。写入前复用
 * voice-source.cjs 的权威 sanitize；临时文件 + rename 避免半写损坏。
 */

const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_VOICE_SOURCE, sanitizeVoiceSource } = require('./voice-source.cjs')

const SETTINGS_VERSION = 1

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    voiceSource: { ...DEFAULT_VOICE_SOURCE },
  }
}

function sanitizeSettings(value) {
  return {
    version: SETTINGS_VERSION,
    voiceSource: sanitizeVoiceSource(value?.voiceSource),
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
  SETTINGS_VERSION,
  createSettingsStore,
  defaultSettings,
  sanitizeSettings,
}
