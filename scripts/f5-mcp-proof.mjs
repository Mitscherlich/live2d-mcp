#!/usr/bin/env node
/**
 * ADR 0001 · F5 MCP Streamable HTTP 证据脚本
 *
 * 用法：
 *   node scripts/f5-mcp-proof.mjs          # http 模式（默认，无 GUI 依赖）
 *   node scripts/f5-mcp-proof.mjs --e2e    # http + 真 Electron 端到端（需 GUI；先 bun run build）
 *
 * http 模式：进程内 bridge（注入真 mcpHandler + stub controller），用官方
 *   @modelcontextprotocol/sdk client（StreamableHTTPClientTransport）打 /mcp：
 *   - tools/list 恰好含约定 8 工具且无 speak/lip_sync/TTS；instructions 声明不说话
 *   - get_status（read）/ control_window（write）/ set_expression（write）调用证据，
 *     controller stub 真实收到调用；voice 摘要与 bridge /events 同源联动
 *   - 非法参数（priority 越界等）isError 拒绝；无模型时 isError 清晰降级
 *   - curl 原始打面：无 session POST → 400 -32000；坏 JSON → -32700
 *
 * e2e 模式：以生产配置起 Electron（prod dist、隔离 user-data-dir、
 * LIVE2D_BRIDGE_PORT=<临时端口>），MCP client 打真实 /mcp：
 *   - tools/list + get_status（windowVisible / mcp.implemented / model.ready）
 *   - control_window hide → get_status.windowVisible=false → show → true（真实窗口证据）
 *   - set_expression 经 CDP __live2dCommandDebug 断言命令真实到达 renderer；
 *     无模型环境 isError 清晰降级（有模型则 success）
 *   - 非法参数在 MCP 层被拒（renderer 计数不增）
 */

import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { createBridgeServer } = require('../electron/bridge-server.cjs')
const {
  MCP_PATH,
  SERVER_INSTRUCTIONS,
  createLive2dMcpHandler,
} = require('../electron/mcp-server.cjs')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const execFileP = promisify(execFile)

