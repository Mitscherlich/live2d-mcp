'use strict'

/**
 * 沙箱 preload（ADR 0001 · F2 起；F3 voice 通道；F5 命令通道）
 *
 * 暴露 window.live2d 窄 API：
 *  - isElectron / platform / versions：只读运行环境信息（F2）
 *  - onVoiceEvent(cb)：订阅 main 推送的规范化 voice 事件（state / audio-level）。
 *    F3 测试注入与 F4 bridge /events 共用该 IPC 通道（'live2d:voice'）。
 *  - onCommand(handler)：注册 main → renderer 命令处理器（F5，MCP 视觉工具执行路径）。
 *    帧形状浅校验（requestId + type 白名单 + params 对象）后调用 handler，
 *    结果（含异常兜底）经 'live2d:command-result' 回传 main；注册即发 ready 帧。
 *  - injectVoice(payload)：**仅测试注入**。仅当 main 以 LIVE2D_VOICE_INJECT=1
 *    （或 --live2d-voice-inject）启动、经 additionalArguments 传入标志时暴露。
 *
 * 安全边界（NFR-2）：不暴露 Node/fs/任意 IPC；voice/命令负载在此做浅校验
 * （白名单 + 形状），权威校验分别在 main（voice-events.cjs）与 MCP 层（zod）。
 * 注意：sandbox preload 不能 require 本仓模块（只拿得到 electron/events/timers/url），
 * 下面的 channel 常量与命令/事件白名单是 electron/renderer-commands.cjs 与
 * electron/voice-events.cjs 的内联副本。这两份副本有护栏：
 * electron/test/renderer-commands.test.cjs 与 electron/test/voice-events.test.cjs
 * 会读本文件源文本比对，任何单侧改动都会被测试捕获（改动请双侧同步）。
 */

const { contextBridge, ipcRenderer } = require('electron')

const VOICE_EVENT_CHANNEL = 'live2d:voice'
const VOICE_INJECT_CHANNEL = 'live2d:voice-inject'
const VOICE_INJECT_ARG = '--live2d-voice-inject'
// 与 electron/renderer-commands.cjs 保持一致（sandbox 限制无法 require）
// 护栏：electron/test/renderer-commands.test.cjs 读本文件源文本比对，改动会被测试捕获
const COMMAND_CHANNEL = 'live2d:command'
const COMMAND_RESULT_CHANNEL = 'live2d:command-result'
const COMMAND_READY_CHANNEL = 'live2d:command-ready'
// ADR 0002 · S1 窗口交互（sandbox preload 不能 require 本仓模块，测试校验两侧一致）
const MOVE_WINDOW_CHANNEL = 'live2d:move-window'
const GET_WINDOW_BOUNDS_CHANNEL = 'live2d:get-window-bounds'
const GET_WINDOW_SCALE_CHANNEL = 'live2d:get-window-scale'
const SET_WINDOW_SCALE_CHANNEL = 'live2d:set-window-scale'
const GLOBAL_MOUSE_MOVE_CHANNEL = 'live2d:global-mouse-move'
const SET_SCALE_EVENT_CHANNEL = 'live2d:set-scale'
const SET_MOUSE_IGNORE_CHANNEL = 'live2d:set-mouse-ignore'
const OPEN_SETTINGS_CHANNEL = 'live2d:open-settings'
const COMMAND_TYPES = new Set([
  'getModelInfo',
  'setExpression',
  'playMotion',
  'lookAt',
  'setParameter',
  'reset',
])

// 与 electron/voice-events.cjs 的 normalizeVoiceEvent 接受面一致（sandbox 限制无法 require）
// 护栏：electron/test/voice-events.test.cjs 读本文件源文本比对，改动会被测试捕获
const VALID_EVENT_TYPES = new Set(['state', 'audio-level'])
const injectEnabled = process.argv.includes(VOICE_INJECT_ARG)
// 调试工具条：main 以 LIVE2D_UI_CHROME / LIVE2D_DEVTOOLS / --live2d-ui-chrome 启动时透传
// （LIVE2D_RENDERER_LOG 不打开工具条，只打终端日志）
const UI_CHROME_ARG = '--live2d-ui-chrome'
const uiChromeEnabled = process.argv.includes(UI_CHROME_ARG)

