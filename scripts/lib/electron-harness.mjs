/**
 * ADR 0001 · proof 脚本共享 Electron 启动器
 *
 * 四个证据脚本都以「生产配置起一个隔离的 Electron」为前提：临时 user-data-dir
 * 绕开单实例锁、node_modules/.bin/electron 直起、stdout/stderr 聚合成 appLog
 * 供日志断言、退出时 SIGTERM → 超时 SIGKILL → 清理临时目录。
 * 这里是那套模板的唯一实现。
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getFreePort, sleep } from './proof-harness.mjs'

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 证据脚本一律跑 prod dist（不是 dev server），缺产物直接给出可执行的修复指令。 */
export function assertRendererBuilt() {
  const distIndex = path.join(ROOT, 'renderer', 'dist', 'index.html')
  if (!fs.existsSync(distIndex)) {
    throw new Error('renderer/dist/index.html 不存在，请先运行 bun run build')
  }
}

/**
 * 起一个隔离的生产 Electron。
 *
 * @param {object} options
 * @param {string} options.name          user-data-dir 前缀（live2d-<name>-xxxx）
 * @param {object} [options.environment] 追加/覆盖环境变量
 * @param {number|'auto'|null} [options.bridgePort]
 *        'auto' 取空闲端口并注入 LIVE2D_BRIDGE_PORT；数字直接用；null 不注入（走默认端口）
 * @param {number|'auto'|null} [options.cdpPort]
 *        'auto' 取空闲端口；数字直接用；null 不开 --remote-debugging-port
 * @param {string[]} [options.extraArgs] 追加的 Electron 命令行参数
 * @returns {Promise<{child, bridgePort, baseUrl, cdpPort, userDataDir, appLog, close}>}
 *   close() 返回 { code, signal }；超时被 SIGKILL 则返回 null。
 */
export async function launchElectron({
  name,
  environment = {},
  bridgePort = 'auto',
  cdpPort = null,
  extraArgs = [],
  shutdownTimeoutMs = 8_000,
} = {}) {
  assertRendererBuilt()
  const resolvedBridgePort = bridgePort === 'auto' ? await getFreePort() : bridgePort
  const resolvedCdpPort = cdpPort === 'auto' ? await getFreePort() : cdpPort
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `live2d-${name}-`))
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron')

  const args = ['.', `--user-data-dir=${userDataDir}`, '--no-first-run', ...extraArgs]
  if (resolvedCdpPort !== null) args.push(`--remote-debugging-port=${resolvedCdpPort}`)

  const child = spawn(electronBin, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      LIVE2D_RENDERER_LOG: '1',
      ...(resolvedBridgePort === null
        ? {}
        : { LIVE2D_BRIDGE_PORT: String(resolvedBridgePort) }),
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
  // 在 spawn 时就挂上，避免 close() 之前进程已退出导致漏掉 exit 事件。
  const exited = once(child, 'exit')

  return {
    child,
    bridgePort: resolvedBridgePort,
    baseUrl: resolvedBridgePort === null ? null : `http://127.0.0.1:${resolvedBridgePort}`,
    cdpPort: resolvedCdpPort,
    userDataDir,
    appLog: () => log,
    async close() {
      child.kill('SIGTERM')
      const result = await Promise.race([
        exited.then(([code, signal]) => ({ code, signal })),
        sleep(shutdownTimeoutMs).then(() => null),
      ])
      if (result === null) child.kill('SIGKILL')
      fs.rmSync(userDataDir, { recursive: true, force: true })
      return result
    },
  }
}
