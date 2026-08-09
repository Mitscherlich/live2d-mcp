'use strict'

/**
 * CompanionApp：Live2D Companion 主进程组合根（ADR 0001 F2–F7 + ADR 0002）。
 *
 * 此前 main.cjs 是一个被摊开成 800+ 行的隐式类：模块级可变状态散置四段、
 * 启动/关停顺序仅靠行序与注释维系。本类把全部状态收为字段、把编排收为方法：
 *  - 生命周期：start / onBeforeQuit / shutdown / onSecondInstance / onActivate /
 *    onWindowAllClosed（main.cjs 只剩 Electron 事件到方法的接线）
 *  - 子系统：SettingsStore / WindowInteractionController / RendererCommandChannel /
 *    VoiceListenerManager / BridgeService 各自持有状态，本类只做组装与转发
 *  - voice 事件投递唯一汇聚点 dispatchVoiceEvent（bridge /events、测试注入回环、
 *    native listener 三入口共用权威规范化 + IPC 路径）
 *
 * Electron 模块面由构造注入（对齐仓内 fake 直测风格）；启动/关停顺序在
 * start()/shutdown() 内显式成文。
 */

const path = require('node:path')
const fs = require('node:fs')

const { RENDERER_ORIGIN, registerRendererProtocol } = require('./renderer-protocol.cjs')
const {
  VOICE_EVENT_CHANNEL,
  VOICE_INJECT_CHANNEL,
  normalizeVoiceEvent,
} = require('./voice-events.cjs')
const { bridgeHttpUrl } = require('./bridge-endpoint.cjs')
const { BridgeService } = require('./bridge-service.cjs')
const { RendererCommandChannel } = require('./renderer-command-channel.cjs')
const { isWindowSender } = require('./protocol-utils.cjs')
const { VoiceListenerManager } = require('./voice-listener-manager.cjs')
const { DEFAULT_WINDOW_STATE } = require('./window-state.cjs')
const { SettingsStore } = require('./settings-store.cjs')
const { buildSettingsViewModel } = require('./settings-view.cjs')
const {
  SETTINGS_GET_CHANNEL,
  SETTINGS_SAVE_CHANNEL,
  SETTINGS_COPY_CHANNEL,
  SETTINGS_CHANGED_CHANNEL,
} = require('./settings-channels.cjs')
const { TrayController, shouldQuitAfterAllWindowsClosed } = require('./tray.cjs')
const { WindowInteractionController } = require('./window-interactions.cjs')

const WINDOW_WIDTH = DEFAULT_WINDOW_STATE.width
const WINDOW_HEIGHT = DEFAULT_WINDOW_STATE.height
const WINDOW_MARGIN = 24
const SETTINGS_WIDTH = 560
const SETTINGS_HEIGHT = 700

// 测试注入与 UI chrome 的 argv 标志（preload 经 additionalArguments 检测同名标志；
// 字面量与 preload.cjs 内联副本保持一致，改动需同步）
const VOICE_INJECT_ARG = '--live2d-voice-inject'
const UI_CHROME_ARG = '--live2d-ui-chrome'

class CompanionApp {
  /**
   * @param {object} options
   * @param {object} options.electron Electron 模块面
   *   { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, screen }
   * @param {object} options.flags 启动 flags
   *   { isDev, devServerUrl, voiceInjectEnabled, uiChromeEnabled, distDir }
   * @param {object} [options.logger] 日志出口（默认 console）
   */
  constructor({ electron, flags, logger = console } = {}) {
    this._app = electron.app
    this._BrowserWindow = electron.BrowserWindow
    this._Menu = electron.Menu
    this._Tray = electron.Tray
    this._clipboard = electron.clipboard
    this._ipcMain = electron.ipcMain
    this._nativeImage = electron.nativeImage
    this._screen = electron.screen

    this._isDev = flags.isDev
    this._devServerUrl = flags.devServerUrl
    this._voiceInjectEnabled = flags.voiceInjectEnabled
    this._uiChromeEnabled = flags.uiChromeEnabled
    this._distDir = flags.distDir
    this._logger = logger

    this._avatarWindow = null
    this._settingsWindow = null
    this._tray = null
    this._isQuitting = false
    this._settingsStore = null
    this._interactions = null
    this._commands = null
    this._voice = null
    this._bridge = null
  }

  // ------------------------------------------------------------ 生命周期

