#!/usr/bin/env node
/**
 * ADR 0001 · F4 bridge 证据脚本
 *
 * 用法：
 *   node scripts/f4-bridge-proof.mjs          # http 模式（默认，无 GUI 依赖）
 *   node scripts/f4-bridge-proof.mjs --e2e    # http + curl→Electron 端到端（需 GUI；先 npm run build）
 *
 * http 模式：进程内起 bridge（临时端口），用真实 curl 打 /health 与 /events，断言：
 *   - /health 200 JSON（ok/bridgePort/voice 摘要）
 *   - 合法 state/audio-level → 202，且 onEvent 收到的负载与权威 normalizeVoiceEvent
 *     输出深相等（bridge 不存在第二套校验的直接证据）
 *   - level clamp [0,1]；非法 JSON 400；非法事件 422；非 loopback Host 403；/mcp 404(F5)
 *
 * e2e 模式：以生产配置起 Electron（prod dist、隔离 user-data-dir、
 * LIVE2D_BRIDGE_PORT=<临时端口>，**不开** LIVE2D_VOICE_INJECT），然后全部经
 * curl 注入：POST /events state+audio-level → 走 bridge → sendVoiceEvent →
 * preload → F3 状态机 → 嘴参；经 CDP 读 window.__live2dVoiceDebug.snapshot()
 * 断言 activity/smoothedMouth/mouthWrites 变化——即「curl 端到端口型」证据。
 * 无真实模型时写入为 no-op，但快照的 smoothed/lastMouthWrite 仍证明嘴参目标被驱动
 * （与 F3 e2e 同一证据口径）。
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
const { normalizeVoiceEvent } = require('../electron/voice-events.cjs')
const execFileP = promisify(execFile)

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${label}`)
  } else {
    failures += 1
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ----------------------------------------------------------------- curl 封装
/** 真实 curl 调用；返回 { status, body, raw }（body 解析失败为 null）。
 *  --noproxy '*' 强制直连 loopback：本机若设 http_proxy，自定义 Host 的用例
 *  会被代理按 Host 路由而到不了 bridge。 */
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
    // 非 JSON 响应（如 204 空体）
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

// ---------------------------------------------------------------- http 模式
async function runHttp() {
  console.log('[proof:http] 进程内起 bridge（临时端口），curl 打 /health 与 /events…')
  const received = []
  const bridge = createBridgeServer({
    port: 0,
    onEvent: (event) => {
      received.push(event)
      return true
    },
    getHealth: () => ({
      modelReady: null,
      windowVisible: true,
      listener: { status: 'not-started', mode: 'external' },
      mcp: { path: '/mcp', implemented: false },
    }),
  })
  const address = await bridge.listen()
  const base = `http://127.0.0.1:${address.port}`
  try {
    console.log('[proof:http] 场景 1：GET /health')
    const health0 = await curlJson(`${base}/health`)
    check('GET /health → 200', health0.status === 200, `status=${health0.status}`)
    check('/health JSON ok:true', health0.body?.ok === true, health0.raw)
    check('/health bridgePort 为实际端口', health0.body?.bridgePort === address.port)
    check('/health 初始 voice 摘要为空', health0.body?.voice?.eventsAccepted === 0)
    check('/health 含窗口/listener/mcp 摘要（尽力而为，不含用户内容）',
      health0.body?.windowVisible === true &&
        health0.body?.listener?.mode === 'external' &&
        health0.body?.mcp?.implemented === false)

    console.log('[proof:http] 场景 2：POST /events 合法事件 → onEvent 与 normalizeVoiceEvent 同源')
    const stateRaw = {
      type: 'state',
      state: { phase: 'active', activity: 'speaking', microphoneMuted: false, outputMuted: false },
    }
    const r1 = await curlJson(`${base}/events`, { method: 'POST', data: JSON.stringify(stateRaw) })
    check('POST state → 202', r1.status === 202, `status=${r1.status} body=${r1.raw}`)
    check('202 响应体 {"accepted":true}', r1.body?.accepted === true)

    const r2 = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'audio-level', level: 0.8 }),
    })
    check('POST audio-level 0.8 → 202', r2.status === 202)

    const r3 = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'audio-level', level: 42 }),
    })
    check('POST audio-level 42（越界）→ 202', r3.status === 202)

    check('onEvent 被调用 3 次', received.length === 3, `received=${received.length}`)
    check(
      'onEvent[0] 与 normalizeVoiceEvent(stateRaw) 深相等（无第二套校验）',
      JSON.stringify(received[0]) === JSON.stringify(normalizeVoiceEvent(stateRaw)),
      JSON.stringify(received[0]),
    )
    check('onEvent[1] level 原样 0.8', received[1]?.level === 0.8)
    check('onEvent[2] level clamp 到 1（SPEC §8.2）', received[2]?.level === 1)

    const health1 = await curlJson(`${base}/health`)
    check('voice 摘要更新：activity=speaking', health1.body?.voice?.activity === 'speaking')
    check('voice 摘要更新：lastLevel=1', health1.body?.voice?.lastLevel === 1)
    check('voice 摘要更新：eventsAccepted=3', health1.body?.voice?.eventsAccepted === 3)

    console.log('[proof:http] 场景 3：非法输入全部 4xx 且不崩溃')
    const badEvent = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'audio-level', level: 'loud' }),
    })
    check('非法事件（level 非数字）→ 422', badEvent.status === 422, `status=${badEvent.status}`)
    const badJson = await curlJson(`${base}/events`, { method: 'POST', data: '{not json' })
    check('非法 JSON → 400', badJson.status === 400, `status=${badJson.status}`)
    const health2 = await curlJson(`${base}/health`)
    check('eventsRejected=2', health2.body?.voice?.eventsRejected === 2)

    console.log('[proof:http] 场景 4：loopback 安全约束')
    const evilHost = await curlJson(`${base}/health`, { headers: ['Host: evil.com'] })
    check('非 loopback Host → 403', evilHost.status === 403, `status=${evilHost.status}`)
    const evilOrigin = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'audio-level', level: 0.5 }),
      headers: ['Origin: https://evil.com'],
    })
    check('非受信 Origin → 403', evilOrigin.status === 403, `status=${evilOrigin.status}`)

    console.log('[proof:http] 场景 5：/mcp 本片明确未实现（F5）')
    const mcp = await curlJson(`${base}/mcp`, { method: 'POST', data: '{}' })
    check('/mcp → 404 且标注 F5',
      mcp.status === 404 && mcp.body?.error === 'mcp not implemented (F5)',
      `status=${mcp.status} body=${mcp.raw}`)
  } finally {
    await bridge.close()
  }
}

