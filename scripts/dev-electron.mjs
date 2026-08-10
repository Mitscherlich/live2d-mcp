#!/usr/bin/env bun
/**
 * ADR 0001 · F2 · Electron 开发入口（bun run dev / dev:electron）
 *
 * 流程：
 *  1) 若 VITE_DEV_SERVER_URL 已可达则复用（避免 Port already in use）
 *  2) 否则启动 Vite（renderer，默认 127.0.0.1:4000，LIVE2D_DEV_ELECTRON=1）
 *  3) 轮询等待 dev server HTTP 可达
 *  4) 以 VITE_DEV_SERVER_URL 启动 Electron
 *
 * 退出时仅清理本脚本 spawn 的子进程，不杀外部已有 Vite。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = path.join(rootDir, 'renderer')
const DEFAULT_PORT = 4000
const START_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 150

const require = createRequire(import.meta.url)
/** @type {import('node:child_process').ChildProcess[]} */
const children = []
let shuttingDown = false
/** 是否由本脚本拉起 Vite（外部复用时为 false，shutdown 不杀外部进程） */
let ownsVite = false

function parseDevUrl() {
  const raw = process.env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${DEFAULT_PORT}/`
  try {
    const u = new URL(raw)
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
    return { url: u.href.endsWith('/') ? u.href : `${u.href}/`, host: u.hostname, port }
  } catch {
    return { url: `http://127.0.0.1:${DEFAULT_PORT}/`, host: '127.0.0.1', port: DEFAULT_PORT }
  }
}

const DEV = parseDevUrl()

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 300).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function isHttpReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return res.status < 500
  } catch {
    return false
  }
}

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end()
      resolve(true)
    })
    socket.setTimeout(800)
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(false))
  })
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.status < 500) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`等待 Vite dev server 超时（${url}）: ${lastError?.message ?? '无响应'}`)
}

function spawnVite() {
  const vitePkgJson = require.resolve('vite/package.json', { paths: [rendererDir] })
  const viteBin = path.join(path.dirname(vitePkgJson), 'bin', 'vite.js')
  const vite = spawn(process.execPath, [viteBin, '--host', DEV.host, '--port', String(DEV.port)], {
    cwd: rendererDir,
    env: {
      ...process.env,
      LIVE2D_DEV_ELECTRON: '1',
      // 与 parseDevUrl 对齐，便于 vite 内日志
      VITE_DEV_SERVER_URL: DEV.url,
    },
    stdio: 'inherit',
  })
  ownsVite = true
  children.push(vite)
  vite.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev-electron] Vite 提前退出（code ${code}），请检查 renderer 编译错误`)
      shutdown(code ?? 1)
    }
  })
  vite.on('error', (error) => {
    console.error(`[dev-electron] Vite 启动失败: ${error.message}`)
    shutdown(1)
  })
}

function spawnElectron() {
  let electronBin
  try {
    electronBin = require('electron')
  } catch {
    console.error('[dev-electron] 未找到 electron 依赖，请先在仓库根运行 bun install')
    shutdown(1)
    return
  }
  const electron = spawn(electronBin, ['.'], {
    cwd: rootDir,
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV.url },
    stdio: 'inherit',
  })
  children.push(electron)
  electron.on('exit', (code, signal) => {
    console.log(
      `[dev-electron] Electron 退出（code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}）`,
    )
    // 仅当我们拥有 Vite 时一起退出；复用外部 Vite 时也退出 dev 脚本
    shutdown(code ?? 0)
  })
  electron.on('error', (error) => {
    console.error(`[dev-electron] Electron 启动失败: ${error.message}`)
    console.error('[dev-electron] 若提示二进制缺失，请重跑 bun install 以拉取 Electron 运行时')
    shutdown(1)
  })
}

async function main() {
  const alreadyUp = await isHttpReachable(DEV.url)
  if (alreadyUp) {
    console.log(`[dev-electron] 检测到已有 Vite：${DEV.url}，直接复用（不重复绑定端口）`)
  } else {
    const portBusy = await isPortOpen(DEV.host, DEV.port)
    if (portBusy) {
      console.error(
        `[dev-electron] 端口 ${DEV.host}:${DEV.port} 已被占用，且 ${DEV.url} 无法作为 Vite 使用。`,
      )
      console.error(
        `[dev-electron] 请结束占用进程后重试，例如：\n  lsof -nP -iTCP:${DEV.port} -sTCP:LISTEN\n  kill <PID>`,
      )
      console.error(
        `[dev-electron] 或指定其它端口：\n  VITE_DEV_SERVER_URL=http://127.0.0.1:5174/ bun run dev`,
      )
      process.exit(1)
    }
    console.log(`[dev-electron] 启动 Vite（renderer，${DEV.url}）…`)
    spawnVite()
    try {
      await waitForServer(DEV.url, START_TIMEOUT_MS)
    } catch (error) {
      console.error(`[dev-electron] ${error.message}`)
      shutdown(1)
      return
    }
  }

  console.log('[dev-electron] Vite 就绪，启动 Electron…')
  spawnElectron()
}

main().catch((error) => {
  console.error(`[dev-electron] 未预期错误: ${error?.stack ?? error}`)
  shutdown(1)
})
