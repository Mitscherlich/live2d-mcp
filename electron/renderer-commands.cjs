'use strict'

/**
 * main ↔ renderer 命令通道（ADR 0001 · F5，MCP 工具的执行路径）
 *
 * 帧协议（Electron IPC）：
 *  - main → renderer：`live2d:command`     { requestId, type, params }
 *  - renderer → main：`live2d:command-result` { requestId, result:{ ok, data?, error? } }
 *  - renderer → main：`live2d:command-ready`（preload onCommand 注册成功即发一帧，
 *    main 据此判断命令通道已挂接；窗口重建时重置）
 *
 * type 白名单即 SPEC §6.4 视觉工具面在 renderer 的对应命令；白名单外一律拒绝。
 * 本模块为纯函数/常量，无 Electron 依赖：main 直接 require，node:test 直测（NFR-3）。
 * preload.cjs 因 sandbox 限制无法 require 本文件，内联同名常量（改动时需同步）。
 */

const COMMAND_CHANNEL = 'live2d:command'
const COMMAND_RESULT_CHANNEL = 'live2d:command-result'
const COMMAND_READY_CHANNEL = 'live2d:command-ready'
const COMMAND_TIMEOUT_MS = 2000

const COMMAND_TYPES = new Set([
  'getModelInfo',
  'setExpression',
  'playMotion',
  'lookAt',
  'setParameter',
  'reset',
])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCommandType(type) {
  return typeof type === 'string' && COMMAND_TYPES.has(type)
}

/**
 * 校验 main → renderer 命令帧形状（preload 浅校验用同构逻辑）。
 * @returns {boolean}
 */
function isCommandFrameShape(raw) {
  return (
    isPlainObject(raw) &&
    typeof raw.requestId === 'string' &&
    raw.requestId.length > 0 &&
    raw.requestId.length <= 64 &&
    isCommandType(raw.type) &&
    isPlainObject(raw.params)
  )
}

/**
 * 规范化 renderer → main 的结果帧；非法形状返回 null（main 丢弃并告警）。
 * result 约定：{ ok:boolean, data?, error? }；error 截断 500 字符。
 * @returns {{ requestId: string, result: { ok: boolean, data?: unknown, error?: string } }|null}
 */
function normalizeCommandResultFrame(raw) {
  if (!isPlainObject(raw) || typeof raw.requestId !== 'string') return null
  const result = normalizeCommandResult(raw.result)
  if (result === null) return null
  return { requestId: raw.requestId, result }
}

function normalizeCommandResult(raw) {
  if (!isPlainObject(raw) || typeof raw.ok !== 'boolean') return null
  const out = { ok: raw.ok }
  if (raw.data !== undefined) out.data = raw.data
  if (raw.error !== undefined) {
    if (typeof raw.error !== 'string') return null
    out.error = raw.error.slice(0, 500)
  }
  return out
}

module.exports = {
  COMMAND_CHANNEL,
  COMMAND_RESULT_CHANNEL,
  COMMAND_READY_CHANNEL,
  COMMAND_TIMEOUT_MS,
  COMMAND_TYPES,
  isCommandType,
  isCommandFrameShape,
  normalizeCommandResult,
  normalizeCommandResultFrame,
}