// ----------------------------------------------------------------- e2e 模式
const CDP_PORT = 9224

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
    throw new Error('renderer/dist/index.html 不存在，请先运行 npm run build')
  }
  const bridgePort = await getFreePort()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-f4-e2e-'))
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron')
  const base = `http://127.0.0.1:${bridgePort}`
  console.log(
    `[proof:e2e] 启动 Electron（prod dist，隔离 user-data-dir，LIVE2D_BRIDGE_PORT=${bridgePort}，不开注入）…`,
  )
  const child = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run'],
    {
      cwd: ROOT,
      // 生产配置：不开 LIVE2D_VOICE_INJECT——证明 bridge 路径不依赖测试注入面
      env: { ...process.env, LIVE2D_BRIDGE_PORT: String(bridgePort), LIVE2D_RENDERER_LOG: '1' },
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

    // 等 renderer 口型挂接完成（快照调试钩子在 Electron 模式无条件存在）
    let ready = false
    for (let i = 0; i < 40 && !ready; i++) {
      ready = await evaluate(`!!window.__live2dVoiceDebug`).catch(() => false)
      if (!ready) await sleep(250)
    }
    check('页面内口型调试快照可用', ready === true)
    check('主进程日志确认 bridge 监听（仅 loopback）',
      appLog.includes(`bridge 已监听（仅 loopback）: http://127.0.0.1:${bridgePort}/health`),
      appLog.slice(-400))
    check('未开启测试注入面（生产配置）', !appLog.includes('voice 测试注入已开启'))

    console.log('[proof:e2e] 场景 1：curl /health')
    let health = null
    for (let i = 0; i < 20; i++) {
      health = await curlJson(`${base}/health`)
      if (health.status === 200 && health.body?.windowVisible === true) break
      await sleep(250)
    }
    console.log('[proof:e2e] /health 响应:', health.raw)
    check('GET /health → 200', health.status === 200, `status=${health.status}`)
    check('/health ok:true 且 bridgePort 正确',
      health.body?.ok === true && health.body?.bridgePort === bridgePort)
    check('/health windowVisible:true（窗口已显示）', health.body?.windowVisible === true)
    check('/health modelReady 明确为 null（main 侧 unknown）', health.body?.modelReady === null)
    check('/health 声明 listener 未启动（F6）与 mcp 未实现（F5）',
      health.body?.listener?.status === 'not-started' &&
        health.body?.mcp?.implemented === false)

    const snap0 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 初始快照:', JSON.stringify(snap0))
    check('初始 idle 且不张嘴', snap0.activity === 'idle' && snap0.smoothedMouth === 0)

    console.log('[proof:e2e] 场景 2：curl POST /events 注入 state + level 0.8')
    const post1 = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({
        type: 'state',
        state: { phase: 'active', activity: 'speaking', microphoneMuted: false, outputMuted: false },
      }),
    })
    const post2 = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'audio-level', level: 0.8 }),
    })
    check('curl POST state → 202', post1.status === 202, `status=${post1.status}`)
    check('curl POST audio-level → 202', post2.status === 202, `status=${post2.status}`)

    await sleep(600)
    const snap1 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 注入 level 0.8 后 600ms:', JSON.stringify(snap1))
    check('renderer activity → speaking', snap1.activity === 'speaking', snap1.activity)
    check('嘴参 smoothed 显著上升（> 0.5）', snap1.smoothedMouth > 0.5,
      `smoothed=${snap1.smoothedMouth}`)
    check('嘴参写入计数递增', snap1.mouthWrites > snap0.mouthWrites,
      `${snap0.mouthWrites} → ${snap1.mouthWrites}`)
    check('事件计数递增（bridge → sendVoiceEvent → preload → 状态机）',
      snap1.events > snap0.events, `${snap0.events} → ${snap1.events}`)

    console.log('[proof:e2e] 场景 3：curl 注入 level 0.2 → 嘴参目标随 level 变化')
    await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'audio-level', level: 0.2 }),
    })
    await sleep(600)
    const snap2 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 注入 level 0.2 后 600ms:', JSON.stringify(snap2))
    check('嘴参目标随 level 下降（< 0.7）', snap2.lastMouthWrite < 0.7,
      `last=${snap2.lastMouthWrite}`)

    console.log('[proof:e2e] 场景 4：curl 非法事件被拒且 renderer 不受影响')
    const bad = await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'audio-level', level: 'loud' }),
    })
    check('非法事件 → 422', bad.status === 422, `status=${bad.status}`)
    await sleep(300)
    const snap3 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    check('非法负载未进入 renderer（events 不增）', snap3.events === snap2.events,
      `events ${snap2.events} → ${snap3.events}`)

    console.log('[proof:e2e] 场景 5：curl 验证 loopback 安全与 F5 占位')
    const evilHost = await curlJson(`${base}/health`, { headers: ['Host: evil.com'] })
    check('非 loopback Host → 403', evilHost.status === 403, `status=${evilHost.status}`)
    const mcp = await curlJson(`${base}/mcp`, { method: 'POST', data: '{}' })
    check('/mcp → 404 标注 F5',
      mcp.status === 404 && mcp.body?.error === 'mcp not implemented (F5)')

    console.log('[proof:e2e] 场景 6：curl 注入 session 结束 → idle')
    await curlJson(`${base}/events`, {
      method: 'POST',
      data: JSON.stringify({ type: 'state', state: { phase: 'inactive' } }),
    })
    await sleep(400)
    const snap4 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] session inactive 后:', JSON.stringify(snap4))
    check('session 结束 → idle', snap4.activity === 'idle', snap4.activity)

    const healthFinal = await curlJson(`${base}/health`)
    console.log('[proof:e2e] 最终 /health:', healthFinal.raw)
    check('voice 摘要计数与注入一致（accepted=4, rejected=1）',
      healthFinal.body?.voice?.eventsAccepted === 4 &&
        healthFinal.body?.voice?.eventsRejected === 1,
      healthFinal.raw)
  } finally {
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
console.log('=== F4 bridge 证据：curl → /health + /events → voice 事件 → 口型 ===')
await ensureCurl()
await runHttp()
if (withE2e) {
  console.log('')
  await runE2e()
}
console.log('')
if (failures > 0) {
  console.error(`✘ F4 证据失败：${failures} 项断言未过`)
  process.exit(1)
}
console.log('✔ F4 证据通过：curl /health 可用，/events 经 bridge → onEvent 与权威规范化同源' +
  (withE2e ? '，且 CDP 端到端实证口型被驱动' : '（--e2e 可追加 GUI 端到端口型证据）'))
