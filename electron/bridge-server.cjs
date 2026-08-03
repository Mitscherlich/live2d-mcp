'use strict'

/**
 * Loopback bridge HTTP（ADR 0001 · F4）
 *
 * 本机集成面（SPEC §5.5 / ARCHITECTURE §3）：
 *  - 仅绑定 loopback（默认 127.0.0.1:47832，避开 persona 47831；
 *    LIVE2D_BRIDGE_PORT 可覆盖端口，host 永远 loopback）
 *  - GET  /health  → 进程存活与可用摘要（模型/窗口/voice 摘要；不含用户内容）
 *  - POST /events  → SPEC §8.1 state / §8.2 audio-level；body 先过
 *    electron/voice-events.cjs 的权威 normalizeVoiceEvent（与 F3 注入同一份校验，
 *    禁止第二套事件校验分叉），规范化后交 onEvent 回调（main 内接 sendVoiceEvent）
 *  - /mcp          → F5 才实现 Streamable HTTP MCP；本片明确 404 + JSON 说明
 *
 * 安全（NFR-2 / SPEC §5.5）：
 *  - Host 头必须解析为 loopback（127.0.0.1 / localhost / [::1]），否则 403
 *  - Origin 头存在时必须为受信本机 origin，否则 403；无 Origin（curl 等）放行
 *  - body 上限 64KB；非法 JSON / 非法事件形状 / 越界 level 一律 4xx，不崩溃
 *
 * 纯 node:http、无 Electron 依赖：node:test 可直接起临时端口实例单测（NFR-3）。
 * 分层与契约思路参考 persona electron/bridge-server.cjs（只读，MIT）；
 * 事件校验复用本仓 voice-events.cjs，未复制 persona 的 animation/mcp 逻辑。
 */

const http = require('node:http')
const { normalizeVoiceEvent } = require('./voice-events.cjs')

const DEFAULT_PORT = 47832
const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 64 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
// 受信 Origin：仅本机 loopback http(s) origin（SPEC §5.5「非本机 Origin 拒绝」）
const TRUSTED_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

/**
 * Host 头校验：必须可解析为纯 loopback host（无 userinfo、无路径）。
 * @param {unknown} hostHeader 请求 Host 头
 */
function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false
  try {
    const url = new URL(`http://${hostHeader}`)
    return (
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    )
  } catch {
    return false
  }
}

/**
 * Origin 校验：无 Origin（curl / 非浏览器客户端）放行；有 Origin 必须受信本机。
 * @param {unknown} origin 请求 Origin 头
 */
function originAllowed(origin) {
  return origin == null || (typeof origin === 'string' && TRUSTED_ORIGIN.test(origin))
}

/**
 * 解析 LIVE2D_BRIDGE_PORT：合法返回 1-65535 整数，非法/缺失返回 null（调用方回退默认）。
 * @param {unknown} raw env 原值
 */