  /** app.whenReady 主体：子系统初始化 → IPC → 托盘 → 窗口 → voice → bridge（顺序显式） */
  async start() {
    if (!this._isDev) {
      if (!fs.existsSync(path.join(this._distDir, 'index.html'))) {
        this._logger.error('[live2d] 未找到 renderer/dist/index.html，请先运行 bun run build 再 bun start')
        this._app.exit(1)
        return
      }
      registerRendererProtocol(this._distDir)
    }

    // 窗口交互控制器（需要在 app ready 后，因为依赖 screen 模块）
    this._interactions = new WindowInteractionController({
      ipcMain: this._ipcMain,
      screen: this._screen,
      getWindow: () => this._avatarWindow,
      openSettings: () => this.openSettingsWindow(),
      onWindowStateChange: (state) => this.persistWindowState(state),
    })

    // 渲染器命令通道
    this._commands = new RendererCommandChannel({
      ipcMain: this._ipcMain,
      getWindow: () => this._avatarWindow,
    })

    this._settingsStore = new SettingsStore({
      filePath: path.join(this._app.getPath('userData'), 'settings.json'),
    })
    const { warnings: settingsWarnings } = this._settingsStore.load()
    this._interactions.setWindowScale(this._settingsStore.current.window.scale, { notify: false })
    for (const warning of settingsWarnings) this._logger.warn(`[live2d] ${warning}`)

    this._voice = new VoiceListenerManager({
      platform: process.platform,
      isPackaged: this._app.isPackaged,
      resourcesPath: process.resourcesPath,
      environment: process.env,
      onVoiceEvent: (event) => this.dispatchVoiceEvent(event),
      onStatusChanged: () => this.notifySettingsChanged(),
    })

    this._bridge = new BridgeService({
      onEvent: (event) => this.dispatchVoiceEvent(event),
      getHealthExtra: () => this.bridgeHealthExtra(),
      onListening: () => this.notifySettingsChanged(),
    })

    this._logger.log(`[live2d] 启动模式: ${this._isDev ? `dev（${this._devServerUrl}）` : 'prod（renderer/dist）'}`)
    if (this._voiceInjectEnabled) {
      this._logger.log('[live2d] voice 测试注入已开启（LIVE2D_VOICE_INJECT=1）：renderer 可经 window.live2d.injectVoice 注入 state/audio-level')
    }
    // 模型路径唯一事实：renderer/src/live2d-app.ts 的 MODEL_PATH
    this._logger.log('[live2d] 模型资源: Cubism 4 模型与 live2dcubismcore.min.js 放入 renderer/public/（详见 README）；缺模型时窗口内显示引导而不会崩溃')

    this._registerIpcHandlers()
    this._createTray()
    this._createAvatarWindow()
    this._voice.start(this._settingsStore.current.voiceSource)
    void this._bridge.start(this._buildMcpController())
  }

  onBeforeQuit() {
    this._isQuitting = true
    this.persistWindowState()
  }

  /** will-quit：按依赖反序拆除子系统（voice → interactions → commands → tray → bridge） */
  shutdown() {
    this._voice?.stop()
    this._voice = null
    this._interactions?.dispose()
    this._commands?.dispose()
    if (this._tray && !this._tray.isDestroyed()) this._tray.destroy()
    this._tray = null
    if (this._bridge) {
      const bridge = this._bridge
      this._bridge = null
      void bridge.close().catch(() => {})
    }
  }

  onSecondInstance() {
    this.showAvatarWindow()
  }

  onActivate() {
    this.showAvatarWindow()
  }

  onWindowAllClosed() {
    if (shouldQuitAfterAllWindowsClosed(this._tray)) this._app.quit()
  }

  // --------------------------------------------------------- voice 事件投递

  /**
   * voice 事件投递唯一汇聚点（bridge /events、测试注入回环、native listener
   * 三入口共用）。负载先过权威规范化（electron/voice-events.cjs），非法输入
   * 丢弃并告警。
   * @returns {boolean} 是否成功投递
   */
  dispatchVoiceEvent(raw) {
    return this._sendVoiceEventTo(this._avatarWindow, raw)
  }

  _sendVoiceEventTo(win, raw) {
    const event = normalizeVoiceEvent(raw)
    if (!event) {
      this._logger.warn('[live2d] voice 事件非法，已丢弃:', JSON.stringify(raw)?.slice(0, 200))
      return false
    }
    if (!win || win.isDestroyed()) return false
    win.webContents.send(VOICE_EVENT_CHANNEL, event)
    return true
  }

  // ------------------------------------------------------------- 角色窗

