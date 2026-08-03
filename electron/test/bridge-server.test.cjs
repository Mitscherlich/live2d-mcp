'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const {
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  createBridgeServer,
  hostAllowed,
  originAllowed,
  resolveBridgePort,
} = require('../bridge-server.cjs')
const { normalizeVoiceEvent } = require('../voice-events.cjs')

/** 起临时端口实例；返回 { bridge, baseUrl, close } */
async function startBridge(opts = {}) {
  const bridge = createBridgeServer({ port: 0, onEvent: () => true, ...opts })
  const address = await bridge.listen()
  return { bridge, baseUrl: `http://127.0.0.1:${address.port}`, close: () => bridge.close() }
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('端口常量与 env 解析：默认 47832（避开 persona 47831），非法 env 回退', () => {
  assert.equal(DEFAULT_PORT, 47832)
  assert.equal(resolveBridgePort('47840'), 47840)
  assert.equal(resolveBridgePort('1'), 1)
  assert.equal(resolveBridgePort('65535'), 65535)
  assert.equal(resolveBridgePort(undefined), null)
  assert.equal(resolveBridgePort(''), null)
  assert.equal(resolveBridgePort('0'), null)
  assert.equal(resolveBridgePort('65536'), null)
  assert.equal(resolveBridgePort('abc'), null)
  assert.equal(resolveBridgePort('47832.5'), null)
})

test('hostAllowed：仅 loopback Host 放行（SPEC §5.5）', () => {
  assert.equal(hostAllowed('127.0.0.1:47832'), true)
  assert.equal(hostAllowed('127.0.0.1'), true)
  assert.equal(hostAllowed('localhost:47832'), true)
  assert.equal(hostAllowed('LOCALHOST:47832'), true)
  assert.equal(hostAllowed('[::1]:47832'), true)
  // 非本机 / 伪装 / 畸形一律拒绝
  assert.equal(hostAllowed('example.com'), false)
  assert.equal(hostAllowed('127.0.0.1.evil.com'), false)
  assert.equal(hostAllowed('0.0.0.0:47832'), false)
  assert.equal(hostAllowed('user:pass@127.0.0.1:47832'), false)
  assert.equal(hostAllowed(''), false)
  assert.equal(hostAllowed(undefined), false)
  assert.equal(hostAllowed('http://127.0.0.1/path'), false)
})

test('originAllowed：无 Origin 放行（curl），仅受信本机 origin 放行', () => {
  assert.equal(originAllowed(null), true)
  assert.equal(originAllowed(undefined), true)
  assert.equal(originAllowed('http://127.0.0.1:5173'), true)
  assert.equal(originAllowed('http://localhost:5173'), true)
  assert.equal(originAllowed('https://[::1]:8443'), true)
  assert.equal(originAllowed('https://evil.com'), false)
  assert.equal(originAllowed('http://127.0.0.1.evil.com'), false)
  assert.equal(originAllowed('null'), false) // 浏览器 opaque origin
  assert.equal(originAllowed('file://'), false)
})

test('GET /health：200 JSON，含 ok/bridgePort/voice 摘要与 getHealth 附加字段', async () => {
  const { baseUrl, close } = await startBridge({
    getHealth: () => ({
      modelReady: null,
      windowVisible: true,
      listener: { status: 'not-started', mode: 'external' },
      mcp: { path: '/mcp', implemented: false },
    }),
  })
  try {
    const res = await fetch(`${baseUrl}/health`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/json/)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.bridgePort, Number(new URL(baseUrl).port))
    assert.deepEqual(body.voice, {
      phase: null,
      activity: null,
      lastLevel: null,
      lastEventAt: null,
      eventsAccepted: 0,
      eventsRejected: 0,
    })
    assert.equal(body.modelReady, null)
    assert.equal(body.windowVisible, true)
    assert.equal(body.listener.mode, 'external')
    // 不含用户内容字段
    assert.equal('text' in body, false)
    assert.equal('transcript' in body, false)
  } finally {
    await close()
  }
})

