'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSettingsStore } = require('../settings-store.cjs')

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-settings-test-'))
  try {
    return callback(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('设置文件不存在时读取默认 automatic 配置', () => withTempDir((directory) => {
  const store = createSettingsStore({ filePath: path.join(directory, 'settings.json') })
  assert.deepEqual(store.load(), {
    settings: {
      version: 1,
      voiceSource: {
        mode: 'automatic',
        process_pattern: null,
        source_id: null,
        source_name: null,
      },
      window: {
        x: null,
        y: null,
        width: 600,
        height: 640,
        scale: 1,
      },
    },
    warnings: [],
  })
}))

test('设置写入复用 voice source sanitize 并可持久化读取', () => withTempDir((directory) => {
  const filePath = path.join(directory, 'nested', 'settings.json')
  const store = createSettingsStore({ filePath })
  const saved = store.save({
    voiceSource: { mode: 'custom', process_pattern: '  codex|chatgpt  ' },
  })

  assert.equal(saved.voiceSource.process_pattern, 'codex|chatgpt')
  assert.deepEqual(store.load(), { settings: saved, warnings: [] })
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).version, 1)
}))

test('窗口状态按有限坐标、尺寸范围和缩放范围规范化', () => withTempDir((directory) => {
  const store = createSettingsStore({ filePath: path.join(directory, 'settings.json') })
  const saved = store.save({
    voiceSource: { mode: 'automatic' },
    window: {
      x: 12.6,
      y: null,
      width: 100,
      height: 99999,
      scale: 2,
    },
  })

  assert.deepEqual(saved.window, {
    x: 13,
    y: null,
    width: 360,
    height: 4096,
    scale: 1.75,
  })
  assert.deepEqual(store.load().settings.window, saved.window)
}))

test('缺失或非法窗口状态字段回退到默认值，坐标回退为 null', () => withTempDir((directory) => {
  const store = createSettingsStore({ filePath: path.join(directory, 'settings.json') })
  const saved = store.save({
    voiceSource: { mode: 'automatic' },
    window: {
      x: 'bad',
      y: Number.POSITIVE_INFINITY,
      width: Number.NaN,
      height: null,
      scale: '1.2',
    },
  })

  assert.deepEqual(saved.window, {
    x: null,
    y: null,
    width: 600,
    height: 640,
    scale: 1,
  })
}))

test('非法设置不会覆盖上一份有效配置', () => withTempDir((directory) => {
  const filePath = path.join(directory, 'settings.json')
  const store = createSettingsStore({ filePath })
  store.save({ voiceSource: { mode: 'external' } })
  const before = fs.readFileSync(filePath, 'utf8')

  assert.throws(
    () => store.save({ voiceSource: { mode: 'custom', process_pattern: '[bad' } }),
    /合法正则/,
  )
  assert.equal(fs.readFileSync(filePath, 'utf8'), before)
  assert.equal(store.load().settings.voiceSource.mode, 'external')
}))

test('损坏的 JSON 安全回退默认并给出 warning', () => withTempDir((directory) => {
  const filePath = path.join(directory, 'settings.json')
  fs.writeFileSync(filePath, '{not-json')
  const result = createSettingsStore({ filePath }).load()
  assert.equal(result.settings.voiceSource.mode, 'automatic')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /读取失败/)
}))