  _positionWindow(win) {
    const display = this._screen.getDisplayNearestPoint(this._screen.getCursorScreenPoint())
    const bounds = win.getBounds()
    win.setPosition(
      Math.round(display.workArea.x + display.workArea.width - bounds.width - WINDOW_MARGIN),
      Math.round(display.workArea.y + display.workArea.height - bounds.height - WINDOW_MARGIN),
      false,
    )
  }

  _rendererUrl() {
    const base = this._isDev ? this._devServerUrl || 'http://127.0.0.1:5173/' : `${RENDERER_ORIGIN}/`
    if (!this._uiChromeEnabled) return base
    try {
      const url = new URL(base)
      url.searchParams.set('debug', '1')
      return url.href
    } catch {
      return base
    }
  }

  /** 禁止弹新窗；导航仅允许停留在 renderer 自身源内（对齐 persona secureRendererWindow 思路） */
  _secureRendererWindow(win, allowedOrigin) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, targetUrl) => {
      let origin = null
      try {
        origin = new URL(targetUrl).origin
      } catch {
        origin = null
      }
      if (origin !== allowedOrigin) event.preventDefault()
    })
  }

  _createAvatarWindow() {
    if (this._avatarWindow && !this._avatarWindow.isDestroyed()) return this._avatarWindow

    const url = this._rendererUrl()
    const savedWindow = this._settingsStore.current.window ?? DEFAULT_WINDOW_STATE
    const win = new this._BrowserWindow({
      width: savedWindow.width,
      height: savedWindow.height,
      minWidth: 360,
      minHeight: 480,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      autoHideMenuBar: true,
      alwaysOnTop: true,
      title: 'Live2D Companion',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 标志透传：injectVoice / UI chrome（preload 检测 argv）
        additionalArguments: [
          ...(this._voiceInjectEnabled ? [VOICE_INJECT_ARG] : []),
          ...(this._uiChromeEnabled ? [UI_CHROME_ARG] : []),
        ],
      },
    })
    this._avatarWindow = win
    const restoredWindow = this._interactions.restoreWindowState(win, savedWindow)
    this._interactions.startGlobalMouseTracking(win)
    const persist = () => this.persistWindowState()
    win.on('move', persist)
    win.on('resize', persist)

    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      if (!restoredWindow.positionRestored) this._positionWindow(win)
      this._interactions.syncWindowScale(win)
      this.persistWindowState()
      win.show()
      this._logger.log(`[live2d] 角色窗已显示（${this._isDev ? 'dev' : 'prod'}: ${url}）`)
    })
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      this._logger.error(`[live2d] renderer 加载失败: ${errorCode} ${errorDescription}（${url}）`)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this._logger.error(`[live2d] renderer 进程退出: ${details.reason}`)
    })
    win.on('close', (event) => {
      if (this._isQuitting || shouldQuitAfterAllWindowsClosed(this._tray)) return
      event.preventDefault()
      win.hide()
    })
    // 冒烟/排障用：LIVE2D_RENDERER_LOG=1 时把 renderer console 汇入终端
    if (process.env.LIVE2D_RENDERER_LOG === '1') {
      win.webContents.on('console-message', ({ message }) => {
        if (message) this._logger.log(`[renderer] ${message}`)
      })
    }
    win.on('closed', () => {
      if (this._avatarWindow === win) this._avatarWindow = null
      // 窗口销毁 → 命令通道失效；挂起中的命令立即失败（不等超时）
      this._commands.handleWindowClosed()
    })

    let allowedOrigin = RENDERER_ORIGIN
    try {
      allowedOrigin = new URL(url).origin
    } catch {
      // 保底：非法 dev URL 会在 loadURL 时报 did-fail-load
    }
    this._secureRendererWindow(win, allowedOrigin)

    if (this._isDev && process.env.LIVE2D_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }

    void win.loadURL(url)
    return win
  }

  /**
   * 「把角色窗露出来」的唯一机制：托盘菜单/托盘点击、macOS dock activate、
   * 第二实例唤起、MCP control_window 全部收敛到这里，避免各处自写一套。
   * @returns {object} 已显示的角色窗
   */
  showAvatarWindow() {
    const win = this._createAvatarWindow()
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    return win
  }

  /** 隐藏角色窗（与 showAvatarWindow 成对；只隐藏，不退出应用、不销毁窗口） */
  hideAvatarWindow() {
    if (this._avatarWindow && !this._avatarWindow.isDestroyed()) this._avatarWindow.hide()
  }

  /** 托盘「重置窗口位置」：恢复右下角默认 bounds 与 100% 缩放并写回设置。 */
  resetAvatarWindow() {
    const win = this._createAvatarWindow()
    if (win.isDestroyed()) return null
    win.setSize(WINDOW_WIDTH, WINDOW_HEIGHT, false)
    this._interactions.setWindowScale(DEFAULT_WINDOW_STATE.scale, { notifyRenderer: true })
    this._positionWindow(win)
    this.persistWindowState()
    return win
  }

  /** 角色窗当前是否可见（/health 与 MCP get_status 共用，避免两处各写一份判断） */
  avatarWindowVisible() {
    return Boolean(
      this._avatarWindow && !this._avatarWindow.isDestroyed() && this._avatarWindow.isVisible(),
    )
  }

  // ------------------------------------------------------------- 设置窗

  openSettingsWindow() {
    if (this._settingsWindow && !this._settingsWindow.isDestroyed()) {
      this._settingsWindow.show()
      this._settingsWindow.focus()
      this.notifySettingsChanged()
      return this._settingsWindow
    }

    const win = new this._BrowserWindow({
      width: SETTINGS_WIDTH,
      height: SETTINGS_HEIGHT,
      minWidth: 500,
      minHeight: 620,
      show: false,
      title: 'Live2D Companion 设置',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this._settingsWindow = win
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show()
    })
    win.on('closed', () => {
      if (this._settingsWindow === win) this._settingsWindow = null
    })
    void win.loadFile(path.join(__dirname, 'settings.html'))
    return win
  }

  settingsViewModel(message = '') {
    return {
      ...buildSettingsViewModel({
        actualPort: this._bridge?.port ?? null,
        environment: process.env,
        voiceSource: this._settingsStore.current.voiceSource,
        listener: this._voice.summary(),
        environmentOverridesVoice: this._voice.config.environmentOverridesVoice,
      }),
      effectiveVoiceSource: { ...this._voice.config.source },
      message,
    }
  }

  notifySettingsChanged(message = '') {
    if (!this._settingsWindow || this._settingsWindow.isDestroyed()) return
    this._settingsWindow.webContents.send(SETTINGS_CHANGED_CHANNEL, this.settingsViewModel(message))
  }

  _applyPersistedVoiceSource(message = '设置已保存，voice listener 已热更新。') {
    this._voice.applyPersisted(this._settingsStore.current.voiceSource)
    const effectiveMessage = this._voice.config.environmentOverridesVoice
      ? '设置已保存；LIVE2D_* 环境变量仍优先，移除覆盖并重启后才会采用该值。'
      : message
    this.notifySettingsChanged(effectiveMessage)
    return effectiveMessage
  }

  // --------------------------------------------------------------- 托盘

  _createTray() {
    if (this._tray && !this._tray.isDestroyed()) return this._tray
    this._tray = new TrayController({
      Tray: this._Tray,
      Menu: this._Menu,
      nativeImage: this._nativeImage,
      platform: process.platform,
      actions: {
        showAvatar: () => this.showAvatarWindow(),
        hideAvatar: () => this.hideAvatarWindow(),
        resetAvatar: () => this.resetAvatarWindow(),
        openSettings: () => this.openSettingsWindow(),
        quitApp: () => {
          this._isQuitting = true
          this._app.quit()
        },
      },
    })
    return this._tray
  }

  // ------------------------------------------------------------ IPC 注册

  /**
   * 主进程 IPC 注册的单一入口，由 start() 调用，使注册时机显式。
   * 命令通道的两个监听不在此处——它们随 RendererCommandChannel 创建时自注册。
   */
  _registerIpcHandlers() {
    this._interactions.register()

    this._ipcMain.handle(SETTINGS_GET_CHANNEL, (event) => {
      if (!isWindowSender(event, this._settingsWindow)) throw new Error('settings IPC sender 非法')
      return this.settingsViewModel()
    })

    this._ipcMain.handle(SETTINGS_SAVE_CHANNEL, (event, voiceSource) => {
      if (!isWindowSender(event, this._settingsWindow)) {
        return { ok: false, error: 'settings IPC sender 非法' }
      }
      try {
        this._settingsStore.saveVoiceSource(voiceSource)
        const message = this._applyPersistedVoiceSource()
        return { ok: true, view: this.settingsViewModel(message) }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          view: this.settingsViewModel(),
        }
      }
    })

    this._ipcMain.handle(SETTINGS_COPY_CHANNEL, (event) => {
      if (!isWindowSender(event, this._settingsWindow)) return false
      this._clipboard.writeText(this.settingsViewModel().codexCommand)
      return true
    })

    // F3 测试注入回环：renderer 调 window.live2d.injectVoice → 本监听 → 规范化 →
    // 经 'live2d:voice' 送回同一 renderer（与 /events 真实推送走完全相同的 renderer 路径）。
    // 未开 inject 标志时不注册，生产路径无注入面。
    if (this._voiceInjectEnabled) {
      this._ipcMain.on(VOICE_INJECT_CHANNEL, (event, raw) => {
        const win = this._BrowserWindow.fromWebContents(event.sender) ?? this._avatarWindow
        this._sendVoiceEventTo(win, raw)
      })
    }
  }

  // ---------------------------------------------------------- 窗口状态持久化

  persistWindowState(state = this._currentAvatarWindowState()) {
    if (!this._settingsStore || !state) return
    try {
      this._settingsStore.saveWindowState(state)
    } catch (error) {
      this._logger.error(`[live2d] 窗口状态保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  _currentAvatarWindowState() {
    if (!this._avatarWindow || this._avatarWindow.isDestroyed()) return null
    if (!this._interactions) return null
    return this._interactions.getWindowState(this._avatarWindow)
  }

  // ---------------------------------------------------------- MCP 工具适配

  /** MCP 工具回调统一经此发命令；失败一律 resolve 为 { ok:false, error } 供清晰降级 */
  _sendRendererCommand(type, params) {
    if (!this._commands) {
      return Promise.resolve({ ok: false, error: '命令通道未初始化' })
    }
    return this._commands.send(type, params)
  }

  /**
   * control_window 的 MCP 适配层：把 show/hide/toggle 翻译成 showAvatarWindow /
   * hideAvatarWindow，并按工具契约返回「操作后角色窗是否可见」。
   */
  windowAction(action) {
    if (action === 'hide' || (action === 'toggle' && this.avatarWindowVisible())) {
      this.hideAvatarWindow()
      return false
    }
    if (action === 'show' || action === 'toggle') {
      this.showAvatarWindow()
      return true
    }
    return this.avatarWindowVisible()
  }

  /**
   * get_status 的模型摘要：renderer 命令通道未挂接 → ready:null（unknown，如实）；
   * 往返成功 → ready:true + 计数摘要；模型未加载 → ready:false + 清晰错误。
   */
  async modelStatusSummary() {
    if (!this._commands.isReady()) return { ready: null, note: 'renderer 命令通道未挂接' }
    const result = await this._sendRendererCommand('getModelInfo', {})
    if (result.ok) {
      const info = result.data ?? {}
      return {
        ready: true,
        expressions: Array.isArray(info.expressions) ? info.expressions.length : 0,
        motionGroups: Object.keys(info.motionGroups ?? {}).length,
        parameters: Array.isArray(info.parameters) ? info.parameters.length : 0,
      }
    }
    if (result.timeout) return { ready: null, note: 'renderer 未响应' }
    return { ready: false, error: result.error }
  }

  /** MCP get_status 聚合（不含用户内容；voice 摘要与 /health 同源） */
  async mcpStatus() {
    const port = this._bridge?.port ?? null
    return {
      windowVisible: this.avatarWindowVisible(),
      bridge: {
        port,
        url: port === null ? null : bridgeHttpUrl(port),
      },
      voice: this._bridge?.voiceSummary ?? null,
      listener: this._voice.summary(),
      mcp: this._bridge.endpointSummary(),
      model: await this.modelStatusSummary(),
    }
  }

  /** /health 附加字段（尽力而为，不含用户内容） */
  bridgeHealthExtra() {
    return {
      // /health 不做 renderer 往返；模型真实状态走 MCP get_status（F5）
      windowVisible: this.avatarWindowVisible(),
      voiceInject: this._voiceInjectEnabled,
      listener: this._voice.summary(),
      mcp: this._bridge.endpointSummary(),
    }
  }

  /** MCP controller：窗口控制 main 自完成；视觉命令经命令通道转发 renderer */
  _buildMcpController() {
    return {
      onWindowAction: (action) => this.windowAction(action),
      getStatus: () => this.mcpStatus(),
      getModelInfo: () => this._sendRendererCommand('getModelInfo', {}),
      onExpression: (expression) => this._sendRendererCommand('setExpression', { expression }),
      onMotion: ({ group, index, priority }) =>
        this._sendRendererCommand('playMotion', { group, index, priority }),
      onLookAt: ({ x, y }) => this._sendRendererCommand('lookAt', { x, y }),
      onParameter: ({ param_id, value }) =>
        this._sendRendererCommand('setParameter', { param_id, value }),
      onReset: () => this._sendRendererCommand('reset', {}),
    }
  }
}

module.exports = { CompanionApp, UI_CHROME_ARG, VOICE_INJECT_ARG }
