'use strict'

/**
 * 生产模式 renderer 静态资源协议（ADR 0001 · F2）
 *
 * 为什么不用 file:// 直接 loadFile：
 *  - Chromium 默认禁止 file:// 页面发起 fetch/XHR，而 pixi-live2d-display
 *    加载模型（.model3.json / .moc3 / 贴图）依赖 fetch，file:// 下必失败。
 *  - 自定义 standard+secure scheme 使 '/model/...' 等根绝对路径在
 *    dev（Vite http://127.0.0.1:5173）与 prod（本 scheme）下语义一致，
 *    renderer/src/live2d-app.ts 的 MODEL_PATH 常量无需分叉。
 *  - 进程内 scheme handler，不监听任何 TCP 端口（bridge 属 F4，本片不实现）。
 *
 * 思路借鉴 persona 的 persona-asset scheme（只读参考，未复制其代码）。
 */

const path = require('node:path')
const fs = require('node:fs/promises')

const RENDERER_SCHEME = 'live2d-app'
const RENDERER_HOST = 'root'
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.moc3': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 将请求 path（如 '/'、'/assets/index.js'）解析为 distDir 内的绝对路径。
 * 任何越界尝试（'..'、编码绕过、非法编码）返回 null。
 * 注：MVP 面向 macOS（POSIX 分隔符）；win 适配在后续平台切片处理。
 */
function resolveDistFile(distDir, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const rel = decoded.replace(/^\/+/, '') || 'index.html'
  const filePath = path.resolve(distDir, rel)
  if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) return null
  return filePath
}

/**
 * 注册 scheme handler，将 RENDERER_ORIGIN 下的请求映射到 distDir。
 * 须在 app.whenReady() 之后、loadURL 之前调用；
 * protocol.registerSchemesAsPrivileged 则必须在 ready 前由调用方完成。
 */
function registerRendererProtocol(distDir) {
  // 延迟 require：保持本模块在纯 Node（无 Electron）下可被单测加载
  const { protocol } = require('electron')

  protocol.handle(RENDERER_SCHEME, async (request) => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (url.host !== RENDERER_HOST) {
      return new Response('Not found', { status: 404 })
    }
    const filePath = resolveDistFile(distDir, url.pathname)
    if (!filePath) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const data = await fs.readFile(filePath)
      return new Response(data, {
        headers: {
          'Content-Type': mimeFor(filePath),
          'Cache-Control': 'no-cache',
        },
      })
    } catch {
      // 缺模型/缺文件属预期场景（FR-D3）：404 由 renderer 转为引导 UI
      return new Response('Not found', { status: 404 })
    }
  })
}

module.exports = {
  RENDERER_SCHEME,
  RENDERER_HOST,
  RENDERER_ORIGIN,
  mimeFor,
  resolveDistFile,
  registerRendererProtocol,
}
