#!/usr/bin/env node
/**
 * ADR 0001 · F6 listener 产品级证据
 *
 * 以生产 Electron 启动两个隔离场景：
 *  1. external：native sentinel 绝不被执行；/health 与 MCP get_status 均为
 *     disabled；curl POST /events 经 main → renderer 后实证口型上升。
 *  2. automatic + helper 缺失：/health 与 MCP get_status 均为
 *     unavailable/helper-missing，且应用与 external fallback 提示保持可用。
 */

import { execFile, spawn } from 'node:child_process'
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
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let checks = 0
let failures = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ✔ ${label}`)
    return
  }
  failures += 1
  console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function curlJson(url, { method = 'GET', data } = {}) {
  const args = ['-sS', '--noproxy', '*', '-X', method, '-w', '\n%{http_code}']
  if (data !== undefined) {
    args.push('-H', 'content-type: application/json', '--data', JSON.stringify(data))
  }
  args.push(url)
  const { stdout } = await execFileP('curl', args, { maxBuffer: 8 * 1024 * 1024 })
  const splitAt = stdout.lastIndexOf('\n')
  const status = Number(stdout.slice(splitAt + 1).trim())
  const raw = stdout.slice(0, splitAt)
  let body = null
  try {
    body = JSON.parse(raw)
  } catch {
    // 保留 raw 供断言报错。
  }
  return { status, body, raw }
}

async function waitForHealth(baseUrl, predicate = () => true) {
  let last = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      last = await curlJson(`${baseUrl}/health`)
      if (last.status === 200 && predicate(last.body)) return last
    } catch {
      // Electron / bridge 尚未就绪。
    }
    await sleep(200)
  }
  throw new Error(`等待 /health 超时：${last?.raw ?? '无响应'}`)
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text)
}

async function connectMcp(baseUrl, name) {
  const client = new Client({ name, version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
  return client
}

function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  const ready = once(socket, 'open')
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { ready, send, close: () => socket.close() }
}

async function waitForRendererTarget(cdpPort) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find(
          (candidate) => candidate.type === 'page' && candidate.url.startsWith('live2d-app://'),
        )
        if (target) return target
      }
    } catch {
      // CDP 尚未就绪。
    }
    await sleep(200)
  }
  throw new Error('等待 renderer CDP target 超时')
}

async function launchElectron({ name, environment, cdp = false }) {
  const bridgePort = await getFreePort()
  const cdpPort = cdp ? await getFreePort() : null
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `live2d-f6-${name}-`))
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron')
  const args = ['.', `--user-data-dir=${userDataDir}`, '--no-first-run']
  if (cdpPort !== null) args.push(`--remote-debugging-port=${cdpPort}`)
  const child = spawn(electronBin, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      LIVE2D_BRIDGE_PORT: String(bridgePort),
      LIVE2D_RENDERER_LOG: '1',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => {
    log += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += String(chunk)
  })
  const exitPromise = once(child, 'exit')
  return {
    baseUrl: `http://127.0.0.1:${bridgePort}`,
    cdpPort,
    getLog: () => log,
    async close() {
      child.kill('SIGTERM')
      const result = await Promise.race([
        exitPromise.then(([code, signal]) => ({ code, signal })),
        sleep(8_000).then(() => null),
      ])
      if (result === null) child.kill('SIGKILL')
      fs.rmSync(userDataDir, { recursive: true, force: true })
      return result
    },
  }
}

