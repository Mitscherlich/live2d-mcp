'use strict'

/**
 * 设置窗 action 负载校验（DESIGN.md §4.2）。
 *
 * 快捷弹窗与完整设置窗经 `live2d:settings:action` 发来 `{ type, ... }`；
 * 本模块是白名单唯一实现点：未知 type、缺参、类型不符一律抛 TypeError，
 * 由 main 侧转成 `{ ok:false, error }`。返回值只含白名单字段（丢弃多余键），
 * 下游执行逻辑无需再做防御。
 *
 * 纯函数、无 Electron 依赖：node:test 直测。
 */

const { isFiniteNumber, isPlainObject } = require('./protocol-utils.cjs')

const COPY_KINDS = Object.freeze(['codex', 'claude', 'url'])
const SETTINGS_SECTIONS = Object.freeze(['voice', 'mcp', 'avatar', 'general', 'diag'])
const POPOVER_MIN_HEIGHT = 200
const POPOVER_MAX_HEIGHT = 640

const NO_ARG_ACTIONS = new Set([
  'avatar-show',
  'avatar-hide',
  'avatar-reset',
  'close-popover',
  'open-permission-settings',
  'reveal-settings-file',
  'quit',
])

const SETTINGS_ACTION_TYPES = Object.freeze([
  ...NO_ARG_ACTIONS,
  'set-scale',
  'open-full',
  'fit-popover',
  'set-login-item',
])

/**
 * @param {unknown} payload 页面传入的 action
 * @returns {{ type: string, [key: string]: unknown }} 规范化后的 action
 */
function parseSettingsAction(payload) {
  if (!isPlainObject(payload) || typeof payload.type !== 'string') {
    throw new TypeError('设置 action 非法：需要 { type }')
  }
  const { type } = payload
  if (NO_ARG_ACTIONS.has(type)) return { type }

  switch (type) {
    case 'set-scale':
      if (!isFiniteNumber(payload.scale)) throw new TypeError('set-scale 需要有限数 scale')
      return { type, scale: payload.scale }
    case 'open-full': {
      const section = payload.section ?? null
      if (section !== null && !SETTINGS_SECTIONS.includes(section)) {
        throw new TypeError(`open-full 的 section 非法：${String(section)}`)
      }
      return { type, section }
    }
    case 'fit-popover':
      if (!isFiniteNumber(payload.height)) throw new TypeError('fit-popover 需要有限数 height')
      return {
        type,
        height: Math.round(Math.min(POPOVER_MAX_HEIGHT, Math.max(POPOVER_MIN_HEIGHT, payload.height))),
      }
    case 'set-login-item':
      if (typeof payload.enabled !== 'boolean') throw new TypeError('set-login-item 需要布尔 enabled')
      return { type, enabled: payload.enabled }
    default:
      throw new TypeError(`未知设置 action：${type}`)
  }
}

/** copy-command 的 kind：缺省 codex；非法抛 TypeError */
function parseCopyKind(kind) {
  if (kind === undefined || kind === null) return 'codex'
  if (!COPY_KINDS.includes(kind)) throw new TypeError(`复制类型非法：${String(kind)}`)
  return kind
}

module.exports = {
  COPY_KINDS,
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_HEIGHT,
  SETTINGS_ACTION_TYPES,
  SETTINGS_SECTIONS,
  parseCopyKind,
  parseSettingsAction,
}