test('/health 非 GET 方法 → 405', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    const res = await postJson(`${baseUrl}/health`, {})
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'GET')
  } finally {
    await close()
  }
})

test('POST /events：合法 state/audio-level → 202 且 onEvent 收到规范化事件（与 normalizeVoiceEvent 同源）', async () => {
  const received = []
  const { baseUrl, close } = await startBridge({ onEvent: (e) => received.push(e) })
  try {
    const stateRaw = {
      type: 'state',
      state: { phase: 'active', activity: 'speaking', microphoneMuted: false, outputMuted: false },
    }
    const res1 = await postJson(`${baseUrl}/events`, stateRaw)
    assert.equal(res1.status, 202)
    assert.deepEqual(await res1.json(), { accepted: true })

    const res2 = await postJson(`${baseUrl}/events`, { type: 'audio-level', level: 0.31 })
    assert.equal(res2.status, 202)

    assert.equal(received.length, 2)
    // 与权威规范化输出完全一致（双套校验不存在的直接证据）
    assert.deepEqual(received[0], normalizeVoiceEvent(stateRaw))
    assert.deepEqual(received[1], { type: 'audio-level', level: 0.31 })
  } finally {
    await close()
  }
})

test('POST /events：level 越界 clamp 到 [0,1] 后再交 onEvent（SPEC §8.2）', async () => {
  const received = []
  const { baseUrl, close } = await startBridge({ onEvent: (e) => received.push(e) })
  try {
    const res = await postJson(`${baseUrl}/events`, { type: 'audio-level', level: 42 })
    assert.equal(res.status, 202)
    assert.deepEqual(received, [{ type: 'audio-level', level: 1 }])
  } finally {
    await close()
  }
})

test('POST /events：合法事件更新 voice 摘要，/health 可见（phase/activity/lastLevel）', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    await postJson(`${baseUrl}/events`, { type: 'state', state: { phase: 'active', activity: 'speaking' } })
    await postJson(`${baseUrl}/events`, { type: 'audio-level', level: 0.5 })
    const health = await (await fetch(`${baseUrl}/health`)).json()
    assert.equal(health.voice.phase, 'active')
    assert.equal(health.voice.activity, 'speaking')
    assert.equal(health.voice.lastLevel, 0.5)
    assert.equal(health.voice.eventsAccepted, 2)
    assert.equal(typeof health.voice.lastEventAt, 'number')
  } finally {
    await close()
  }
})

test('POST /events：非法事件形状 → 422 且 onEvent 未被调用（NFR-3）', async () => {
  let calls = 0
  const { baseUrl, close } = await startBridge({
    onEvent: () => {
      calls += 1
    },
  })
  try {
    for (const bad of [
      { type: 'audio-level', level: 'loud' },
      { type: 'audio-level' },
      { type: 'state', state: { activity: 'talking' } },
      { type: 'state', state: {} },
      { type: 'motion', group: 'Idle' },
      { type: 42 },
      [],
      null,
    ]) {
      const res = await postJson(`${baseUrl}/events`, bad)
      assert.equal(res.status, 422, JSON.stringify(bad))
    }
    assert.equal(calls, 0)
    const health = await (await fetch(`${baseUrl}/health`)).json()
    assert.equal(health.voice.eventsRejected, 8)
    assert.equal(health.voice.eventsAccepted, 0)
  } finally {
    await close()
  }
})

test('POST /events：非法 JSON → 400；未知字段被剥离不穿透', async () => {
  const received = []
  const { baseUrl, close } = await startBridge({ onEvent: (e) => received.push(e) })
  try {
    const bad = await postJson(`${baseUrl}/events`, '{not json')
    assert.equal(bad.status, 400)
    const ok = await postJson(`${baseUrl}/events`, {
      type: 'audio-level',
      level: 0.5,
      hack: 'x',
    })
    assert.equal(ok.status, 202)
    assert.deepEqual(received, [{ type: 'audio-level', level: 0.5 }])
  } finally {
    await close()
  }
})

