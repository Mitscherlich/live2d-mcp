'use strict'

/**
 * Live2D Companion · Electron 主进程（ADR 0001 · F2–F7）
 *
 * F7 新增职责：
 *  - 系统托盘提供显示/隐藏角色窗、打开设置与退出；关闭角色窗改为隐藏，托盘保活；
 *  - userData/settings.json 持久化 voice source，写入复用 F6 sanitize；
 *  - 最小设置窗展示实际 MCP URL / codex 命令并热更新 listener。
 *
 * F6 新增职责：
 *  - 从 LIVE2D_* 环境变量解析 automatic/application/custom/external voice source；
 *  - macOS 非 external 模式启动 native process-audio listener，把 session/activity/level
 *    回调转成与 /events 相同的 sendVoiceEvent 路径；退出时停止 listener；
 *  - /health 与 MCP get_status 共享真实 listener 摘要，helper/权限失败清晰降级。
 *
 * F5 既有职责：
 *  - 在 bridge 同端口挂载 Streamable HTTP MCP（/mcp，electron/mcp-server.cjs）：
 *    get_status / control_window / get_model_info / set_expression / play_motion
 *    （+ 低成本保留 look_at / set_parameter / reset）；**无 speak/TTS 工具**；
 *  - main ↔ renderer 命令通道（electron/renderer-commands.cjs 帧协议）：
 *    MCP 视觉工具经 'live2d:command' 请求-响应转发 renderer 执行，
 *    renderer 未挂接/无模型时返回清晰错误，不崩溃；
 *  - /health 的 mcp 字段标记 implemented:true 并给出实际 URL。
 *
 * F3/F4 既有职责：
 *  - sendVoiceEvent(win, raw)：规范化后经 'live2d:voice' 推送 voice 事件到 renderer；
 *  - 测试注入：LIVE2D_VOICE_INJECT=1（或 --live2d-voice-inject）启动时，
 *    经 additionalArguments 让 preload 暴露 window.live2d.injectVoice，
 *    并注册 ipcMain 'live2d:voice-inject' 回环（renderer 注入 → 规范化 →
 *    与真实推送完全同路径送回 renderer）；
 *  - loopback bridge（默认 127.0.0.1:47832，LIVE2D_BRIDGE_PORT 覆盖端口）：
 *    GET /health、POST /events（onEvent 即 sendVoiceEvent，与注入同路径）。
 *
 * 窗口/preload 模式参考 persona（只读，MIT），未复制其 VRM/资产逻辑。
 */

const path = require('node:path')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
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
} = require('electron')
const {
  RENDERER_SCHEME,
  RENDERER_ORIGIN,
  registerRendererProtocol,
} = require('./renderer-protocol.cjs')
const {
  VOICE_EVENT_CHANNEL,
  VOICE_INJECT_CHANNEL,
  normalizeVoiceEvent,
} = require('./voice-events.cjs')
const {
  DEFAULT_PORT: BRIDGE_DEFAULT_PORT,
  LOOPBACK_HOST: BRIDGE_HOST,
  createBridgeServer,
  resolveBridgePort,
} = require('./bridge-server.cjs')
const {
  COMMAND_CHANNEL,
  COMMAND_RESULT_CHANNEL,
  COMMAND_READY_CHANNEL,
  COMMAND_TIMEOUT_MS,
  normalizeCommandResultFrame,
} = require('./renderer-commands.cjs')
const { MCP_PATH, createLive2dMcpHandler } = require('./mcp-server.cjs')
const { resolveVoiceSourceConfig } = require('./voice-source.cjs')
const { createAudioListener } = require('./audio-listener.cjs')
const { buildListenerSummary } = require('./listener-status.cjs')
const { createSettingsStore, defaultSettings } = require('./settings-store.cjs')
const { buildSettingsViewModel } = require('./settings-view.cjs')
const {
  createTrayController,
  shouldQuitAfterAllWindowsClosed,
} = require('./tray.cjs')

const WINDOW_WIDTH = 600
const WINDOW_HEIGHT = 640
const WINDOW_MARGIN = 24
const SETTINGS_WIDTH = 560
const SETTINGS_HEIGHT = 700

