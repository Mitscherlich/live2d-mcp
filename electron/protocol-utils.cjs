'use strict'

/**
 * 协议层微小校验原语（ADR 0001 F3/F4/F5/F6 共有）
 *
 * 纯函数、零第三方依赖，main 进程各模块可安全 require。preload 因 sandbox
 * 约束保留各自内联副本（见 preload.cjs 顶部注释），不参与共享。
 */

/** 真对象检查（排除 null / 数组） */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限数字检查（NaN / ±Infinity / 非数字一律 false） */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 严格 clamp 到 [0,1]：非有限数字返回 null（调用方按非法丢弃，NFR-3）。
 * 与 clamp01Lenient 语义不同，勿合并成单一函数。
 */
function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

/**
 * 宽松 clamp 到 [0,1]（helper 协议解码用）：调用方已确认有限数字，
 * 此处仅收敛 clamp 表达式本身。
 */
function clamp01Lenient(value) {
  return Math.min(1, Math.max(0, Number(value)))
}

/**
 * IPC sender 归属校验：event.sender 是否属于指定窗口（窗口已销毁视为不属于）。
 * 各调用点自行决定失败语义（抛错 / 返回布尔）。
 */
function isWindowSender(event, win) {
  return Boolean(win && !win.isDestroyed() && event?.sender === win.webContents)
}

module.exports = { clamp01, clamp01Lenient, isFiniteNumber, isPlainObject, isWindowSender }