let checks = 0
let failures = 0
function check(label, cond, detail = '') {
  checks += 1
  if (cond) {
    console.log(`  ✔ ${label}`)
  } else {
    failures += 1
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EXPECTED_TOOLS = [
  'get_status',
  'control_window',
  'get_model_info',
  'set_expression',
  'play_motion',
  'look_at',
  'set_parameter',
  'reset',
]

// ----------------------------------------------------------------- curl 封装
/** 真实 curl 调用（--noproxy '*' 直连 loopback，避开本机代理污染） */
async function curlJson(url, { method = 'GET', data, headers = [] } = {}) {
  const args = ['-sS', '--noproxy', '*', '-X', method, '-w', '\n%{http_code}']
  for (const h of headers) args.push('-H', h)
  if (data !== undefined) args.push('-H', 'content-type: application/json', '--data', data)
  args.push(url)
  const { stdout } = await execFileP('curl', args, { maxBuffer: 8 * 1024 * 1024 })
  const idx = stdout.lastIndexOf('\n')
  const status = Number(stdout.slice(idx + 1).trim())
  const raw = stdout.slice(0, idx)
  let body = null
  try {
    body = JSON.parse(raw)
  } catch {
    // 非 JSON 响应
  }
  return { status, body, raw }
}

async function ensureCurl() {
  try {
    const { stdout } = await execFileP('curl', ['--version'])
    console.log(`[proof] ${stdout.split('\n')[0]}`)
  } catch {
    throw new Error('curl 不可用：本脚本要求系统 curl（macOS 自带）')
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text)
}

/** 官方 MCP client 连接指定 /mcp URL */
async function connectMcpClient(url) {
  const client = new Client({ name: 'f5-proof', version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

// ---------------------------------------------------------------- http 模式
async function runHttp() {
  console.log('[proof:http] 进程内起 bridge + 真 mcpHandler（stub controller），MCP client 打 /mcp…')
  const calls = []
  const state = { visible: true, modelLoaded: true }
  const controller = {
    onWindowAction(action) {
      calls.push(['control_window', action])
      if (action === 'show') state.visible = true
      else if (action === 'hide') state.visible = false
      else state.visible = !state.visible
      return state.visible
    },
    // voice 摘要直接取 bridge.getVoiceSummary()——与 main.cjs mcpStatus 同源
    getStatus: () => ({
      windowVisible: state.visible,
      bridge: { port: bridge.address()?.port ?? null },
      voice: bridge.getVoiceSummary(),
      listener: { status: 'disabled', mode: 'external' },
      mcp: { path: MCP_PATH, implemented: true },
      model: state.modelLoaded ? { ready: true } : { ready: false, error: 'Live2D 模型未加载' },
    }),
    getModelInfo: async () =>
      state.modelLoaded
        ? { ok: true, data: { expressions: ['happy'], motionGroups: { Idle: 1 }, parameters: [] } }
        : { ok: false, error: 'Live2D 模型未加载' },
    onExpression: async (expression) => {
      calls.push(['set_expression', expression])
      return state.modelLoaded ? { ok: true } : { ok: false, error: 'Live2D 模型未加载' }
    },
    onMotion: async (params) => {
      calls.push(['play_motion', params])
      return state.modelLoaded ? { ok: true } : { ok: false, error: 'Live2D 模型未加载' }
    },
    onLookAt: async () => ({ ok: true }),
    onParameter: async () => ({ ok: true }),
    onReset: async () => ({ ok: true }),
  }
  const mcpHandler = createLive2dMcpHandler(controller)
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => true,
    getHealth: () => ({
      modelReady: null,
      windowVisible: state.visible,
      voiceInject: false,
      listener: { status: 'disabled', mode: 'external' },
      mcp: {
        path: MCP_PATH,
        implemented: true,
        url: `http://127.0.0.1:${bridge.address()?.port ?? 0}${MCP_PATH}`,
      },
    }),
    mcpHandler,
  })
  const address = await bridge.listen()
  const base = `http://127.0.0.1:${address.port}`
  const client = await connectMcpClient(`${base}${MCP_PATH}`)
  try {
    console.log('[proof:http] 场景 1：initialize + tools/list')
    const serverInfo = client.getServerVersion()
    check('server 名为 live2d 系', serverInfo?.name === 'live2d-companion', JSON.stringify(serverInfo))
    const instructions = client.getInstructions() ?? ''
    check('instructions 声明不说话/不播放 agent 音频',
      instructions === SERVER_INSTRUCTIONS && /不说话/.test(instructions) && /不播放 agent 音频/.test(instructions))
    const { tools } = await client.listTools()
    console.log('[proof:http] tools/list:', tools.map((t) => t.name).join(', '))
    check('tools/list 恰好含约定 8 工具',
      JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...EXPECTED_TOOLS].sort()))
    check('无 speak/lip_sync/TTS 工具或描述痕迹',
      tools.every((t) => !/speak|lip_?sync|tts/i.test(`${t.name} ${t.description ?? ''}`)))

    console.log('[proof:http] 场景 2：get_status（read）')
    const status1 = parseToolJson(await client.callTool({ name: 'get_status', arguments: {} }))
    console.log('[proof:http] get_status:', JSON.stringify(status1))
    check('get_status 含窗口/bridge/voice/listener/mcp/model 字段',
      status1.windowVisible === true &&
        status1.bridge?.port === address.port &&
        status1.voice?.eventsAccepted === 0 &&
        status1.listener?.status === 'disabled' &&
        status1.mcp?.implemented === true &&
        status1.model?.ready === true)
    check('get_status 不含用户内容字段（text/transcript/audio）',
      !('text' in status1) && !('transcript' in status1) && !('audio' in status1))

    console.log('[proof:http] 场景 3：control_window（write）真实作用于 stub 窗口')
    const hide = parseToolJson(await client.callTool({ name: 'control_window', arguments: { action: 'hide' } }))
    check('control_window hide → windowVisible:false',
      hide.success === true && hide.windowVisible === false && state.visible === false)
    const status2 = parseToolJson(await client.callTool({ name: 'get_status', arguments: {} }))
    check('get_status 反映 hide 后状态', status2.windowVisible === false)
    const show = parseToolJson(await client.callTool({ name: 'control_window', arguments: { action: 'show' } }))
    check('control_window show → windowVisible:true', show.windowVisible === true && state.visible === true)

    console.log('[proof:http] 场景 4：set_expression / play_motion（write）抵达 controller')
    const expr = parseToolJson(await client.callTool({ name: 'set_expression', arguments: { expression: 'happy' } }))
    check('set_expression happy → success', expr.success === true)
    const motion = parseToolJson(await client.callTool({
      name: 'play_motion',
      arguments: { group: 'Idle', index: 0, priority: 3 },
    }))
    check('play_motion 参数透传', motion.success === true && motion.priority === 3)
    check('controller 调用序列一致',
      JSON.stringify(calls) === JSON.stringify([
        ['control_window', 'hide'],
        ['control_window', 'show'],
        ['set_expression', 'happy'],
        ['play_motion', { group: 'Idle', index: 0, priority: 3 }],
      ]),
      JSON.stringify(calls))

    console.log('[proof:http] 场景 5：bridge /events → get_status voice 摘要同源联动')
    const event = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({
        type: 'state',
        state: { phase: 'active', activity: 'speaking', microphoneMuted: false, outputMuted: false },
      }),
    })
    check('POST /events → 202', event.status === 202, `status=${event.status}`)
    const status3 = parseToolJson(await client.callTool({ name: 'get_status', arguments: {} }))
    check('get_status voice.activity=speaking（与 bridge 同源）',
      status3.voice?.activity === 'speaking' && status3.voice?.eventsAccepted === 1)

    console.log('[proof:http] 场景 6：非法参数 isError 拒绝，controller 不被触及')
    const before = calls.length
    const badPriority = await client.callTool({
      name: 'play_motion',
      arguments: { group: 'Idle', priority: 9 },
    })
    check('play_motion priority=9 → isError', badPriority.isError === true,
      badPriority.content?.[0]?.text?.slice(0, 120))
    const badAction = await client.callTool({ name: 'control_window', arguments: { action: 'explode' } })
    check('control_window action=explode → isError', badAction.isError === true)
    check('非法调用未抵达 controller', calls.length === before)

    console.log('[proof:http] 场景 7：无模型 → 清晰 isError 降级（不崩溃）')
    state.modelLoaded = false
    const noModelExpr = await client.callTool({ name: 'set_expression', arguments: { expression: 'happy' } })
    check('无模型 set_expression → isError + 清晰错误',
      noModelExpr.isError === true && /模型未加载/.test(noModelExpr.content[0].text))
    const noModelInfo = await client.callTool({ name: 'get_model_info', arguments: {} })
    check('无模型 get_model_info → isError 降级',
      noModelInfo.isError === true && parseToolJson(noModelInfo).success === false)
    const noModelStatus = parseToolJson(await client.callTool({ name: 'get_status', arguments: {} }))
    check('无模型 get_status 仍可用且 model.ready=false', noModelStatus.model?.ready === false)
    state.modelLoaded = true

    console.log('[proof:http] 场景 8：curl 原始打面（无 session / 坏 JSON / health 标记）')
    const noSession = await curlJson(`${base}${MCP_PATH}`, {
      method: 'POST',
      data: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    check('无 session 非 initialize POST → 400 -32000',
      noSession.status === 400 && noSession.body?.error?.code === -32000,
      `status=${noSession.status} body=${noSession.raw}`)
    const badJson = await curlJson(`${base}${MCP_PATH}`, { method: 'POST', data: '{not json' })
    check('坏 JSON → 400 -32700（JSON-RPC parse error）',
      badJson.status === 400 && badJson.body?.error?.code === -32700)
    const health = await curlJson(`${base}/health`)
    check('/health mcp.implemented=true 且 url 指向 /mcp',
      health.body?.mcp?.implemented === true && health.body?.mcp?.url === `${base}${MCP_PATH}`,
      health.raw)
  } finally {
    await client.close()
    await mcpHandler.close()
    await bridge.close()
  }
}

// ----------------------------------------------------------------- e2e 模式
const CDP_PORT = 9225

async function fetchJson(url, retries = 40, intervalMs = 250) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch {
      // CDP 尚未就绪
    }
    await sleep(intervalMs)
  }
  throw new Error(`CDP 不可达: ${url}`)
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
    }
  })
  const ready = once(ws, 'open')
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ready, send, close: () => ws.close() }
}

