/**
 * ADR 0001 · proof 脚本共享 harness
 *
 * 四个产品级证据脚本（f3/f4/f5/f6）此前各自复制了同一批辅助函数，且已经开始
 * 漂移（check 有的计数有的不计数、curlJson 两种签名、connectCdp 三份逐字相同）。
 * 这里收敛成单一实现，让「证据脚本」之间的断言口径一致、失败信息一致。
 *
 * 各脚本的**断言内容**仍然各自硬编码，不共享期望值——证据脚本互相独立才有证明力。
 */

import { execFile } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const execFileP = promisify(execFile)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------------- 断言计数

let checks = 0
let failures = 0

/** 记一条断言：通过打 ✔，失败打 ✘ 并累计到 failures（进程退出码由脚本尾部据此决定）。 */
export function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ✔ ${label}`)
    return
  }
  failures += 1
  console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
}

/** 脚本尾部取汇总：{ checks, failures }。 */
export function proofCounts() {
  return { checks, failures }
}

// --------------------------------------------------------------------- 网络

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 真实 curl 调用；返回 { status, body, raw }（body 解析失败为 null）。
 *
 * --noproxy '*' 强制直连 loopback：本机若设 http_proxy，自定义 Host 的用例会被
 * 代理按 Host 路由而到不了 bridge。
 *
 * data 为字符串时原样发送（用于「坏 JSON → 400」这类需要非法负载的用例），
 * 其余类型内部 JSON.stringify。headers 为 ['Name: value'] 形式。
 */
export async function curlJson(url, { method = 'GET', data, headers = [] } = {}) {
  const args = ['-sS', '--noproxy', '*', '-X', method, '-w', '\n%{http_code}']
  for (const header of headers) args.push('-H', header)
  if (data !== undefined) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    args.push('-H', 'content-type: application/json', '--data', payload)
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
    // 非 JSON 响应（如 204 空体）；保留 raw 供断言报错。
  }
  return { status, body, raw }
}

export async function ensureCurl() {
  try {
    const { stdout } = await execFileP('curl', ['--version'])
    console.log(`[proof] ${stdout.split('\n')[0]}`)
  } catch {
    throw new Error('curl 不可用：本脚本要求系统 curl（macOS 自带）')
  }
}

// ----------------------------------------------------------------------- CDP

/** 轮询 GET JSON，直到 200 或重试耗尽（Electron 起 CDP 需要时间）。 */
export async function fetchJson(url, retries = 40, intervalMs = 250) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      // CDP 尚未就绪
    }
    await sleep(intervalMs)
  }
  throw new Error(`CDP 不可达: ${url}`)
}

/** 等 CDP 可达后取角色窗（live2d-app://）target；无该 target 立即抛错并打印候选。 */
export async function findRendererTarget(cdpPort) {
  const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`)
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('live2d-app://'))
  if (!page) {
    throw new Error(`未找到角色窗 CDP target: ${JSON.stringify(targets.map((t) => t.url))}`)
  }
  return page
}

/** 极简 CDP 客户端：{ ready, send(method, params), close() }。 */
export function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id === undefined || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`))
    else resolve(message.result)
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

/** 绑定一个 CDP 连接的页面内求值器：抛错时带上 exceptionDetails 便于定位。 */
export function createEvaluate(cdp) {
  return async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(`页面内求值失败: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
    }
    return result.result.value
  }
}

// ----------------------------------------------------------------------- MCP

/** MCP 工具结果（text content）解析为 JSON。 */
export function parseToolJson(result) {
  return JSON.parse(result.content[0].text)
}

/** 官方 @modelcontextprotocol/sdk client 连接指定 /mcp URL（Streamable HTTP）。 */
export async function connectMcpClient(url, name = 'live2d-proof') {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const {
    StreamableHTTPClientTransport,
  } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name, version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}
