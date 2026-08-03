'use strict'

/**
 * 沙箱 preload（ADR 0001 · F2 起；F3 扩展 voice 通道）
 *
 * 暴露 window.live2d 窄 API：
 *  - isElectron / platform / versions：只读运行环境信息（F2）
 *  - onVoiceEvent(cb)：订阅 main 推送的规范化 voice 事件（state / audio-level）。
 *    F3 测试注入与 F4 bridge /events 共用该 IPC 通道（'live2d:voice'）。
 *  - injectVoice(payload)：**仅测试注入**。仅当 main 以 LIVE2D_VOICE_INJECT=1
 *    （或 --live2d-voice-inject）启动、经 additionalArguments 传入标志时暴露。
 *    实现为 ipcRenderer.send('live2d:voice-inject') → main 规范化后回环到
 *    'live2d:voice'，即注入与真实推送走完全相同的 renderer 路径。
 *
 * 安全边界（NFR-2）：不暴露 Node/fs/任意 IPC；voice 负载在此做浅校验
 * （type 白名单 + 字段形状），权威规范化在 main（electron/voice-events.cjs）。
 */

const { contextBridge, ipcRenderer } = require('electron')

const VOICE_EVENT_CHANNEL = 'live2d:voice'
const VOICE_INJECT_CHANNEL = 'live2d:voice-inject'
const VOICE_INJECT_ARG = '--live2d-voice-inject'

const VALID_EVENT_TYPES = new Set(['state', 'audio-level'])
const injectEnabled = process.argv.includes(VOICE_INJECT_ARG)

/** 浅校验：仅放行可识别的 voice 事件形状（钳制/枚举校验由 main 权威执行） */
function isVoiceEventShape(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  if (!VALID_EVENT_TYPES.has(raw.type)) return false
  if (raw.type === 'audio-level') return typeof raw.level === 'number'
  return typeof raw.state === 'object' && raw.state !== null
}

const api = {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
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