const SETTINGS_GET_CHANNEL = 'live2d:settings:get'
const SETTINGS_SAVE_CHANNEL = 'live2d:settings:save'
const SETTINGS_COPY_CHANNEL = 'live2d:settings:copy-command'
const SETTINGS_CHANGED_CHANNEL = 'live2d:settings:changed'

const DIST_DIR = path.join(__dirname, '..', 'renderer', 'dist')
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? ''
const isDev = DEV_SERVER_URL !== ''

// 与 renderer/src/live2d-app.ts 的 MODEL_PATH 常量对应（F2 保留该常量）
const MODEL_ENTRY_HINT = '/model/HiyoriPro/hiyori_pro_t11.model3.json'

// F3 测试注入：LIVE2D_VOICE_INJECT=1 或 CLI --live2d-voice-inject 开启
// （preload 经 additionalArguments 收到同名标志后才暴露 window.live2d.injectVoice）
const VOICE_INJECT_ARG = '--live2d-voice-inject'
const voiceInjectEnabled =
  process.env.LIVE2D_VOICE_INJECT === '1' || process.argv.includes(VOICE_INJECT_ARG)

/**
 * 向 renderer 推送一条 voice 事件（F4 bridge /events 的 onEvent 即调用本函数；
 * F3 注入回环亦同）。负载先过权威规范化（electron/voice-events.cjs），
 * 非法输入丢弃并告警。
 * @returns {boolean} 是否成功投递
 */
function sendVoiceEvent(win, raw) {
  const event = normalizeVoiceEvent(raw)
  if (!event) {
    console.warn('[live2d] voice 事件非法，已丢弃:', JSON.stringify(raw)?.slice(0, 200))
    return false
  }
  if (!win || win.isDestroyed()) return false
  win.webContents.send(VOICE_EVENT_CHANNEL, event)
  return true
}

// F3 测试注入回环：renderer 调 window.live2d.injectVoice → 本监听 → 规范化 →
// 经 'live2d:voice' 送回同一 renderer（与 F4 真实推送走完全相同的 renderer 路径）。
// 未开 inject 标志时不注册，生产路径无注入面。
if (voiceInjectEnabled) {
  ipcMain.on(VOICE_INJECT_CHANNEL, (event, raw) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? avatarWindow
    sendVoiceEvent(win, raw)
  })
}

// ---------------------------------------------------- F5 main↔renderer 命令通道
// MCP 视觉工具的执行路径：main 发 'live2d:command' { requestId, type, params } →
// preload 窄校验后交 renderer 注册的 handler（renderer/src/main.ts）执行 Live2DApp →
// 'live2d:command-result' 回传 { requestId, result }。本侧仅认白名单结果帧。

/** @type {Map<string, { resolve: (result: object) => void, timer: NodeJS.Timeout }>} */
const pendingCommands = new Map()
/** renderer 命令 handler 是否已挂接（preload onCommand 注册时发 ready 帧） */
let rendererCommandReady = false

ipcMain.on(COMMAND_READY_CHANNEL, (event) => {
  if (avatarWindow && !avatarWindow.isDestroyed() && event.sender === avatarWindow.webContents) {
    rendererCommandReady = true
  }
})

ipcMain.on(COMMAND_RESULT_CHANNEL, (event, frame) => {
  if (!avatarWindow || avatarWindow.isDestroyed() || event.sender !== avatarWindow.webContents) {
    return
  }
  const normalized = normalizeCommandResultFrame(frame)
  if (!normalized) {
    console.warn('[live2d] 非法命令结果帧，已丢弃')
    return
  }
  const pending = pendingCommands.get(normalized.requestId)
  if (!pending) return
  pendingCommands.delete(normalized.requestId)
  clearTimeout(pending.timer)
  pending.resolve(normalized.result)
})

/**
 * 向 renderer 发命令并等待结果（MCP 工具回调统一走这里）。
 * 所有失败路径都 resolve 为 { ok:false, error }，不 reject——MCP 工具层据此
 * 返回 isError 清晰降级。窗口/renderer 未挂接立即失败；超时 COMMAND_TIMEOUT_MS。
 */
