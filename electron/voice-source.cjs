'use strict'

/**
 * Voice source 配置（ADR 0001 · F6 · SPEC §6.2 FR-V1/V2/V6 · G5）
 *
 * 四模式（SPEC §4 术语表）：
 *  - automatic   默认；按默认/覆盖 regex 匹配 codex/chatgpt/openai 类语音进程
 *  - application 监听指定应用（source_id + source_name；id 方案 process:darwin:<b64>，
 *                进程列表/选择 UI 属 F7 设置窗，本片可用 env 直接提供）
 *  - custom      自定义进程匹配 regex（process_pattern，长度/合法性 sanitize）
 *  - external    关闭进程音频捕获，仅消费 bridge /events 注入
 *
 * 与 persona 契约映射（只读借鉴，MIT）：persona 的 "default" 模式在本仓按 SPEC
 * 命名为 "automatic"；进程名/环境变量均为 live2d 系（LIVE2D_*，非 PERSONA_*）；
 * 未引入 persona 的 pipewire/win32 source id 方案（linux/win 监听属预留，见
 * docs/ARCHITECTURE.md §4.1）。
 *
 * 环境变量（F7 设置窗之前的配置面，FR-V6）：
 *  - LIVE2D_VOICE_SOURCE_MODE    automatic|application|custom|external（默认 automatic）
 *  - LIVE2D_TARGET_PROCESS_PATTERN  覆盖 automatic 的匹配 regex（亦作 custom 的 env 来源）
 *  - LIVE2D_VOICE_SOURCE_ID / LIVE2D_VOICE_SOURCE_NAME  application 模式的 source
 *
 * 非法输入语义（NFR-3）：sanitize 系抛错；normalize/resolve 系回退默认并记录 warning。
 * 纯函数、无 Electron 依赖：node:test 直接 require 单测。
 */

const VOICE_SOURCE_MODES = Object.freeze(['automatic', 'application', 'custom', 'external'])
const VOICE_SOURCE_MODE_SET = new Set(VOICE_SOURCE_MODES)

/** application 模式 source id：process:darwin:<base64url(executable 标识)>（win32 预留） */
const VOICE_SOURCE_ID_PATTERN = /^process:(?:darwin|win32):[A-Za-z0-9_-]{1,2048}$/
const MAX_VOICE_SOURCE_NAME_LENGTH = 120
const MAX_VOICE_SOURCE_PATTERN_LENGTH = 200

/** 默认 automatic 匹配：codex / chatgpt / openai 类进程名（词边界含路径/空白/符号分隔） */
const DEFAULT_VOICE_APP_PATTERN_SOURCE =
  '(?:^|[\\\\/\\s._=-])(?:codex(?:-desktop)?|chatgpt|openai(?:-codex)?)(?=$|[\\\\/\\s._=-])'
const DEFAULT_VOICE_APP_PATTERN = new RegExp(DEFAULT_VOICE_APP_PATTERN_SOURCE, 'i')

const DEFAULT_VOICE_SOURCE = Object.freeze({
  mode: 'automatic',
  process_pattern: null,
  source_id: null,
  source_name: null,
})

function emptyVoiceSource(mode = 'automatic') {
  return { mode, process_pattern: null, source_id: null, source_name: null }
}

/** source_name：trim + 折叠空白 + 长度上限；非法返回 null */
function cleanSourceName(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > MAX_VOICE_SOURCE_NAME_LENGTH) return null
  return normalized
}

/**
 * 编译进程匹配 regex；空/非法回退默认 pattern（调用方如需拒绝语义请用
 * sanitizeVoiceSourcePattern）。
 */
function compileVoiceSourcePattern(source) {
  if (typeof source !== 'string' || !source.trim()) return DEFAULT_VOICE_APP_PATTERN
  try {
    return new RegExp(source, 'i')
  } catch {
    return DEFAULT_VOICE_APP_PATTERN
  }
}