function resolveBridgePort(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
  response.end(JSON.stringify(body))
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error('request body is too large')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (bytes > MAX_BODY_BYTES) return // 已在 data 回调 reject
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        const error = new Error('request body is not valid JSON')
        error.code = 'INVALID_JSON'
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

/**
 * 创建 bridge server（不自动 listen）。
 * @param {object} opts
 * @param {string} [opts.host] 绑定地址（仅应传 loopback；默认 127.0.0.1）
 * @param {number} [opts.port] 端口（默认 47832；测试可传 0 取临时端口）
 * @param {(event: object) => (boolean|void)} opts.onEvent 规范化后的 voice 事件回调；
 *   返回 false 视为投递失败（如窗口已销毁），HTTP 层回 422
 * @param {(voiceSummary: object) => object} [opts.getHealth] /health 附加字段回调
 *   （main 注入窗口/模型/listener 摘要；不含用户内容）
 */
function createBridgeServer({ host = LOOPBACK_HOST, port = DEFAULT_PORT, onEvent, getHealth } = {}) {
  if (typeof onEvent !== 'function') throw new TypeError('createBridgeServer: onEvent 必填')

  // voice 摘要（仅枚举与数值，不含用户内容），供 /health 与测试观测
  const stats = {
    eventsAccepted: 0,
    eventsRejected: 0,
    lastState: null, // 最近一次规范化 state 负载（phase/activity/muted）
    lastLevel: null, // 最近一次规范化 level（已 clamp）
    lastEventAt: null, // epoch ms
  }

  function voiceSummary() {
    return {
      phase: stats.lastState?.phase ?? null,
      activity: stats.lastState?.activity ?? null,
      lastLevel: stats.lastLevel,
      lastEventAt: stats.lastEventAt,
      eventsAccepted: stats.eventsAccepted,
      eventsRejected: stats.eventsRejected,
    }
  }

  function handleHealth(request, response) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return
    }
    const base = {
      ok: true,
      bridgePort: server.address()?.port ?? port,
      voice: voiceSummary(),
    }
    let extra = {}
    if (typeof getHealth === 'function') {
      try {
        const provided = getHealth(base.voice)
        if (provided && typeof provided === 'object') extra = provided
      } catch (error) {
        extra = { healthError: String(error?.message ?? error) }
      }
    }
    sendJson(response, 200, { ...base, ...extra })
  }

  function corsHeaders(origin) {
    return origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}
  }

  async function handleEvents(request, response, origin) {
    if (!originAllowed(origin)) {
      sendJson(response, 403, { error: 'origin not allowed' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      stats.eventsRejected += 1
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(response, 413, { error: 'request body is too large' })
      } else {
        sendJson(response, 400, { error: 'request body is not valid JSON' })
      }
      return
    }
    // 权威规范化复用 voice-events.cjs（与 F3 注入通道同一份校验；level clamp [0,1]）
    const event = normalizeVoiceEvent(body)
    if (event === null) {
      stats.eventsRejected += 1
      sendJson(response, 422, { error: 'invalid voice event' })
      return
    }
    let accepted
    try {
      accepted = onEvent(event)
    } catch (error) {
      stats.eventsRejected += 1
      sendJson(response, 500, { error: 'event handler failed' })
      console.error('[live2d] bridge onEvent 抛出异常:', error)
      return
    }
    if (accepted === false) {
      stats.eventsRejected += 1
      sendJson(response, 422, { error: 'event rejected by handler' })
      return
    }
    stats.eventsAccepted += 1
    stats.lastEventAt = Date.now()
    if (event.type === 'state') stats.lastState = event.state
    if (event.type === 'audio-level') stats.lastLevel = event.level
    sendJson(response, 202, { accepted: true }, corsHeaders(origin))
  }

  const server = http.createServer((request, response) => {
    // Host 校验对所有路由生效（仅 loopback Host，DNS rebinding 防线）
    if (!hostAllowed(request.headers.host)) {
      sendJson(response, 403, { error: 'host not allowed' })
      return
    }
    let pathname
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname
    } catch {
      sendJson(response, 400, { error: 'bad request target' })
      return
    }
    const origin = request.headers.origin

    if (pathname === '/health') {
      handleHealth(request, response)
      return
    }

    if (pathname === '/events') {
      if (request.method === 'OPTIONS') {
        // CORS 预检：仅受信 origin 放行（浏览器本机客户端）
        if (!originAllowed(origin) || !origin) {
          sendJson(response, 403, { error: 'origin not allowed' })
          return
        }
        response.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          vary: 'Origin',
        })
        response.end()
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method not allowed' }, { allow: 'POST, OPTIONS' })
        return
      }
      void handleEvents(request, response, origin)
      return
    }

    if (pathname === '/mcp') {
      // F5 落地 Streamable HTTP MCP；本片明确未实现（保留路由占位便于探测）
      sendJson(response, 404, { error: 'mcp not implemented (F5)' })
      return
    }

    sendJson(response, 404, { error: 'not found' })
  })

  return {
    /** 开始监听；resolve 为 server.address()（含实际端口）。EADDRINUSE 等原样 reject */
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve(server.address())
        })
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    address: () => server.address(),
    /** 测试与健康检查用 voice 摘要（与 /health 的 voice 字段同源） */
    getVoiceSummary: voiceSummary,
  }
}

module.exports = {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  MAX_BODY_BYTES,
  createBridgeServer,
  hostAllowed,
  originAllowed,
  resolveBridgePort,
}