async function runE2e() {
  const distIndex = path.join(ROOT, 'renderer', 'dist', 'index.html')
  if (!fs.existsSync(distIndex)) {
    throw new Error('renderer/dist/index.html 不存在，请先运行 bun run build')
  }
  const bridgePort = await getFreePort()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-f5-e2e-'))
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron')
  const base = `http://127.0.0.1:${bridgePort}`
  console.log(
    `[proof:e2e] 启动 Electron（prod dist，隔离 user-data-dir，LIVE2D_BRIDGE_PORT=${bridgePort}）…`,
  )
  const child = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        LIVE2D_BRIDGE_PORT: String(bridgePort),
        LIVE2D_RENDERER_LOG: '1',
        LIVE2D_VOICE_SOURCE_MODE: 'external',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let appLog = ''
  child.stdout.on('data', (d) => {
    appLog += String(d)
  })
  child.stderr.on('data', (d) => {
    appLog += String(d)
  })

  let cdp
  let client
  try {
    const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`)
    const page = targets.find((t) => t.type === 'page' && t.url.startsWith('live2d-app://'))
    if (!page) throw new Error(`未找到角色窗 CDP target: ${JSON.stringify(targets.map((t) => t.url))}`)
    cdp = connectCdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')

    const evaluate = async (expr) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      })
      if (result.exceptionDetails) {
        throw new Error(`页面内求值失败: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
      }
      return result.result.value
    }

    // 等 renderer 命令通道挂接
    let attached = false
    for (let i = 0; i < 40 && !attached; i++) {
      attached = await evaluate(`window.__live2dCommandDebug?.snapshot()?.channelAttached === true`).catch(
        () => false,
      )
      if (!attached) await sleep(250)
    }
    check('renderer 命令通道已挂接（__live2dCommandDebug）', attached === true)
    check('主进程日志打印 MCP URL',
      appLog.includes(`MCP Streamable HTTP 已就绪: ${base}${MCP_PATH}`),
      appLog.slice(-500))
    check('主进程日志打印 codex mcp add 连接示例',
      appLog.includes(`codex mcp add live2d --url ${base}${MCP_PATH}`))

    console.log('[proof:e2e] 场景 1：MCP client 连接真 /mcp + tools/list')
    client = await connectMcpClient(`${base}${MCP_PATH}`)
    const { tools } = await client.listTools()
    check('tools/list 恰好含约定 8 工具',
      JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...EXPECTED_TOOLS].sort()),
      tools.map((t) => t.name).join(','))
    check('无 speak/lip_sync/TTS 工具',
      tools.every((t) => !/speak|lip_?sync|tts/i.test(t.name)))
    check('instructions 声明不说话', /不说话/.test(client.getInstructions() ?? ''))

    console.log('[proof:e2e] 场景 2：get_status（read，含 renderer 往返）')
    let status = null
    for (let i = 0; i < 20; i++) {
      status = parseToolJson(await client.callTool({ name: 'get_status', arguments: {} }))
      if (status.windowVisible === true && status.model?.ready !== null) break
      await sleep(250)
    }
    console.log('[proof:e2e] get_status:', JSON.stringify(status))
    check('get_status windowVisible:true', status.windowVisible === true)
    check('get_status bridge.port 正确', status.bridge?.port === bridgePort)
    check('get_status mcp.implemented:true 且 url 正确',
      status.mcp?.implemented === true && status.mcp?.url === `${base}${MCP_PATH}`)
    check('get_status listener 为 external/disabled（F6）',
      status.listener?.status === 'disabled' && status.listener?.mode === 'external')
    const modelReady = status.model?.ready
    check('get_status model.ready 为 renderer 往返真值（布尔，非 null）',
      typeof modelReady === 'boolean', JSON.stringify(status.model))
    if (modelReady === false) {
      console.log('[proof:e2e] 本环境无模型：按缺模口径验证降级（model.ready=false）')
      check('缺模错误信息清晰', /模型未加载/.test(status.model?.error ?? ''), status.model?.error)
    }

    console.log('[proof:e2e] 场景 3：control_window（write）真实作用于角色窗')
    const hide = parseToolJson(await client.callTool({ name: 'control_window', arguments: { action: 'hide' } }))
    check('control_window hide → windowVisible:false', hide.windowVisible === false)
    const statusHidden = parseToolJson(await client.callTool({ name: 'get_status', arguments: {} }))
    check('get_status 确认窗口已隐藏', statusHidden.windowVisible === false)
    const toggle = parseToolJson(await client.callTool({ name: 'control_window', arguments: { action: 'toggle' } }))
    check('control_window toggle → windowVisible:true', toggle.windowVisible === true)
    const statusShown = parseToolJson(await client.callTool({ name: 'get_status', arguments: {} }))
    check('get_status 确认窗口已恢复可见', statusShown.windowVisible === true)

    console.log('[proof:e2e] 场景 4：set_expression（write）经命令通道抵达 renderer')
    const snap0 = await evaluate(`window.__live2dCommandDebug.snapshot()`)
    const expr = await client.callTool({ name: 'set_expression', arguments: { expression: 'happy' } })
    const snap1 = await evaluate(`window.__live2dCommandDebug.snapshot()`)
    console.log('[proof:e2e] set_expression 结果:', expr.content[0].text, '；快照:', JSON.stringify(snap1))
    check('命令真实到达 renderer（counts.setExpression +1）',
      (snap1.counts.setExpression ?? 0) === (snap0.counts.setExpression ?? 0) + 1,
      JSON.stringify(snap1.counts))
    if (modelReady) {
      check('有模型：set_expression success', parseToolJson(expr).success === true)
    } else {
      check('无模型：set_expression isError 清晰降级（不崩溃）',
        expr.isError === true && /模型未加载/.test(expr.content[0].text))
    }

    console.log('[proof:e2e] 场景 5：get_model_info（read 往返）与非法参数拒绝')
    const info = await client.callTool({ name: 'get_model_info', arguments: {} })
    const snap2 = await evaluate(`window.__live2dCommandDebug.snapshot()`)
    check('get_model_info 抵达 renderer（counts.getModelInfo ≥ 1）',
      (snap2.counts.getModelInfo ?? 0) >= 1)
    if (modelReady) {
      check('有模型：get_model_info 返回表情/动作组/参数',
        Array.isArray(parseToolJson(info).modelInfo?.expressions))
    } else {
      check('无模型：get_model_info isError 清晰降级', info.isError === true)
    }
    const beforeBad = snap2.counts.playMotion ?? 0
    const badMotion = await client.callTool({
      name: 'play_motion',
      arguments: { group: 'Idle', priority: 9 },
    })
    const snap3 = await evaluate(`window.__live2dCommandDebug.snapshot()`)
    check('play_motion priority=9 → MCP 层 isError 拒绝', badMotion.isError === true)
    check('非法参数未进入 renderer（counts.playMotion 不增）',
      (snap3.counts.playMotion ?? 0) === beforeBad)

    console.log('[proof:e2e] 场景 6：/health 与 /mcp 同端口共存')
    const health = await curlJson(`${base}/health`)
    check('/health mcp.implemented:true（F5 落地）',
      health.body?.mcp?.implemented === true && health.body?.mcp?.url === `${base}${MCP_PATH}`,
      health.raw)
    const noSession = await curlJson(`${base}${MCP_PATH}`, {
      method: 'POST',
      data: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    check('/mcp 无 session 非 initialize → 400 -32000（不再是固定 404）',
      noSession.status === 400 && noSession.body?.error?.code === -32000)
  } finally {
    if (client) await client.close().catch(() => {})
    if (cdp) cdp.close()
    child.kill('SIGTERM')
    const code = await Promise.race([
      once(child, 'exit').then(([c]) => c),
      sleep(8000).then(() => 'timeout'),
    ])
    if (code === 'timeout') child.kill('SIGKILL')
    fs.rmSync(userDataDir, { recursive: true, force: true })
    const leaked = appLog.includes('render-process-gone')
    check('Electron 干净退出（无 renderer 崩溃）', !leaked)
    console.log('[proof:e2e] Electron 退出码:', code)
  }
}

// --------------------------------------------------------------------- main
const withE2e = process.argv.includes('--e2e')
console.log('=== F5 证据：MCP Streamable HTTP（/mcp）tools/list + 调用 + 降级 ===')
await ensureCurl()
await runHttp()
if (withE2e) {
  console.log('')
  await runE2e()
}
console.log('')
if (failures > 0) {
  console.error(`✘ F5 证据失败：${failures}/${checks} 项断言未过`)
  process.exit(1)
}
console.log(
  `✔ F5 证据通过（${checks} 项断言）：/mcp Streamable HTTP 可用，约定工具可发现可调用，无 speak/TTS` +
    (withE2e ? '，真 Electron 端到端实证窗口控制与 renderer 命令通道' : '（--e2e 可追加真 Electron 端到端证据）'),
)