/** custom pattern 权威校验：必填、长度上限、必须可编译；非法抛 Error（NFR-3） */
function sanitizeVoiceSourcePattern(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('process_pattern 必填（custom 模式）')
  }
  const normalized = value.trim()
  if (normalized.length > MAX_VOICE_SOURCE_PATTERN_LENGTH) {
    throw new Error(`process_pattern 长度须 ≤ ${MAX_VOICE_SOURCE_PATTERN_LENGTH} 字符`)
  }
  try {
    new RegExp(normalized, 'i')
  } catch {
    throw new Error('process_pattern 必须是合法正则表达式')
  }
  return normalized
}

function encodeIdentity(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url')
}

function decodeIdentity(value) {
  try {
    return Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

/** source_id 形状校验：process:darwin|win32:<base64url>，且解码后非空 */
function isValidVoiceSourceId(value) {
  if (typeof value !== 'string' || !VOICE_SOURCE_ID_PATTERN.test(value)) return false
  const match = /^process:(?:darwin|win32):([A-Za-z0-9_-]+)$/.exec(value)
  if (!match) return false
  return Boolean(decodeIdentity(match[1])?.trim())
}

/**
 * 权威 sanitize：非法 mode/pattern/source 一律抛 Error（设置入口/单测用）；
 * 运行期宽容入口见 normalizeVoiceSource。
 */
function sanitizeVoiceSource(value) {
  if (!VOICE_SOURCE_MODE_SET.has(value?.mode)) {
    throw new Error(`voice source mode 非法：${JSON.stringify(value?.mode)}`)
  }
  if (value.mode === 'custom') {
    return {
      ...emptyVoiceSource('custom'),
      process_pattern: sanitizeVoiceSourcePattern(value.process_pattern),
    }
  }
  if (value.mode === 'application') {
    const sourceId = isValidVoiceSourceId(value.source_id) ? value.source_id : null
    const sourceName = cleanSourceName(value.source_name)
    if (!sourceId || !sourceName) {
      throw new Error('application 模式需要合法 source_id 与 source_name')
    }
    return { ...emptyVoiceSource('application'), source_id: sourceId, source_name: sourceName }
  }
  return emptyVoiceSource(value.mode)
}

/** 宽容入口：任何非法输入回退默认（automatic），不抛错 */
function normalizeVoiceSource(value) {
  try {
    return sanitizeVoiceSource(value)
  } catch {
    return { ...DEFAULT_VOICE_SOURCE }
  }
}

// ------------------------------------------------------------------ 进程标识

function normalizeProcessIdentity(value, platform) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return ''
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function processIdentity(proc, platform) {
  return normalizeProcessIdentity(proc?.executable || proc?.name, platform)
}

function processSourceId(platform, proc) {
  if (!['darwin', 'win32'].includes(platform)) return null
  const identity = processIdentity(proc, platform)
  return identity ? `process:${platform}:${encodeIdentity(identity)}` : null
}

function processMatchesSource(proc, platform, sourceId) {
  return processSourceId(platform, proc) === sourceId
}

// ------------------------------------------------------------- env 配置解析

/**
 * 从环境变量解析 voice source 配置（F7 设置窗之前的配置面）。
 * @returns {{ source: object, warnings: string[] }}
 *   source 恒为合法 voice source（非法 env 回退 automatic 并记 warning）
 */
function resolveVoiceSourceFromEnv(environment = process.env) {
  const warnings = []
  const rawMode = environment?.LIVE2D_VOICE_SOURCE_MODE
  const mode = typeof rawMode === 'string' && rawMode.trim() ? rawMode.trim() : 'automatic'
  if (!VOICE_SOURCE_MODE_SET.has(mode)) {
    warnings.push(
      `LIVE2D_VOICE_SOURCE_MODE=${JSON.stringify(rawMode)} 非法（可选 ${VOICE_SOURCE_MODES.join('/')}），回退 automatic`,
    )
    return { source: { ...DEFAULT_VOICE_SOURCE }, warnings }
  }
  if (mode === 'custom') {
    try {
      return {
        source: sanitizeVoiceSource({
          mode: 'custom',
          process_pattern: environment?.LIVE2D_TARGET_PROCESS_PATTERN,
        }),
        warnings,
      }
    } catch (error) {
      warnings.push(`custom 模式配置非法（${error.message}），回退 automatic`)
      return { source: { ...DEFAULT_VOICE_SOURCE }, warnings }
    }
  }
  if (mode === 'application') {
    try {
      return {
        source: sanitizeVoiceSource({
          mode: 'application',
          source_id: environment?.LIVE2D_VOICE_SOURCE_ID,
          source_name: environment?.LIVE2D_VOICE_SOURCE_NAME,
        }),
        warnings,
      }
    } catch (error) {
      warnings.push(`application 模式配置非法（${error.message}），回退 automatic`)
      return { source: { ...DEFAULT_VOICE_SOURCE }, warnings }
    }
  }
  return { source: emptyVoiceSource(mode), warnings }
}

/**
 * 解析 listener 实际使用的进程匹配 regex（FR-V1/V6）：
 *  - custom：settings 的 process_pattern（sanitize 保证可编译）
 *  - automatic：LIVE2D_TARGET_PROCESS_PATTERN 覆盖（非法回退默认 + warning）→ 默认 pattern
 *  - application/external：null（分别走 source_id 匹配 / 不捕获）
 * @returns {{ pattern: RegExp|null, warnings: string[] }}
 */
function resolveVoiceSourcePattern({ source, environment = process.env } = {}) {
  const warnings = []
  const normalized = normalizeVoiceSource(source)
  if (normalized.mode === 'custom') {
    return { pattern: new RegExp(normalized.process_pattern, 'i'), warnings }
  }
  if (normalized.mode !== 'automatic') return { pattern: null, warnings }
  const envSource = environment?.LIVE2D_TARGET_PROCESS_PATTERN
  if (typeof envSource === 'string' && envSource.trim()) {
    const trimmed = envSource.trim()
    if (trimmed.length > MAX_VOICE_SOURCE_PATTERN_LENGTH) {
      warnings.push(
        `LIVE2D_TARGET_PROCESS_PATTERN 超长（>${MAX_VOICE_SOURCE_PATTERN_LENGTH}），回退默认 pattern`,
      )
      return { pattern: DEFAULT_VOICE_APP_PATTERN, warnings }
    }
    try {
      return { pattern: new RegExp(trimmed, 'i'), warnings }
    } catch {
      warnings.push('LIVE2D_TARGET_PROCESS_PATTERN 不是合法正则，回退默认 pattern')
      return { pattern: DEFAULT_VOICE_APP_PATTERN, warnings }
    }
  }
  return { pattern: DEFAULT_VOICE_APP_PATTERN, warnings }
}

/**
 * 一站式配置解析（main 启动/热更新用）：环境 mode 明确设置时覆盖持久化 source；
 * 否则使用已 sanitize 的持久化 source。automatic 的 pattern 仍可由既有 env 覆盖。
 */
function resolveVoiceSourceConfig(environment = process.env, persistedSource = DEFAULT_VOICE_SOURCE) {
  const rawMode = environment?.LIVE2D_VOICE_SOURCE_MODE
  const hasEnvironmentMode = typeof rawMode === 'string' && rawMode.trim().length > 0
  const resolvedSource = hasEnvironmentMode
    ? resolveVoiceSourceFromEnv(environment)
    : { source: normalizeVoiceSource(persistedSource), warnings: [] }
  const { source, warnings } = resolvedSource
  const resolved = resolveVoiceSourcePattern({ source, environment })
  const hasPatternOverride =
    source.mode === 'automatic' &&
    typeof environment?.LIVE2D_TARGET_PROCESS_PATTERN === 'string' &&
    environment.LIVE2D_TARGET_PROCESS_PATTERN.trim().length > 0
  return {
    source,
    pattern: resolved.pattern,
    warnings: [...warnings, ...resolved.warnings],
    environmentOverridesVoice: hasEnvironmentMode || hasPatternOverride,
  }
}

module.exports = {
  DEFAULT_VOICE_APP_PATTERN,
  DEFAULT_VOICE_APP_PATTERN_SOURCE,
  DEFAULT_VOICE_SOURCE,
  MAX_VOICE_SOURCE_NAME_LENGTH,
  MAX_VOICE_SOURCE_PATTERN_LENGTH,
  VOICE_SOURCE_ID_PATTERN,
  VOICE_SOURCE_MODES,
  cleanSourceName,
  compileVoiceSourcePattern,
  decodeIdentity,
  emptyVoiceSource,
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
}
