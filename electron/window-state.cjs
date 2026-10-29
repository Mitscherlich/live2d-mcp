'use strict'

/**
 * 窗口状态模型（ADR 0001 F7 持久化 / ADR 0002 桌面交互共有）
 *
 * 窗口 bounds/scale 的常量、默认值与 sanitize 唯一实现点：
 *  - settings-store.cjs 持久化时调用（回退语义：非法值回退默认）
 *  - window-interactions.cjs IPC 入参校验（抛错语义：非法值抛 TypeError）
 *
 * 两种 scale 语义并存：sanitizeScale（回退，持久化数据用）与 normalizeScale
 * （抛错，IPC 入参用）——语义不同，勿合并成单一函数。
 *
 * preload（preload.cjs）与 renderer（desktop-interactions.ts）因进程边界保留
 * 各自内联副本，不参与共享（见 preload.cjs 顶部注释与 source-probe 护栏）。
 *
 * 纯函数、无 Electron 依赖：node:test 直接 require 单测。
 */

const MIN_WINDOW_WIDTH = 360
const MAX_WINDOW_WIDTH = 4096
const MIN_WINDOW_HEIGHT = 480
const MAX_WINDOW_HEIGHT = 4096
const MIN_WINDOW_SCALE = 0.5
const MAX_WINDOW_SCALE = 1.75
const DEFAULT_WINDOW_SCALE = 1

const DEFAULT_WINDOW_STATE = Object.freeze({
  x: null,
  y: null,
  width: 600,
  height: 640,
  scale: DEFAULT_WINDOW_SCALE,
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

/** 回退语义：非法 scale 回退默认（持久化数据用，NFR-3 normalize 系） */
function sanitizeScale(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WINDOW_STATE.scale
  return Math.round(clamp(value, MIN_WINDOW_SCALE, MAX_WINDOW_SCALE) * 100) / 100
}

/** 抛错语义：非法 scale 抛 TypeError（IPC 入参校验用，NFR-3 sanitize 系） */
function normalizeScale(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('缩放值非法：必须是有限数')
  }
  const clamped = clamp(value, MIN_WINDOW_SCALE, MAX_WINDOW_SCALE)
  return Math.round(clamped * 100) / 100
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

module.exports = {
  DEFAULT_WINDOW_SCALE,
  DEFAULT_WINDOW_STATE,
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_SCALE,
  MAX_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_SCALE,
  MIN_WINDOW_WIDTH,
  clamp,
  normalizeScale,
  sanitizeScale,
  sanitizeWindowState,
}
