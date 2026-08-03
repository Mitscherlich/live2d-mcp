'use strict'

/**
 * Live2D Companion · Electron 主进程（ADR 0001 · F2 起；F3 voice 事件转发；F4 bridge）
 *
 * 本片（F4）新增职责：
 *  - 启动 loopback bridge HTTP（electron/bridge-server.cjs，默认 127.0.0.1:47832，
 *    LIVE2D_BRIDGE_PORT 可覆盖端口）：GET /health、POST /events；
 *  - /events 负载经权威规范化后由 sendVoiceEvent 推送到 renderer——与 F3 注入
 *    完全同路径（curl → bridge → 'live2d:voice' → preload → 状态机 → 嘴参）；
 *  - /mcp 本片明确 404 未实现（F5 落地 Streamable HTTP MCP）。
 *
 * F3 既有职责：
 *  - sendVoiceEvent(win, raw)：规范化后经 'live2d:voice' 推送 voice 事件到 renderer；
 *  - 测试注入：LIVE2D_VOICE_INJECT=1（或 --live2d-voice-inject）启动时，
 *    经 additionalArguments 让 preload 暴露 window.live2d.injectVoice，
 *    并注册 ipcMain 'live2d:voice-inject' 回环（renderer 注入 → 规范化 →
 *    与真实推送完全同路径送回 renderer）。
 *
 * 明确不在本片（防跨片）：
 *  - MCP Streamable HTTP（F5）、voice listener（F6）、托盘与设置窗（F7）
 *  因此 /mcp 仅 404 占位；无 native listener；无托盘保活，窗口关闭即退出。
 *
 * 窗口/preload 模式参考 persona（只读，MIT），未复制其 VRM/资产逻辑。
 */

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron')
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

const WINDOW_WIDTH = 600
const WINDOW_HEIGHT = 640
const WINDOW_MARGIN = 24

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

  app.whenReady().then(() => {
    if (!isDev) {
      if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        console.error('[live2d] 未找到 renderer/dist/index.html，请先运行 npm run build 再 npm start')
        app.exit(1)
        return
      }
      registerRendererProtocol(DIST_DIR)
    }
    console.log(`[live2d] 启动模式: ${isDev ? `dev（${DEV_SERVER_URL}）` : 'prod（renderer/dist）'}`)
    if (voiceInjectEnabled) {
      console.log('[live2d] voice 测试注入已开启（LIVE2D_VOICE_INJECT=1）：renderer 可经 window.live2d.injectVoice 注入 state/audio-level')
    }
    console.log('[live2d] 模型资源指引: 将 Cubism 4 模型放入 renderer/public/model/HiyoriPro/' +
      `（入口 ${MODEL_ENTRY_HINT}），并将 live2dcubismcore.min.js 放入 renderer/public/；`)
    console.log('[live2d] 缺模型时窗口内显示引导而不会崩溃（生产模式放入后需重新 npm run build）')
    createWindow()
    void startBridge()
  })
}

// ---------------------------------------------------------------- F4 bridge

let bridge = null

/** /health 附加字段（尽力而为，不含用户内容；模型就绪 main 侧暂不可知 → null） */
function bridgeHealthExtra() {
  const win = avatarWindow
  return {
    modelReady: null, // renderer 侧状态，F5 get_status 才做 renderer 往返；本片明确 unknown
    windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
    voiceInject: voiceInjectEnabled,
    listener: { status: 'not-started', mode: 'external' }, // F6 落地 native listener
    mcp: { path: '/mcp', implemented: false }, // F5 落地 Streamable HTTP MCP
  }
}

/**
 * 启动 loopback bridge（默认 127.0.0.1:47832，LIVE2D_BRIDGE_PORT 覆盖端口）。
 * /events 的 onEvent 即 sendVoiceEvent——curl 注入与 F3 注入走完全相同的
 * 规范化 + IPC + renderer 状态机路径。监听失败不杀应用，打印清晰日志提示换端口。
 */
async function startBridge() {
  const envRaw = process.env.LIVE2D_BRIDGE_PORT
  const envPort = resolveBridgePort(envRaw)
  if (envRaw && envPort === null) {
    console.warn(`[live2d] LIVE2D_BRIDGE_PORT=${JSON.stringify(envRaw)} 非法（需 1-65535 整数），回退默认 ${BRIDGE_DEFAULT_PORT}`)
  }
  const port = envPort ?? BRIDGE_DEFAULT_PORT
  bridge = createBridgeServer({
    host: BRIDGE_HOST,
    port,
    onEvent: (event) => sendVoiceEvent(avatarWindow, event),
    getHealth: bridgeHealthExtra,
  })
  try {
    const address = await bridge.listen()
    console.log(`[live2d] bridge 已监听（仅 loopback）: http://${BRIDGE_HOST}:${address.port}/health 与 /events`)
  } catch (error) {
    bridge = null
    console.error(
      `[live2d] bridge 监听失败（${error?.code ?? error}）：端口 ${port} 不可用；` +
        '可用环境变量 LIVE2D_BRIDGE_PORT 换端口后重启。窗口与口型主路径不受影响。',
    )
  }
}

app.on('will-quit', () => {
  if (!bridge) return
  const current = bridge
  bridge = null
  void current.close().catch(() => {})
})

app.on('window-all-closed', () => {
  // F2 尚无托盘（F7 引入），窗口关闭即退出
  app.quit()
})
