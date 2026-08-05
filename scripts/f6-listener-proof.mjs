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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { assertRendererBuilt, launchElectron } from './lib/electron-harness.mjs'
import {
  check,
  connectCdp,
  connectMcpClient,
  createEvaluate,
  curlJson,
  ensureCurl,
  parseToolJson,
  proofCounts,
  sleep,
} from './lib/proof-harness.mjs'

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

/** 与 f3/f4/f5 的 findRendererTarget 不同：这里连 target 出现本身也要重试等待。 */
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

async function runExternalScenario(tempDir) {
  console.log('[proof:external] 启动 external 模式，验证 status + /events 口型…')
  const marker = path.join(tempDir, 'native-helper-was-started')
  const sentinel = path.join(tempDir, 'sentinel-helper.sh')
  fs.writeFileSync(sentinel, `#!/bin/sh\nprintf started > '${marker}'\nexit 9\n`)
  fs.chmodSync(sentinel, 0o755)

  const app = await launchElectron({
    name: 'f6-external',
    cdpPort: 'auto',
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

    client = await connectMcpClient(`${app.baseUrl}/mcp`, 'f6-external-proof')
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
    const evaluate = createEvaluate(cdp)
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
      exit !== null && !app.appLog().includes('render-process-gone'),
      app.appLog().slice(-500))
  }
}

async function runMissingHelperScenario(tempDir) {
  console.log('[proof:automatic] 启动 automatic + helper 缺失，验证清晰 unavailable…')
  const missingHelper = path.join(tempDir, 'does-not-exist', 'live2d-audio-listener')
  const app = await launchElectron({
    name: 'f6-missing-helper',
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
    client = await connectMcpClient(`${app.baseUrl}/mcp`, 'f6-missing-helper-proof')
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
        app.appLog().includes('automatic/unavailable (helper-missing)'),
      app.appLog().slice(-500))
  } finally {
    await client?.close().catch(() => {})
    const exit = await app.close()
    check('helper 缺失场景 Electron 干净退出',
      exit !== null && !app.appLog().includes('render-process-gone'),
      app.appLog().slice(-500))
  }
}

assertRendererBuilt()
await ensureCurl()

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-f6-proof-'))
console.log('=== F6 证据：voice source + main listener 接线 + 真实 status ===')
try {
  await runExternalScenario(tempDir)
  await runMissingHelperScenario(tempDir)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

const { checks, failures } = proofCounts()
if (failures > 0) {
  console.error(`✘ F6 证据失败：${failures}/${checks} 项断言未过`)
  process.exit(1)
}
console.log(`✔ F6 证据通过（${checks} 项断言）：external /events 口型可用，listener status 真实且失败可区分`)