test('POST /events：body 超过 64KB → 413，服务不崩溃', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    const res = await postJson(`${baseUrl}/events`, {
      type: 'audio-level',
      level: 0.5,
      pad: 'x'.repeat(MAX_BODY_BYTES),
    })
    assert.equal(res.status, 413)
    // 服务仍然存活
    const health = await fetch(`${baseUrl}/health`)
    assert.equal(health.status, 200)
  } finally {
    await close()
  }
})

test('非 loopback Host 头 → 403（node:http 直发，fetch 禁改 Host）', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    const port = Number(new URL(baseUrl).port)
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { host: 'evil.com' } },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  } finally {
    await close()
  }
})

test('POST /events：非受信 Origin → 403；受信本机 Origin → 202 且带 CORS 头', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    const evil = await postJson(
      `${baseUrl}/events`,
      { type: 'audio-level', level: 0.5 },
      { origin: 'https://evil.com' },
    )
    assert.equal(evil.status, 403)

    const trusted = await postJson(
      `${baseUrl}/events`,
      { type: 'audio-level', level: 0.5 },
      { origin: 'http://localhost:5173' },
    )
    assert.equal(trusted.status, 202)
    assert.equal(trusted.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  } finally {
    await close()
  }
})

test('OPTIONS /events：受信 origin → 204 预检；无 origin / 非受信 → 403', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    const preflight = await fetch(`${baseUrl}/events`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173' },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS')

    const noOrigin = await fetch(`${baseUrl}/events`, { method: 'OPTIONS' })
    assert.equal(noOrigin.status, 403)

    const evil = await fetch(`${baseUrl}/events`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.com' },
    })
    assert.equal(evil.status, 403)
  } finally {
    await close()
  }
})

test('/events 非 POST/OPTIONS → 405；未知路径 → 404', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    const get = await fetch(`${baseUrl}/events`)
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST, OPTIONS')

    const notFound = await fetch(`${baseUrl}/nope`)
    assert.equal(notFound.status, 404)
    assert.deepEqual(await notFound.json(), { error: 'not found' })
  } finally {
    await close()
  }
})

test('/mcp：未注入 mcpHandler 时保持 404 JSON 占位', async () => {
  const { baseUrl, close } = await startBridge()
  try {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await fetch(`${baseUrl}/mcp`, { method })
      assert.equal(res.status, 404, method)
      assert.deepEqual(await res.json(), { error: 'mcp not implemented (F5)' })
    }
  } finally {
    await close()
  }
})

// ------------------------------------------------------------------ F5 /mcp 委托

test('/mcp：注入 mcpHandler 后 POST 委托（解析后 body 透传），非 MCP 方法 405', async () => {
  const seen = []
  const mcpHandler = async (request, response, parsedBody) => {
    seen.push({ method: request.method, parsedBody })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  }
  const { baseUrl, close } = await startBridge({ mcpHandler })
  try {
    const post = await postJson(`${baseUrl}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' })
    assert.equal(post.status, 200)
    assert.deepEqual(seen[0], { method: 'POST', parsedBody: { jsonrpc: '2.0', id: 1, method: 'ping' } })

    // GET/DELETE 不解析 body，parsedBody 为 undefined（Streamable HTTP 会话管理用）
    const del = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    assert.deepEqual(seen[1], { method: 'DELETE', parsedBody: undefined })

    const put = await fetch(`${baseUrl}/mcp`, { method: 'PUT' })
    assert.equal(put.status, 405)
    assert.equal(put.headers.get('allow'), 'POST, GET, DELETE')
    assert.equal(seen.length, 2, '405 不得进入 mcpHandler')
  } finally {
    await close()
  }
})

test('/mcp：Origin 校验作用于写路径（与 /events 同口径），Host 防线全局生效', async () => {
  const mcpHandler = async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  }
  const { baseUrl, close } = await startBridge({ mcpHandler })
  try {
    const evilOrigin = await postJson(
      `${baseUrl}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { origin: 'https://evil.com' },
    )
    assert.equal(evilOrigin.status, 403)
    assert.deepEqual(await evilOrigin.json(), { error: 'origin not allowed' })

    const trusted = await postJson(
      `${baseUrl}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { origin: 'http://127.0.0.1:5173' },
    )
    assert.equal(trusted.status, 200)

    // Host 校验对所有路由生效（含 /mcp）：fetch 禁改 Host，用 node:http 直发
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/mcp`,
        { method: 'POST', headers: { host: 'evil.com', 'content-type': 'application/json' } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        },
      )
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(status, 403)
  } finally {
    await close()
  }
})