async function runExternalScenario(tempDir) {
  console.log('[proof:external] 启动 external 模式，验证 status + /events 口型…')
  const marker = path.join(tempDir, 'native-helper-was-started')
  const sentinel = path.join(tempDir, 'sentinel-helper.sh')
  fs.writeFileSync(sentinel, `#!/bin/sh\nprintf started > '${marker}'\nexit 9\n`)
  fs.chmodSync(sentinel, 0o755)

  const app = await launchElectron({
    name: 'external',
    cdp: true,
    environment: {
      LIVE2D_VOICE_SOURCE_MODE: 'external',
      LIVE2D_NATIVE_HELPER_PATH: sentinel,
    },
  })
  let client = null
  let cdp = null
  try {
    const health = await waitForHealth(
      app.baseUrl,
      (body) => body?.listener?.status === 'disabled',
    )
    check('/health listener=external/disabled',
      health.body?.listener?.mode === 'external' && health.body?.listener?.status === 'disabled',
      health.raw)
    check('external 未执行 native helper sentinel', !fs.existsSync(marker))

    client = await connectMcp(app.baseUrl, 'f6-external-proof')
    const status = parseToolJson(
      await client.callTool({ name: 'get_status', arguments: {} }),
    )
    check('MCP get_status.listener 与 /health 同为 disabled',
      status.listener?.mode === 'external' && status.listener?.status === 'disabled',
      JSON.stringify(status.listener))

    const target = await waitForRendererTarget(app.cdpPort)
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
      if (result.exceptionDetails) throw new Error('renderer 求值失败')
      return result.result.value
    }
    let debugReady = false
    for (let attempt = 0; attempt < 50 && !debugReady; attempt += 1) {
      debugReady = await evaluate('!!window.__live2dVoiceDebug').catch(() => false)
      if (!debugReady) await sleep(200)
    }
    check('renderer voice 调试快照已挂接', debugReady)
    const before = await evaluate('window.__live2dVoiceDebug.snapshot()')

    const state = await curlJson(`${app.baseUrl}/events`, {
      method: 'POST',
      data: { type: 'state', state: { phase: 'active', activity: 'speaking' } },
    })
    const level = await curlJson(`${app.baseUrl}/events`, {
      method: 'POST',
      data: { type: 'audio-level', level: 0.8 },
    })
    check('external curl POST /events state + level 均为 202',
      state.status === 202 && level.status === 202,
      `${state.status}/${level.status}`)
    await sleep(650)
    const after = await evaluate('window.__live2dVoiceDebug.snapshot()')
    check('/events 经 sendVoiceEvent 抵达 renderer speaking', after.activity === 'speaking', after.activity)
    check('/events level 驱动嘴参显著上升',
      after.smoothedMouth > 0.5 && after.mouthWrites > before.mouthWrites,
      JSON.stringify({ before, after }))
    check('external 场景结束前仍未执行 native helper', !fs.existsSync(marker))
  } finally {
    cdp?.close()
    await client?.close().catch(() => {})
    const exit = await app.close()
    check('external Electron 干净退出',
      exit !== null && !app.getLog().includes('render-process-gone'),
      app.getLog().slice(-500))
  }
}

async function runMissingHelperScenario(tempDir) {
  console.log('[proof:automatic] 启动 automatic + helper 缺失，验证清晰 unavailable…')
  const missingHelper = path.join(tempDir, 'does-not-exist', 'live2d-audio-listener')
  const app = await launchElectron({
    name: 'missing-helper',
    environment: {
      LIVE2D_VOICE_SOURCE_MODE: 'automatic',
      LIVE2D_NATIVE_HELPER_PATH: missingHelper,
    },
  })
  let client = null
  try {
    const health = await waitForHealth(
      app.baseUrl,
      (body) => body?.listener?.detail === 'helper-missing',
    )
    check('/health listener=automatic/unavailable/helper-missing',
      health.body?.listener?.mode === 'automatic' &&
        health.body?.listener?.status === 'unavailable' &&
        health.body?.listener?.detail === 'helper-missing',
      health.raw)
    client = await connectMcp(app.baseUrl, 'f6-missing-helper-proof')
    const status = parseToolJson(
      await client.callTool({ name: 'get_status', arguments: {} }),
    )
    check('MCP get_status.listener 同源显示 helper-missing',
      status.listener?.mode === 'automatic' &&
        status.listener?.status === 'unavailable' &&
        status.listener?.detail === 'helper-missing',
      JSON.stringify(status.listener))
    check('错误摘要提示 external fallback',
      /LIVE2D_VOICE_SOURCE_MODE=external/.test(health.body?.listener?.error ?? '') ||
        app.getLog().includes('automatic/unavailable (helper-missing)'),
      app.getLog().slice(-500))
  } finally {
    await client?.close().catch(() => {})
    const exit = await app.close()
    check('helper 缺失场景 Electron 干净退出',
      exit !== null && !app.getLog().includes('render-process-gone'),
      app.getLog().slice(-500))
  }
}

const distIndex = path.join(ROOT, 'renderer', 'dist', 'index.html')
if (!fs.existsSync(distIndex)) {
  throw new Error('renderer/dist/index.html 不存在，请先运行 npm run build')
}
await execFileP('curl', ['--version'])

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-f6-proof-'))
console.log('=== F6 证据：voice source + main listener 接线 + 真实 status ===')
try {
  await runExternalScenario(tempDir)
  await runMissingHelperScenario(tempDir)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`✘ F6 证据失败：${failures}/${checks} 项断言未过`)
  process.exit(1)
}
console.log(`✔ F6 证据通过（${checks} 项断言）：external /events 口型可用，listener status 真实且失败可区分`)