function sendRendererCommand(type, params) {
  const win = avatarWindow
  if (!win || win.isDestroyed()) {
    return Promise.resolve({ ok: false, error: '角色窗不存在（可能已关闭）' })
  }
  if (!rendererCommandReady) {
    return Promise.resolve({ ok: false, error: 'renderer 命令通道未挂接（页面加载中）' })
  }
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId)
      resolve({ ok: false, error: 'renderer 命令超时', timeout: true })
    }, COMMAND_TIMEOUT_MS)
    pendingCommands.set(requestId, { resolve, timer })
    win.webContents.send(COMMAND_CHANNEL, { requestId, type, params })
  })
}

// registerSchemesAsPrivileged 必须在 app ready 之前调用
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

app.setName('Live2D Companion')

let avatarWindow = null
let settingsWindow = null
let tray = null
let isQuitting = false

// -------------------------------------------------------- F6/F7 voice settings

let settingsStore = null
let persistedSettings = defaultSettings()
let voiceSourceConfig = resolveVoiceSourceConfig(process.env, persistedSettings.voiceSource)
let audioListener = null
let nativeListenerStatus = null
let listenerLastLevel = null

/** /health 与 MCP get_status 共用的 listener 真值摘要。 */
function listenerSummary() {
  return buildListenerSummary({
    mode: voiceSourceConfig.source.mode,
    platform: process.platform,
    native: nativeListenerStatus,
    lastLevel: listenerLastLevel,
  })
}

function settingsViewModel(message = '') {
  return {
    ...buildSettingsViewModel({
      actualPort: bridgePort(),
      environment: process.env,
      voiceSource: persistedSettings.voiceSource,
      listener: listenerSummary(),
      environmentOverridesVoice: voiceSourceConfig.environmentOverridesVoice,
    }),
    effectiveVoiceSource: { ...voiceSourceConfig.source },
    message,
  }
}

function notifySettingsChanged(message = '') {
  if (!settingsWindow || settingsWindow.isDestroyed()) return
  settingsWindow.webContents.send(SETTINGS_CHANGED_CHANNEL, settingsViewModel(message))
}

function stopAudioListener() {
  const listener = audioListener
  audioListener = null
  listener?.stop()
  nativeListenerStatus = null
  listenerLastLevel = null
}

/**
 * native listener 契约 → F3/F4 权威 voice 事件入口。
 * session 开启先进入 active/listening；activity/level 后续按 helper 流更新。
 */
function startAudioListener() {
  for (const warning of voiceSourceConfig.warnings) {
    console.warn(`[live2d] voice source 配置：${warning}`)
  }

  const listener = createAudioListener({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    environment: process.env,
    voiceSource: voiceSourceConfig.source,
    processPattern: voiceSourceConfig.pattern,
    onSession: (active) => {
      if (audioListener !== listener) return
      sendVoiceEvent(avatarWindow, {
        type: 'state',
        state: active
          ? { phase: 'active', activity: 'listening' }
          : { phase: 'inactive', activity: 'idle' },
      })
    },
    onActivity: (activity) => {
      if (audioListener !== listener) return
      sendVoiceEvent(avatarWindow, { type: 'state', state: { activity } })
    },
    onLevel: (level) => {
      if (audioListener !== listener) return
      listenerLastLevel = level
      sendVoiceEvent(avatarWindow, { type: 'audio-level', level })
    },
    onStatus: (status) => {
      if (audioListener !== listener) return
      nativeListenerStatus = status
      const summary = listenerSummary()
      console.log(`[live2d] voice listener: ${summary.mode}/${summary.status}${summary.detail ? ` (${summary.detail})` : ''}`)
      notifySettingsChanged()
    },
    onDebug: (message, detail) => {
      if (process.env.LIVE2D_LISTENER_DEBUG === '1') {
        console.warn(`[live2d] ${message}: ${String(detail).trim().slice(0, 500)}`)
      }
    },
  })

  audioListener = listener

  if (!listener) {
    const summary = listenerSummary()
    console.log(`[live2d] voice listener: ${summary.mode}/${summary.status}${summary.detail ? ` (${summary.detail})` : ''}`)
    return
  }

  void listener.start().catch((error) => {
    if (audioListener !== listener) return
    nativeListenerStatus = {
      available: false,
      capturing: false,
      monitoring: false,
      source: null,
      matched: 0,
      detail: 'startup-failed',
      error: error instanceof Error ? error.message : String(error),
      permissionHint: null,
    }
    console.error(`[live2d] voice listener 启动失败：${nativeListenerStatus.error}`)
  })
}

