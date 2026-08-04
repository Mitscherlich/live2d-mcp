'use strict'

/**
 * voice-source.cjs 单测（ADR 0001 · F6 · NFR-3）
 *
 * 覆盖：四模式 sanitize（合法/非法）、pattern 长度/正则校验、application source
 * 校验、env 配置解析（LIVE2D_VOICE_SOURCE_MODE / LIVE2D_TARGET_PROCESS_PATTERN /
 * LIVE2D_VOICE_SOURCE_ID|NAME）与回退 warning、默认 pattern 的匹配语义。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DEFAULT_VOICE_APP_PATTERN,
  DEFAULT_VOICE_SOURCE,
  MAX_VOICE_SOURCE_PATTERN_LENGTH,
  VOICE_SOURCE_MODES,
  compileVoiceSourcePattern,
  encodeIdentity,
  isValidVoiceSourceId,
  normalizeVoiceSource,
  processMatchesSource,
  processSourceId,
  resolveVoiceSourceConfig,
  resolveVoiceSourceFromEnv,
  resolveVoiceSourcePattern,
  sanitizeVoiceSource,
  sanitizeVoiceSourcePattern,
} = require('../voice-source.cjs')

test('模式枚举恰为 SPEC 四模式（automatic 对齐 persona default）', () => {
  assert.deepEqual([...VOICE_SOURCE_MODES].sort(), [
    'application',
    'automatic',
    'custom',
    'external',
  ])
})

test('sanitize：automatic 与 external 为无字段空源', () => {
  assert.deepEqual(sanitizeVoiceSource({ mode: 'automatic' }), {
    mode: 'automatic',
    process_pattern: null,
    source_id: null,
    source_name: null,
  })
  assert.deepEqual(sanitizeVoiceSource({ mode: 'external' }), {
    mode: 'external',
    process_pattern: null,
    source_id: null,
    source_name: null,
  })
  // external 忽略多余字段（不携带进程匹配配置）
  assert.deepEqual(
    sanitizeVoiceSource({ mode: 'external', process_pattern: 'codex', source_id: 'x' }).mode,
    'external',
  )
})

test('sanitize：非法 mode 拒绝（含 persona 旧名 default 的边界映射）', () => {
  for (const bad of [undefined, null, '', 'default', 'auto', 'CUSTOM', 42, {}]) {
    assert.throws(() => sanitizeVoiceSource({ mode: bad }), /mode 非法/)
  }
  assert.throws(() => sanitizeVoiceSource(null), /mode 非法/)
})

test('sanitize：custom 需要合法 process_pattern', () => {
  const ok = sanitizeVoiceSource({ mode: 'custom', process_pattern: '  codex|chatgpt  ' })
  assert.deepEqual(ok, {
    mode: 'custom',
    process_pattern: 'codex|chatgpt',
    source_id: null,
    source_name: null,
  })
  for (const bad of [undefined, '', '   ', '(unclosed', 'a'.repeat(MAX_VOICE_SOURCE_PATTERN_LENGTH + 1)]) {
    assert.throws(() => sanitizeVoiceSource({ mode: 'custom', process_pattern: bad }))
  }
})

test('sanitizeVoiceSourcePattern：边界长度可过，正则非法被拒', () => {
  assert.equal(sanitizeVoiceSourcePattern('a'.repeat(MAX_VOICE_SOURCE_PATTERN_LENGTH)).length, 200)
  assert.throws(() => sanitizeVoiceSourcePattern('['), /合法正则/)
})

test('sanitize：application 需要合法 source_id + source_name', () => {
  const id = `process:darwin:${encodeIdentity('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')}`
  assert.equal(isValidVoiceSourceId(id), true)
  const ok = sanitizeVoiceSource({ mode: 'application', source_id: id, source_name: ' ChatGPT  ' })
  assert.deepEqual(ok, {
    mode: 'application',
    process_pattern: null,
    source_id: id,
    source_name: 'ChatGPT',
  })
  assert.throws(() => sanitizeVoiceSource({ mode: 'application', source_id: 'nope', source_name: 'ChatGPT' }))
  assert.throws(() => sanitizeVoiceSource({ mode: 'application', source_id: id, source_name: ' ' }))
  // pipewire / 其他方案的 id 一律拒绝（linux 监听属预留）
  assert.equal(isValidVoiceSourceId('pipewire:stream:AAAA'), false)
  assert.equal(isValidVoiceSourceId(`process:linux:${encodeIdentity('codex')}`), false)
})

test('normalize：任何非法输入回退默认 automatic 而不抛错', () => {
  for (const bad of [null, undefined, 42, { mode: 'default' }, { mode: 'custom' }, { mode: 'application' }]) {
    assert.deepEqual(normalizeVoiceSource(bad), { ...DEFAULT_VOICE_SOURCE })
  }
})

test('默认 pattern 匹配 codex/chatgpt/openai 类进程路径，不误伤无关进程', () => {
  const hits = [
    '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)',
    'codex-desktop',
    '/usr/local/bin/openai-codex',
  ]
  for (const text of hits) {
    DEFAULT_VOICE_APP_PATTERN.lastIndex = 0
    assert.equal(DEFAULT_VOICE_APP_PATTERN.test(text), true, text)
  }
  for (const text of ['discord', '/usr/bin/scodex', 'chatgptx', 'notcodex', 'firefox']) {
    DEFAULT_VOICE_APP_PATTERN.lastIndex = 0
    assert.equal(DEFAULT_VOICE_APP_PATTERN.test(text), false, text)
  }
})

test('env 解析：默认 automatic；四模式可配；非法 mode 回退 + warning', () => {
  assert.deepEqual(resolveVoiceSourceFromEnv({}).source, { ...DEFAULT_VOICE_SOURCE })

  const ext = resolveVoiceSourceFromEnv({ LIVE2D_VOICE_SOURCE_MODE: 'external' })
  assert.equal(ext.source.mode, 'external')
  assert.deepEqual(ext.warnings, [])

  const custom = resolveVoiceSourceFromEnv({
    LIVE2D_VOICE_SOURCE_MODE: 'custom',
    LIVE2D_TARGET_PROCESS_PATTERN: 'my-agent',
  })
  assert.deepEqual(custom.source, {
    mode: 'custom',
    process_pattern: 'my-agent',
    source_id: null,
    source_name: null,
  })

  const badMode = resolveVoiceSourceFromEnv({ LIVE2D_VOICE_SOURCE_MODE: 'yolo' })
  assert.equal(badMode.source.mode, 'automatic')
  assert.equal(badMode.warnings.length, 1)
  assert.match(badMode.warnings[0], /LIVE2D_VOICE_SOURCE_MODE/)

  const badCustom = resolveVoiceSourceFromEnv({
    LIVE2D_VOICE_SOURCE_MODE: 'custom',
    LIVE2D_TARGET_PROCESS_PATTERN: '(bad',
  })
  assert.equal(badCustom.source.mode, 'automatic')
  assert.equal(badCustom.warnings.length, 1)
})

test('env 解析：application 模式经 env 提供 source；缺失回退 + warning', () => {
  const id = `process:darwin:${encodeIdentity('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')}`
  const ok = resolveVoiceSourceFromEnv({
    LIVE2D_VOICE_SOURCE_MODE: 'application',
    LIVE2D_VOICE_SOURCE_ID: id,
    LIVE2D_VOICE_SOURCE_NAME: 'ChatGPT',
  })
  assert.equal(ok.source.mode, 'application')
  assert.equal(ok.source.source_id, id)

  const missing = resolveVoiceSourceFromEnv({ LIVE2D_VOICE_SOURCE_MODE: 'application' })
  assert.equal(missing.source.mode, 'automatic')
  assert.equal(missing.warnings.length, 1)
})

test('pattern 解析：automatic 可被 LIVE2D_TARGET_PROCESS_PATTERN 覆盖（FR-V6）', () => {
  const auto = resolveVoiceSourcePattern({ source: { mode: 'automatic' }, environment: {} })
  assert.equal(auto.pattern, DEFAULT_VOICE_APP_PATTERN)

  const overridden = resolveVoiceSourcePattern({
    source: { mode: 'automatic' },
    environment: { LIVE2D_TARGET_PROCESS_PATTERN: 'afplay' },
  })
  assert.equal(overridden.pattern.test('AFPLAY'), true)
  assert.equal(overridden.warnings.length, 0)

  const bad = resolveVoiceSourcePattern({
    source: { mode: 'automatic' },
    environment: { LIVE2D_TARGET_PROCESS_PATTERN: '(bad' },
  })
  assert.equal(bad.pattern, DEFAULT_VOICE_APP_PATTERN)
  assert.equal(bad.warnings.length, 1)

  const tooLong = resolveVoiceSourcePattern({
    source: { mode: 'automatic' },
    environment: { LIVE2D_TARGET_PROCESS_PATTERN: 'a'.repeat(201) },
  })
  assert.equal(tooLong.pattern, DEFAULT_VOICE_APP_PATTERN)
  assert.equal(tooLong.warnings.length, 1)
})

test('pattern 解析：custom 用自身 pattern；application/external 为 null', () => {
  const custom = resolveVoiceSourcePattern({
    source: { mode: 'custom', process_pattern: 'my-agent' },
    environment: { LIVE2D_TARGET_PROCESS_PATTERN: 'ignored' },
  })
  assert.equal(custom.pattern.test('my-agent'), true)
  assert.equal(custom.pattern.test('ignored'), false)

  const id = `process:darwin:${encodeIdentity('ChatGPT')}`
  const app = resolveVoiceSourcePattern({
    source: { mode: 'application', source_id: id, source_name: 'ChatGPT' },
    environment: {},
  })
  assert.equal(app.pattern, null)

  const external = resolveVoiceSourcePattern({ source: { mode: 'external' }, environment: {} })
  assert.equal(external.pattern, null)
})

test('resolveVoiceSourceConfig 一站式：source + pattern + warnings 汇总', () => {
  const cfg = resolveVoiceSourceConfig({ LIVE2D_VOICE_SOURCE_MODE: 'nope' })
  assert.equal(cfg.source.mode, 'automatic')
  assert.equal(cfg.pattern, DEFAULT_VOICE_APP_PATTERN)
  assert.equal(cfg.warnings.length, 1)
})

test('compileVoiceSourcePattern：空/非法回退默认', () => {
  assert.equal(compileVoiceSourcePattern(''), DEFAULT_VOICE_APP_PATTERN)
  assert.equal(compileVoiceSourcePattern('(bad'), DEFAULT_VOICE_APP_PATTERN)
  assert.equal(compileVoiceSourcePattern('codex').test('CODEX'), true)
})

test('processSourceId / processMatchesSource：application 匹配语义（darwin）', () => {
  const proc = { pid: 100, name: 'ChatGPT', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }
  const id = processSourceId('darwin', proc)
  assert.equal(id?.startsWith('process:darwin:'), true)
  assert.equal(processMatchesSource(proc, 'darwin', id), true)
  assert.equal(processMatchesSource({ ...proc, executable: '/other/path' }, 'darwin', id), false)
  // 非 darwin/win32 平台不产 source id（linux 预留）
  assert.equal(processSourceId('linux', proc), null)
})
