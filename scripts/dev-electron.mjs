#!/usr/bin/env node
/**
 * ADR 0001 · F2 · Electron 开发入口（npm run dev / dev:electron）
 *
 * 流程：
 *  1) 直接以 Node 启动 Vite（renderer，5173 strictPort，LIVE2D_DEV_ELECTRON=1
 *     关闭自动弹浏览器——窗口由 Electron 承载）
 *  2) 轮询等待 dev server HTTP 可达（避免 Electron 抢跑白屏）
 *  3) 以 VITE_DEV_SERVER_URL 启动 Electron 加载 dev server
 *
 * 任一进程异常退出或 Electron 正常关闭 → 清理另一进程并以其退出码结束。
 * Vite 不经 npm 中转 spawn，保证 SIGTERM 能干净终结，不留孤儿进程。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = path.join(rootDir, 'renderer')
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173/'
const START_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 150

const require = createRequire(import.meta.url)
const children = []
let shuttingDown = false

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  // 给子进程短暂优雅退出窗口后强制结束本进程
  setTimeout(() => process.exit(code), 300).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.status < 500) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`等待 Vite dev server 超时（${url}）: ${lastError?.message ?? '无响应'}`)
}

function spawnVite() {
  // vite 的 package exports 不暴露 ./bin/vite.js（ERR_PACKAGE_PATH_NOT_EXPORTED），
  // 先定位 package.json 再拼接 bin 路径
  const vitePkgJson = require.resolve('vite/package.json', { paths: [rendererDir] })
  const viteBin = path.join(path.dirname(vitePkgJson), 'bin', 'vite.js')
  const vite = spawn(process.execPath, [viteBin], {
    cwd: rendererDir,
    env: { ...process.env, LIVE2D_DEV_ELECTRON: '1' },
    stdio: 'inherit',
  })
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
    // electron 包在纯 Node 下导出其二进制绝对路径
    electronBin = require('electron')
  } catch {
    console.error('[dev-electron] 未找到 electron 依赖，请先在仓库根运行 npm install')
    shutdown(1)
    return
  }
  const electron = spawn(electronBin, ['.'], {
    cwd: rootDir,
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
    stdio: 'inherit',
  })
  children.push(electron)
  electron.on('exit', (code, signal) => {
    console.log(`[dev-electron] Electron 退出（code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}）`)
    shutdown(code ?? 0)
  })
  electron.on('error', (error) => {
    console.error(`[dev-electron] Electron 启动失败: ${error.message}`)
    console.error('[dev-electron] 若提示二进制缺失，请重跑 npm install 以拉取 Electron 运行时')
    shutdown(1)
  })
}

async function main() {
  console.log(`[dev-electron] 启动 Vite（renderer，${DEV_URL}）…`)
  spawnVite()
  try {
    await waitForServer(DEV_URL, START_TIMEOUT_MS)
  } catch (error) {
    console.error(`[dev-electron] ${error.message}`)
    shutdown(1)
    return
  }
  console.log('[dev-electron] Vite 就绪，启动 Electron…')
  spawnElectron()
}

main().catch((error) => {
  console.error(`[dev-electron] 未预期错误: ${error?.stack ?? error}`)
  shutdown(1)
})