function applyPersistedVoiceSource(message = '设置已保存，voice listener 已热更新。') {
  stopAudioListener()
  voiceSourceConfig = resolveVoiceSourceConfig(process.env, persistedSettings.voiceSource)
  startAudioListener()
  const effectiveMessage = voiceSourceConfig.environmentOverridesVoice
    ? '设置已保存；LIVE2D_* 环境变量仍优先，移除覆盖并重启后才会采用该值。'
    : message
  notifySettingsChanged(effectiveMessage)
  return effectiveMessage
}

/** 贴到光标所在显示器工作区右下角（参考 persona positionWindow） */
function positionWindow(win) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = win.getBounds()
  win.setPosition(
    Math.round(display.workArea.x + display.workArea.width - bounds.width - WINDOW_MARGIN),
    Math.round(display.workArea.y + display.workArea.height - bounds.height - WINDOW_MARGIN),
    false,
  )
}

function rendererUrl() {
  return isDev ? DEV_SERVER_URL : `${RENDERER_ORIGIN}/`
}

/** 禁止弹新窗；导航仅允许停留在 renderer 自身源内（对齐 persona secureRendererWindow 思路） */
function secureRendererWindow(win, allowedOrigin) {
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

function createWindow() {
  if (avatarWindow && !avatarWindow.isDestroyed()) return avatarWindow

  const url = rendererUrl()
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
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
      // F3 测试注入标志透传：preload 检测到该参数才暴露 window.live2d.injectVoice
      additionalArguments: voiceInjectEnabled ? [VOICE_INJECT_ARG] : [],
    },
  })
  avatarWindow = win

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    positionWindow(win)
    win.show()
    console.log(`[live2d] 角色窗已显示（${isDev ? 'dev' : 'prod'}: ${url}）`)
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[live2d] renderer 加载失败: ${errorCode} ${errorDescription}（${url}）`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[live2d] renderer 进程退出: ${details.reason}`)
  })
  win.on('close', (event) => {
    if (isQuitting || shouldQuitAfterAllWindowsClosed(tray)) return
    event.preventDefault()
    win.hide()
  })
  // 冒烟/排障用：LIVE2D_RENDERER_LOG=1 时把 renderer console 汇入终端
  if (process.env.LIVE2D_RENDERER_LOG === '1') {
    // 兼容签名差异：旧 (event, level, message, …) / 新 (details)
    win.webContents.on('console-message', (...args) => {
      const first = args[0]
      const text =
        typeof first === 'object' && first !== null && 'message' in first
          ? first.message
          : args.find((a) => typeof a === 'string')
      if (text) console.log(`[renderer] ${text}`)
    })
  }
  win.on('closed', () => {
    if (avatarWindow === win) avatarWindow = null
    // 窗口销毁 → 命令通道失效；挂起中的命令立即失败（不等超时）
    rendererCommandReady = false
    for (const [requestId, pending] of pendingCommands) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: '角色窗已关闭' })
      pendingCommands.delete(requestId)
    }
  })

  let allowedOrigin = RENDERER_ORIGIN
  try {
    allowedOrigin = new URL(url).origin
  } catch {
    // 保底：非法 dev URL 会在 loadURL 时报 did-fail-load
  }
  secureRendererWindow(win, allowedOrigin)

  if (isDev && process.env.LIVE2D_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  void win.loadURL(url)
  return win
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    notifySettingsChanged()
    return settingsWindow
  }

  const win = new BrowserWindow({
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
  settingsWindow = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })
  void win.loadFile(path.join(__dirname, 'settings.html'))
  return win
}

function createAppTray() {
  if (tray && !tray.isDestroyed()) return tray
  tray = createTrayController({
    Tray,
    Menu,
    nativeImage,
    platform: process.platform,
    actions: {
      showAvatar: () => windowAction('show'),
      hideAvatar: () => windowAction('hide'),
      openSettings: () => createSettingsWindow(),
      quitApp: () => {
        isQuitting = true
        app.quit()
      },
    },
  })
  return tray
}

