'use strict'

/**
 * 设置窗 IPC 通道常量（ADR 0001 · F7）
 *
 * main（electron/main.cjs 注册 ipcMain.handle / webContents.send）与设置窗
 * preload（electron/settings-preload.cjs 调 invoke / on）必须用同一组通道名，
 * 名字漂移会让设置窗静默失效（invoke 无 handler 而 reject、changed 推送无人收）。
 *
 * main 直接 require 本模块；settings-preload.cjs 是 sandbox preload，
 * 无法 require 本仓模块，只能内联同名字面量——两侧一致性由
 * electron/test/settings-channels.test.cjs 读源文本比对护栏。
 *
 * 纯常量、无 Electron 依赖：node:test 可直接 require（NFR-3）。
 */

const SETTINGS_GET_CHANNEL = 'live2d:settings:get'
const SETTINGS_SAVE_CHANNEL = 'live2d:settings:save'
const SETTINGS_COPY_CHANNEL = 'live2d:settings:copy-command'
const SETTINGS_CHANGED_CHANNEL = 'live2d:settings:changed'

module.exports = {
  SETTINGS_GET_CHANNEL,
  SETTINGS_SAVE_CHANNEL,
  SETTINGS_COPY_CHANNEL,
  SETTINGS_CHANGED_CHANNEL,
}
