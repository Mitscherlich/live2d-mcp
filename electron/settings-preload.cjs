'use strict'

/**
 * F7 设置窗窄桥：只允许读取/保存 voice source 与复制固定 MCP 命令。
 *
 * sandbox preload 无法 require 本仓模块，下面四个 channel 是
 * electron/settings-channels.cjs（main 侧 require 复用）的内联副本。
 * 护栏：electron/test/settings-channels.test.cjs 读本文件源文本比对，
 * 任何单侧改动都会被测试捕获（改动请双侧同步）。
 */

const { contextBridge, ipcRenderer } = require('electron')

const SETTINGS_GET_CHANNEL = 'live2d:settings:get'
const SETTINGS_SAVE_CHANNEL = 'live2d:settings:save'
const SETTINGS_COPY_CHANNEL = 'live2d:settings:copy-command'
const SETTINGS_CHANGED_CHANNEL = 'live2d:settings:changed'
const SETTINGS_LIST_SOURCES_CHANNEL = 'live2d:settings:list-sources'

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
  copyCommand() {
    return ipcRenderer.invoke(SETTINGS_COPY_CHANNEL)
  },
  /** 枚举当前运行中可监听 application sources（source_id / source_name / pidCount） */
  listSources() {
    return ipcRenderer.invoke(SETTINGS_LIST_SOURCES_CHANNEL)
  },
  onChanged(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, view) => callback(view)
    ipcRenderer.on(SETTINGS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(SETTINGS_CHANGED_CHANNEL, listener)
  },
})
