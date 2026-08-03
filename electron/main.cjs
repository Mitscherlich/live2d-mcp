'use strict'

/**
 * Live2D Companion · Electron 主进程（ADR 0001 · F2）
 *
 * 本片职责：
 *  - 创建角色窗：无边框 / 透明 / 置顶（macOS 优先，SPEC FR-D1 能力范围内对齐）
 *  - dev 加载 Vite dev server（VITE_DEV_SERVER_URL）；
 *    prod 经自定义 scheme（live2d-app://root/）加载 renderer/dist
 *  - 缺模型资源不硬崩：主进程日志 + renderer 内引导 UI 双重指引（FR-D3）
 *
 * 明确不在本片（防跨片）：
 *  - bridge /health /events（F4）、MCP Streamable HTTP（F5）
 *  - voice listener（F6）、托盘与设置窗（F7）
 *  因此本片不监听任何 TCP 端口；无托盘保活，窗口关闭即退出。
 *
 * 窗口/preload 模式参考 persona（只读，MIT），未复制其 VRM/资产逻辑。
 */

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, protocol, screen } = require('electron')
const {
  RENDERER_SCHEME,
  RENDERER_ORIGIN,
  registerRendererProtocol,
} = require('./renderer-protocol.cjs')

const WINDOW_WIDTH = 600
const WINDOW_HEIGHT = 640
const WINDOW_MARGIN = 24

const DIST_DIR = path.join(__dirname, '..', 'renderer', 'dist')
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? ''
const isDev = DEV_SERVER_URL !== ''

// 与 renderer/src/live2d-app.ts 的 MODEL_PATH 常量对应（F2 保留该常量）
const MODEL_ENTRY_HINT = '/model/HiyoriPro/hiyori_pro_t11.model3.json'

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
    console.log('[live2d] 模型资源指引: 将 Cubism 4 模型放入 renderer/public/model/HiyoriPro/' +
      `（入口 ${MODEL_ENTRY_HINT}），并将 live2dcubismcore.min.js 放入 renderer/public/；`)
    console.log('[live2d] 缺模型时窗口内显示引导而不会崩溃（生产模式放入后需重新 npm run build）')
    createWindow()
  })
}

app.on('window-all-closed', () => {
  // F2 尚无托盘（F7 引入），窗口关闭即退出
  app.quit()
})
