'use strict'

/**
 * main ↔ renderer 命令通道的**请求-响应关联器**（ADR 0001 · F5）
 *
 * 与 electron/renderer-commands.cjs 的分工：
 *  - renderer-commands.cjs 是帧协议本身——频道名、超时常量、纯校验函数，无状态；
 *  - 本模块是围绕该协议的**状态机**——requestId 生成、挂起请求表、超时兜底、
 *    结果帧配对、ready 标志维护、窗口销毁时冲销、IPC sender 校验。
 *
 * 此前这套关联逻辑散落在 main.cjs 的四个不相邻区域，并与模块级 avatarWindow
 * 变量纠缠而无法单测。收进本模块后，Electron 侧只剩 ipcMain 与「当前角色窗」
 * 两个注入点，node:test 用 fake ipcMain + fake window 即可直测全部路径（NFR-3）。
 *
 * 失败语义（调用方据此清晰降级，MCP 工具层转 isError）：所有失败路径都
 * **resolve** 为 { ok:false, error }，从不 reject；超时额外带 timeout:true。
 */

const { randomUUID } = require('node:crypto')
const {
  COMMAND_CHANNEL,
  COMMAND_RESULT_CHANNEL,
  COMMAND_READY_CHANNEL,
  COMMAND_TIMEOUT_MS,
  normalizeCommandResultFrame,
} = require('./renderer-commands.cjs')

const ERROR_NO_WINDOW = '角色窗不存在（可能已关闭）'
const ERROR_NOT_READY = 'renderer 命令通道未挂接（页面加载中）'
const ERROR_TIMEOUT = 'renderer 命令超时'
const ERROR_WINDOW_CLOSED = '角色窗已关闭'

/**
 * 创建命令通道。构造即注册 ready / result 两个 ipcMain 监听。
 *
 * @param {object} options
 * @param {{ on: Function, removeListener: Function }} options.ipcMain Electron ipcMain
 * @param {() => (object|null)} options.getWindow 取当前角色窗（可能为 null 或已销毁）；
 *   通道只信任该窗口的 webContents，其它 sender 的帧一律忽略
 * @param {number} [options.timeoutMs] 单条命令超时（默认 COMMAND_TIMEOUT_MS）
 * @param {{ warn: Function }} [options.logger] 非法帧告警出口（默认 console）
 */
function createRendererCommandChannel({
  ipcMain,
  getWindow,
  timeoutMs = COMMAND_TIMEOUT_MS,
  logger = console,
} = {}) {
  if (!ipcMain || typeof ipcMain.on !== 'function') {
    throw new TypeError('createRendererCommandChannel: ipcMain 必填')
  }
  if (typeof getWindow !== 'function') {
    throw new TypeError('createRendererCommandChannel: getWindow 必填')
  }

  /** @type {Map<string, { resolve: (result: object) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map()
  /** renderer 侧 handler 是否已挂接（preload 注册 onCommand 后发一帧 ready） */
  let ready = false

  /** 当前可用的角色窗；不存在或已销毁返回 null */
  function liveWindow() {
    const win = getWindow()
    return win && !win.isDestroyed() ? win : null
  }

  /** 只认当前角色窗的 webContents，挡掉设置窗/残留窗口/伪造 sender */
  function isTargetSender(event) {
    const win = liveWindow()
    return Boolean(win && event?.sender === win.webContents)
  }

  /** 冲销一条挂起命令（清超时器并出表），返回其 resolve */
  function takePending(requestId) {
    const entry = pending.get(requestId)
    if (!entry) return null
    pending.delete(requestId)
    clearTimeout(entry.timer)
    return entry.resolve
  }

  /** 冲销全部挂起命令，统一以 reason 失败（不等各自超时） */
  function rejectAllPending(reason) {
    for (const requestId of [...pending.keys()]) {
      takePending(requestId)?.({ ok: false, error: reason })
    }
  }

  function onReady(event) {
    if (isTargetSender(event)) ready = true
  }

  function onResult(event, frame) {
    if (!isTargetSender(event)) return
    const normalized = normalizeCommandResultFrame(frame)
    if (!normalized) {
      logger.warn('[live2d] 非法命令结果帧，已丢弃')
      return
    }
    takePending(normalized.requestId)?.(normalized.result)
  }

  ipcMain.on(COMMAND_READY_CHANNEL, onReady)
  ipcMain.on(COMMAND_RESULT_CHANNEL, onResult)

  return {
    /**
     * 发一条命令并等待 renderer 回执。
     * @param {string} type 命令类型（白名单由 renderer-commands.cjs 定义）
     * @param {object} params 命令参数
     * @returns {Promise<{ ok: boolean, data?: unknown, error?: string, timeout?: boolean }>}
     */
    send(type, params) {
      const win = liveWindow()
      if (!win) return Promise.resolve({ ok: false, error: ERROR_NO_WINDOW })
      if (!ready) return Promise.resolve({ ok: false, error: ERROR_NOT_READY })
      return new Promise((resolve) => {
        const requestId = randomUUID()
        const timer = setTimeout(() => {
          pending.delete(requestId)
          resolve({ ok: false, error: ERROR_TIMEOUT, timeout: true })
        }, timeoutMs)
        pending.set(requestId, { resolve, timer })
        win.webContents.send(COMMAND_CHANNEL, { requestId, type, params })
      })
    },

    /** renderer handler 是否已挂接（get_status 据此如实报 unknown 而非 false） */
    isReady() {
      return ready
    },

    /** 角色窗 closed 时调用：通道失效，挂起命令立即失败而不是空等超时 */
    handleWindowClosed() {
      ready = false
      rejectAllPending(ERROR_WINDOW_CLOSED)
    },

    /** 注销 IPC 监听并冲销挂起命令（应用退出 / 测试收尾） */
    dispose() {
      ipcMain.removeListener(COMMAND_READY_CHANNEL, onReady)
      ipcMain.removeListener(COMMAND_RESULT_CHANNEL, onResult)
      ready = false
      rejectAllPending(ERROR_WINDOW_CLOSED)
    },
  }
}

module.exports = {
  ERROR_NOT_READY,
  ERROR_NO_WINDOW,
  ERROR_TIMEOUT,
  ERROR_WINDOW_CLOSED,
  createRendererCommandChannel,
}