/** 浅校验：仅放行可识别的 voice 事件形状（钳制/枚举校验由 main 权威执行） */
function isVoiceEventShape(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  if (!VALID_EVENT_TYPES.has(raw.type)) return false
  if (raw.type === 'audio-level') return typeof raw.level === 'number'
  return typeof raw.state === 'object' && raw.state !== null
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 浅校验：main → renderer 命令帧（requestId + type 白名单 + params 对象） */
function isCommandFrameShape(raw) {
  return (
    isPlainObject(raw) &&
    typeof raw.requestId === 'string' &&
    raw.requestId.length > 0 &&
    raw.requestId.length <= 64 &&
    COMMAND_TYPES.has(raw.type) &&
    isPlainObject(raw.params)
  )
}

const api = {
  isElectron: true,
  platform: process.platform,
  /** true 时 renderer 显示顶部状态栏 + 底部调试条（仅调试） */
  uiChrome: uiChromeEnabled,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  async moveWindow(deltaX, deltaY) {
    if (!isFiniteNumber(deltaX) || !isFiniteNumber(deltaY)) {
      throw new TypeError('窗口移动增量必须是有限数')
    }
    return ipcRenderer.invoke(MOVE_WINDOW_CHANNEL, { deltaX, deltaY })
  },

  getWindowBounds() {
    return ipcRenderer.invoke(GET_WINDOW_BOUNDS_CHANNEL)
  },

  getWindowScale() {
    return ipcRenderer.invoke(GET_WINDOW_SCALE_CHANNEL)
  },

  async setWindowScale(scale) {
    if (!isFiniteNumber(scale)) throw new TypeError('窗口缩放值必须是有限数')
    return ipcRenderer.invoke(SET_WINDOW_SCALE_CHANNEL, scale)
  },

  async setMouseIgnore(ignore) {
    if (typeof ignore !== 'boolean') throw new TypeError('窗口穿透参数必须是布尔值')
    return ipcRenderer.invoke(SET_MOUSE_IGNORE_CHANNEL, { ignore })
  },

  openSettings() {
    return ipcRenderer.invoke(OPEN_SETTINGS_CHANNEL)
  },

  onGlobalMouseMove(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, point) => {
      if (isPlainObject(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y)) {
        callback(point.x, point.y)
      }
    }
    ipcRenderer.on(GLOBAL_MOUSE_MOVE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(GLOBAL_MOUSE_MOVE_CHANNEL, listener)
  },

  onSetScale(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, scale) => {
      if (isFiniteNumber(scale) && scale >= 0.5 && scale <= 1.75) callback(scale)
    }
    ipcRenderer.on(SET_SCALE_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(SET_SCALE_EVENT_CHANNEL, listener)
  },

  /**
   * 订阅 main 推送的规范化 voice 事件；返回取消订阅函数。
   * 负载形状非法的帧被丢弃（不抛给 renderer）。
   */
  onVoiceEvent(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => {
      if (isVoiceEventShape(payload)) callback(payload)
    }
    ipcRenderer.on(VOICE_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(VOICE_EVENT_CHANNEL, listener)
    }
  },

  /**
   * 注册 main → renderer 命令处理器（F5 MCP 工具执行路径；仅 Electron 一体化）。
   * handler({ type, params }) 可同步或返回 Promise，约定产出 { ok, data?, error? }；
   * handler 抛异常在此兜底为 { ok:false, error }，结果统一回传 main。
   * 返回取消注册函数。
   */
  onCommand(handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, frame) => {
      if (!isCommandFrameShape(frame)) return
      Promise.resolve()
        .then(() => handler({ type: frame.type, params: frame.params }))
        .then(
          (result) => {
            if (isPlainObject(result) && typeof result.ok === 'boolean') return result
            return { ok: false, error: 'renderer 命令处理器返回非法结果' }
          },
          (error) => ({ ok: false, error: String(error?.message ?? error).slice(0, 500) }),
        )
        .then((result) => {
          ipcRenderer.send(COMMAND_RESULT_CHANNEL, { requestId: frame.requestId, result })
        })
    }
    ipcRenderer.on(COMMAND_CHANNEL, listener)
    ipcRenderer.send(COMMAND_READY_CHANNEL)
    return () => {
      ipcRenderer.removeListener(COMMAND_CHANNEL, listener)
    }
  },
}

// 仅测试注入通道：main 未开 inject 标志时 renderer 侧 window.live2d.injectVoice
// 为 undefined（功能缺席而非报错），避免生产路径残留注入面。
if (injectEnabled) {
  api.injectVoice = (payload) => {
    if (!isVoiceEventShape(payload)) return false
    ipcRenderer.send(VOICE_INJECT_CHANNEL, payload)
    return true
  }
}

contextBridge.exposeInMainWorld('live2d', api)