function isSettingsSender(event) {
  return Boolean(
    settingsWindow &&
    !settingsWindow.isDestroyed() &&
    event.sender === settingsWindow.webContents,
  )
}

ipcMain.handle(SETTINGS_GET_CHANNEL, (event) => {
  if (!isSettingsSender(event)) throw new Error('settings IPC sender 非法')
  return settingsViewModel()
})

ipcMain.handle(SETTINGS_SAVE_CHANNEL, (event, voiceSource) => {
  if (!isSettingsSender(event)) return { ok: false, error: 'settings IPC sender 非法' }
  if (!settingsStore) return { ok: false, error: '设置存储尚未就绪' }
  try {
    persistedSettings = settingsStore.save({ voiceSource })
    const message = applyPersistedVoiceSource()
    return { ok: true, view: settingsViewModel(message) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      view: settingsViewModel(),
    }
  }
})

ipcMain.handle(SETTINGS_COPY_CHANNEL, (event) => {
  if (!isSettingsSender(event)) return false
  clipboard.writeText(settingsViewModel().codexCommand)
  return true
})

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.on('activate', () => {
    windowAction('show')
  })

  app.whenReady().then(() => {
    if (!isDev) {
      if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        console.error('[live2d] 未找到 renderer/dist/index.html，请先运行 npm run build 再 npm start')
        app.exit(1)
        return
      }
      registerRendererProtocol(DIST_DIR)
    }
    settingsStore = createSettingsStore({
      filePath: path.join(app.getPath('userData'), 'settings.json'),
    })
    const loadedSettings = settingsStore.load()
    persistedSettings = loadedSettings.settings
    voiceSourceConfig = resolveVoiceSourceConfig(process.env, persistedSettings.voiceSource)
    for (const warning of loadedSettings.warnings) console.warn(`[live2d] ${warning}`)
    console.log(`[live2d] 启动模式: ${isDev ? `dev（${DEV_SERVER_URL}）` : 'prod（renderer/dist）'}`)
    if (voiceInjectEnabled) {
      console.log('[live2d] voice 测试注入已开启（LIVE2D_VOICE_INJECT=1）：renderer 可经 window.live2d.injectVoice 注入 state/audio-level')
    }
    console.log('[live2d] 模型资源指引: 将 Cubism 4 模型放入 renderer/public/model/HiyoriPro/' +
      `（入口 ${MODEL_ENTRY_HINT}），并将 live2dcubismcore.min.js 放入 renderer/public/；`)
    console.log('[live2d] 缺模型时窗口内显示引导而不会崩溃（生产模式放入后需重新 npm run build）')
    createAppTray()
    createWindow()
    startAudioListener()
    void startBridge()
  })
}

// ----------------------------------------------------------- F4/F5 bridge + MCP

let bridge = null
let mcpHandler = null

/** 当前 bridge 实际端口（未监听为 null） */
function bridgePort() {
  return bridge?.address()?.port ?? null
}

/** /health 附加字段（尽力而为，不含用户内容；模型就绪 main 侧暂不可知 → null） */
function bridgeHealthExtra() {
  const win = avatarWindow
  const port = bridgePort()
  return {
    // /health 保持 SPEC §8.3 稳定形状：main 侧不做 renderer 往返，模型真实状态
    // 走 MCP get_status（F5）；本片起 mcp.implemented 如实标记 true
    modelReady: null,
    windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
    voiceInject: voiceInjectEnabled,
    listener: listenerSummary(),
    mcp: {
      path: MCP_PATH,
      implemented: true,
      url: port === null ? null : `http://${BRIDGE_HOST}:${port}${MCP_PATH}`,
    },
  }
}

// ------------------------------------------------------------------ F5 MCP 工具

/** control_window：show/hide/toggle 真实作用于角色窗；hide 不退出应用 */
function windowAction(action) {
  let win = avatarWindow
  if (action === 'hide') {
    if (win && !win.isDestroyed()) win.hide()
    return false
  }
  if (action === 'show' || action === 'toggle') {
    const visible = Boolean(win && !win.isDestroyed() && win.isVisible())
    if (action === 'toggle' && visible) {
      win.hide()
      return false
    }
    if (!win || win.isDestroyed()) win = createWindow()
    if (!win.isVisible()) win.show()
    win.focus()
    return true
  }
  return Boolean(win && !win.isDestroyed() && win.isVisible())
}

