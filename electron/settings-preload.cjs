'use strict'

/**
 * 设置窗窄桥（F7；docs/specs/settings-ui.md §4.2）：快捷弹窗与完整设置窗共用。
 * 只允许读取/保存 voice source、复制固定 MCP 命令、发白名单 action、
 * 订阅 view 与电平推送；action 负载的权威校验在 main（settings-actions.cjs）。
 *
 * sandbox preload 无法 require 本仓模块，下面六个 channel 是
 * electron/settings-channels.cjs（main 侧 require 复用）的内联副本。
 * 护栏：electron/test/settings-channels.test.cjs 读本文件源文本比对，
 * 任何单侧改动都会被测试捕获（改动请双侧同步）。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const SETTINGS_GET_CHANNEL = 'live2d:settings:get'
const SETTINGS_SAVE_CHANNEL = 'live2d:settings:save'
const SETTINGS_COPY_CHANNEL = 'live2d:settings:copy-command'
const SETTINGS_CHANGED_CHANNEL = 'live2d:settings:changed'
const SETTINGS_ACTION_CHANNEL = 'live2d:settings:action'
const SETTINGS_LEVEL_CHANNEL = 'live2d:settings:level'
// Model management (mirrors electron/model-channels.cjs; guarded by electron/test/model-channels.test.cjs)
const MODEL_IMPORT_CHANNEL = 'live2d:model:import'
const MODEL_PROGRESS_CHANNEL = 'live2d:model:progress'
const CORE_IMPORT_CHANNEL = 'live2d:core:import'
const MODEL_SAVE_THUMB_CHANNEL = 'live2d:model:save-thumb'

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function importFile(channel, file) {
  let filePath = ''
  try {
    filePath = webUtils.getPathForFile(file)
  } catch {
    filePath = ''
  }
  if (!filePath) return Promise.resolve({ ok: false, error: 'Cannot read the selected file' })
  return ipcRenderer.invoke(channel, filePath)
}

contextBridge.exposeInMainWorld('live2dSettings', {
  get() {
    return ipcRenderer.invoke(SETTINGS_GET_CHANNEL)
  },
  save(voiceSource) {
    if (typeof voiceSource !== 'object' || voiceSource === null || Array.isArray(voiceSource)) {
      return Promise.resolve({ ok: false, error: 'voice source 配置非法' })
    }
    return ipcRenderer.invoke(SETTINGS_SAVE_CHANNEL, voiceSource)
  },
  copyCommand(kind) {
    return ipcRenderer.invoke(SETTINGS_COPY_CHANNEL, kind)
  },
  action(payload) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return Promise.resolve({ ok: false, error: '设置 action 非法' })
    }
    return ipcRenderer.invoke(SETTINGS_ACTION_CHANNEL, payload)
  },
  /** `file` is a File from <input type=file> or a drop; its real path is resolved here, not in the page. */
  importModel(file) {
    return importFile(MODEL_IMPORT_CHANNEL, file)
  },
  importCore(file) {
    return importFile(CORE_IMPORT_CHANNEL, file)
  },
  onModelProgress(callback) {
    return subscribe(MODEL_PROGRESS_CHANNEL, callback)
  },
  saveThumbnail(id, png) {
    if (typeof id !== 'string' || !(png instanceof ArrayBuffer)) return Promise.resolve({ ok: false, error: 'Invalid thumbnail' })
    return ipcRenderer.invoke(MODEL_SAVE_THUMB_CHANNEL, { id, png })
  },
  onChanged(callback) {
    return subscribe(SETTINGS_CHANGED_CHANNEL, callback)
  },
  onLevel(callback) {
    return subscribe(SETTINGS_LEVEL_CHANNEL, callback)
  },
})