test('/mcp：body 解析失败映射 JSON-RPC 错误（坏 JSON -32700 / 超限 413 / handler 异常 500）', async () => {
  let mode = 'ok'
  const mcpHandler = async (_request, response) => {
    if (mode === 'throw') throw new Error('boom')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  }
  const { baseUrl, close } = await startBridge({ mcpHandler })
  try {
    const badJson = await postJson(`${baseUrl}/mcp`, '{not json')
    assert.equal(badJson.status, 400)
    const badJsonBody = await badJson.json()
    assert.equal(badJsonBody.jsonrpc, '2.0')
    assert.equal(badJsonBody.error.code, -32700)

    const tooLarge = await postJson(`${baseUrl}/mcp`, JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }))
    assert.equal(tooLarge.status, 413)
    assert.equal((await tooLarge.json()).error.code, -32000)

    mode = 'throw'
    const crashed = await postJson(`${baseUrl}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' })
    assert.equal(crashed.status, 500)
    assert.equal((await crashed.json()).error.code, -32603)

    // 服务存活
    mode = 'ok'
    const recovered = await postJson(`${baseUrl}/mcp`, { jsonrpc: '2.0', id: 1, method: 'ping' })
    assert.equal(recovered.status, 200)
  } finally {
    await close()
  }
})

test('createBridgeServer 拒绝非 loopback bind host（决策 5/6 模块边界强制）', () => {
  for (const host of ['0.0.0.0', '192.168.1.10', 'example.com', '::']) {
    assert.throws(
      () => createBridgeServer({ host, onEvent: () => true }),
      /loopback/,
      `应拒绝 ${host}`,
    )
  }
  // loopback 三形态放行
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.doesNotThrow(() => createBridgeServer({ host, port: 0, onEvent: () => true }))
  }
})

test('onEvent 返回 false → 422；抛异常 → 500 且服务存活', async () => {
  let mode = 'ok'
  const { baseUrl, close } = await startBridge({
    onEvent: () => {
      if (mode === 'false') return false
      if (mode === 'throw') throw new Error('boom')
      return true
    },
  })
  try {
    mode = 'false'
    const declined = await postJson(`${baseUrl}/events`, { type: 'audio-level', level: 0.5 })
    assert.equal(declined.status, 422)

    mode = 'throw'
    const crashed = await postJson(`${baseUrl}/events`, { type: 'audio-level', level: 0.5 })
    assert.equal(crashed.status, 500)

    mode = 'ok'
    const recovered = await postJson(`${baseUrl}/events`, { type: 'audio-level', level: 0.5 })
    assert.equal(recovered.status, 202)
  } finally {
    await close()
  }
})

test('端口占用时 listen 原样 reject（main 据此打印清晰日志）', async () => {
  const first = createBridgeServer({ port: 0, onEvent: () => true })
  const address = await first.listen()
  try {
    const second = createBridgeServer({ port: address.port, onEvent: () => true })
    await assert.rejects(second.listen(), (error) => {
      assert.equal(error.code, 'EADDRINUSE')
      return true
    })
  } finally {
    await first.close()
  }
})
