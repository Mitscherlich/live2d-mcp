'use strict'

/**
 * Voice 事件规范化（ADR 0001 · F3，main 进程权威校验点）
 *
 * 所有进入 renderer 的 voice 事件（F4 的 bridge /events、本片 F3 的
 * ipcMain 'live2d:voice-inject' 测试注入）都必须先过 normalizeVoiceEvent：
 *  - 白名单字段（type / state.phase / state.activity / muted 标志 / level）
 *  - level 必须有限数字并 clamp 到 [0,1]（SPEC §8.2）
 *  - phase/activity 枚举外一律拒绝（NFR-3：非法输入拒绝）
 *
 * 规范化输出形状与 SPEC §8.1/§8.2 一致，renderer（renderer/src/voice-state.ts）
 * 可直接消费。preload 侧只做浅校验（type 白名单），权威规范化在本模块。
 *
 * 纯函数、无 Electron 依赖：node:test 直接 require 单测（NFR-3）。
 */

const VOICE_EVENT_CHANNEL = 'live2d:voice'
const VOICE_INJECT_CHANNEL = 'live2d:voice-inject'

const VALID_PHASES = new Set(['inactive', 'starting', 'active', 'stopping'])
const VALID_ACTIVITIES = new Set(['idle', 'listening', 'speaking'])

function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStatePayload(rawState) {
  if (!isPlainObject(rawState)) return null
  const state = {}
  if (rawState.phase !== undefined) {
    if (typeof rawState.phase !== 'string' || !VALID_PHASES.has(rawState.phase)) return null
    state.phase = rawState.phase
  }
  if (rawState.activity !== undefined) {
    if (typeof rawState.activity !== 'string' || !VALID_ACTIVITIES.has(rawState.activity)) {
      return null
    }
    state.activity = rawState.activity
  }
  // phase 与 activity 至少给其一，否则事件无信息量
  if (state.phase === undefined && state.activity === undefined) return null
  // 可选布尔标志（SPEC §8.1 示例字段；仅接受真布尔，省略即不带）
  for (const key of ['microphoneMuted', 'outputMuted']) {
    if (rawState[key] !== undefined) {
      if (typeof rawState[key] !== 'boolean') return null
      state[key] = rawState[key]
    }
  }
  return state
}

/**
 * 规范化 voice 事件；非法输入返回 null（调用方应丢弃并日志）。
 * @param {unknown} raw 来自 IPC / HTTP 的不可信负载
 * @returns {{type:'state', state:object}|{type:'audio-level', level:number}|null}
 */
function normalizeVoiceEvent(raw) {
  if (!isPlainObject(raw) || typeof raw.type !== 'string') return null
  if (raw.type === 'audio-level') {
    const level = clamp01(raw.level)
    if (level === null) return null
    return { type: 'audio-level', level }
  }
  if (raw.type === 'state') {
    const state = normalizeStatePayload(raw.state)
    if (state === null) return null
    return { type: 'state', state }
  }
  return null
}

module.exports = {
  VOICE_EVENT_CHANNEL,
  VOICE_INJECT_CHANNEL,
  normalizeVoiceEvent,
}
