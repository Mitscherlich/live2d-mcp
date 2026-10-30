'use strict'

/**
 * Live2D Companion · Electron 主进程入口。
 *
 * 全部状态与编排在 companion-app.cjs 的 CompanionApp（组合根）；本文件只做：
 * flags 解析 → registerSchemesAsPrivileged（Electron 硬约束：ready 前顶层调用）→
 * 单实例锁 → new CompanionApp 并把 app 事件接线到其生命周期方法。
 *
 * 架构分层与模块图见 docs/ARCHITECTURE.md。
 */

const path = require('node:path')
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  ipcMain,
  nativeImage,
  protocol,
  screen,
  shell,
} = require('electron')
const { RENDERER_SCHEME } = require('./renderer-protocol.cjs')
const { CompanionApp, UI_CHROME_ARG, VOICE_INJECT_ARG } = require('./companion-app.cjs')

const DIST_DIR = path.join(__dirname, '..', 'renderer', 'dist')
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? ''
const isDev = DEV_SERVER_URL !== ''

// F3 测试注入：LIVE2D_VOICE_INJECT=1 或 CLI --live2d-voice-inject 开启
// （preload 经 additionalArguments 收到同名标志后才暴露 window.live2d.injectVoice）
const voiceInjectEnabled =
  process.env.LIVE2D_VOICE_INJECT === '1' || process.argv.includes(VOICE_INJECT_ARG)

// 角色窗 UI 工具条（顶栏/底栏）：Electron 默认隐藏，仅显式调试开关显示。
// 注意：LIVE2D_RENDERER_LOG 只把 console 打到终端，不强制显示工具条。
const uiChromeEnabled =
  process.env.LIVE2D_UI_CHROME === '1' ||
  process.env.LIVE2D_DEVTOOLS === '1' ||
  process.argv.includes(UI_CHROME_ARG)

// Electron 硬约束：registerSchemesAsPrivileged 必须在 app ready 之前调用，原位保留。
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

app.setName('Mayuka')

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  const companion = new CompanionApp({
    electron: {
      app,
      BrowserWindow,
      Menu,
      Tray,
      clipboard,
      ipcMain,
      nativeImage,
      screen,
      shell,
    },
    flags: {
      isDev,
      devServerUrl: DEV_SERVER_URL,
      voiceInjectEnabled,
      uiChromeEnabled,
      distDir: DIST_DIR,
    },
  })

  app.on('second-instance', () => companion.onSecondInstance())
  app.on('activate', () => companion.onActivate())
  app.on('before-quit', () => companion.onBeforeQuit())
  app.on('will-quit', () => companion.shutdown())
  app.on('window-all-closed', () => companion.onWindowAllClosed())
  void app.whenReady().then(() => companion.start())
}