/**
 * get_status 的模型摘要：renderer 命令通道未挂接 → ready:null（unknown，如实）；
 * 往返成功 → ready:true + 计数摘要；模型未加载 → ready:false + 清晰错误。
 */
async function modelStatusSummary() {
  if (!rendererCommandReady) return { ready: null, note: 'renderer 命令通道未挂接' }
  const result = await sendRendererCommand('getModelInfo', {})
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
async function mcpStatus() {
  const win = avatarWindow
  const port = bridgePort()
  return {
    windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
    bridge: {
      port,
      url: port === null ? null : `http://${BRIDGE_HOST}:${port}`,
    },
    voice: bridge?.getVoiceSummary() ?? null,
    listener: listenerSummary(),
    mcp: {
      path: MCP_PATH,
      implemented: true,
      url: port === null ? null : `http://${BRIDGE_HOST}:${port}${MCP_PATH}`,
    },
    model: await modelStatusSummary(),
  }
}

/** MCP controller：窗口控制 main 自完成；视觉命令经命令通道转发 renderer */
const mcpController = {
  onWindowAction: (action) => windowAction(action),
  getStatus: () => mcpStatus(),
  getModelInfo: () => sendRendererCommand('getModelInfo', {}),
  onExpression: (expression) => sendRendererCommand('setExpression', { expression }),
  onMotion: ({ group, index, priority }) =>
    sendRendererCommand('playMotion', { group, index, priority }),
  onLookAt: ({ x, y }) => sendRendererCommand('lookAt', { x, y }),
  onParameter: ({ paramId, value }) =>
    sendRendererCommand('setParameter', { param_id: paramId, value }),
  onReset: () => sendRendererCommand('reset', {}),
}

/**
 * 启动 loopback bridge（默认 127.0.0.1:47832，LIVE2D_BRIDGE_PORT 覆盖端口）并
 * 在同端口挂载 Streamable HTTP MCP（/mcp）。/events 的 onEvent 即 sendVoiceEvent——
 * curl 注入与 F3 注入走完全相同的规范化 + IPC + renderer 状态机路径。
 * 监听失败不杀应用，打印清晰日志提示换端口。
 */
async function startBridge() {
  const envRaw = process.env.LIVE2D_BRIDGE_PORT
  const envPort = resolveBridgePort(envRaw)
  if (envRaw && envPort === null) {
    console.warn(`[live2d] LIVE2D_BRIDGE_PORT=${JSON.stringify(envRaw)} 非法（需 1-65535 整数），回退默认 ${BRIDGE_DEFAULT_PORT}`)
  }
  const port = envPort ?? BRIDGE_DEFAULT_PORT
  mcpHandler = createLive2dMcpHandler(mcpController)
  bridge = createBridgeServer({
    host: BRIDGE_HOST,
    port,
    onEvent: (event) => sendVoiceEvent(avatarWindow, event),
    getHealth: bridgeHealthExtra,
    mcpHandler,
  })
  try {
    const address = await bridge.listen()
    console.log(`[live2d] bridge 已监听（仅 loopback）: http://${BRIDGE_HOST}:${address.port}/health 与 /events`)
    console.log(`[live2d] MCP Streamable HTTP 已就绪: http://${BRIDGE_HOST}:${address.port}${MCP_PATH}`)
    console.log(`[live2d] MCP 连接示例: codex mcp add live2d --url http://${BRIDGE_HOST}:${address.port}${MCP_PATH}`)
    notifySettingsChanged()
  } catch (error) {
    bridge = null
    mcpHandler = null
    console.error(
      `[live2d] bridge 监听失败（${error?.code ?? error}）：端口 ${port} 不可用；` +
        '可用环境变量 LIVE2D_BRIDGE_PORT 换端口后重启。窗口与口型主路径不受影响。',
    )
  }
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  stopAudioListener()
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  if (mcpHandler) {
    const handler = mcpHandler
    mcpHandler = null
    void handler.close().catch(() => {})
  }
  if (!bridge) return
  const current = bridge
  bridge = null
  void current.close().catch(() => {})
})

app.on('window-all-closed', () => {
  if (shouldQuitAfterAllWindowsClosed(tray)) app.quit()
})
