#!/usr/bin/env node
/**
 * ADR 0001 · F3 口型证据脚本
 *
 * 用法：
 *   node scripts/f3-lipsync-proof.mjs          # logic 模式（默认，无外部依赖）
 *   node scripts/f3-lipsync-proof.mjs --e2e    # logic + CDP 端到端（需 GUI；先 npm run build）
 *
 * logic 模式：直接 import renderer 口型绑定层（lip-sync.ts，Node type-stripping
 * 加载），用 mock writeMouth + 假钟连发 level/activity，断言：
 *   - level 注入改变嘴参写入值（ParamMouthOpenY 被调用且数值随 level 变化）
 *   - 900ms 短静音保持（speaking 期间 level 归零不立即切回）
 *   - 平滑收敛到 clamp01(level * gain)
 *
 * e2e 模式：LIVE2D_VOICE_INJECT=1 启动 Electron（prod dist，独立 user-data-dir
 * 隔离单实例锁），经 CDP 在页面内调 window.live2d.injectVoice 注入事件
 * （renderer → main 规范化 → 'live2d:voice' 回环，与 F4 推送同路径），
 * 再读 window.__live2dVoiceDebug.snapshot() 断言 activity/smoothed/写入次数变化。
 * 无真实模型时写入为 no-op，但快照的 smoothed/lastMouthWrite 仍证明嘴参目标被驱动。
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FRAME_MS = 16.7

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${label}`)
  } else {
    failures += 1
    console.error(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------- logic 模式
async function runLogic() {
  console.log('[proof:logic] import renderer/src/lip-sync.ts（Node type-stripping）…')
  const { createVoiceLipSync } = await import('../renderer/src/lip-sync.ts')

  const writes = []
  let now = 0
  const lip = createVoiceLipSync({
    mouthParam: { id: 'ParamMouthOpenY', min: 0, max: 1 },
    writeMouth: (paramId, value) => writes.push({ paramId, value }),
    now: () => now,
  })
  const frames = (n) => {
    for (let i = 0; i < n; i++) {
      now += FRAME_MS
      lip.tick(FRAME_MS)
    }
  }

  console.log('[proof:logic] 场景 1：idle 不张嘴 → 注入 level 张嘴')
  frames(10)
  check('idle 时无写入（嘴参目标恒 0）', writes.length === 0, `writes=${writes.length}`)

  lip.handleEvent({ type: 'state', state: { phase: 'active' } })
  frames(5)
  check('listening 仍无写入', writes.length === 0, `writes=${writes.length}`)

  lip.handleEvent({ type: 'audio-level', level: 0.8 })
  frames(30) // ≈500ms，attack 55ms 早应收敛
  const snap1 = lip.snapshot()
  check('level 0.8 → speaking', snap1.activity === 'speaking', snap1.activity)
  check('嘴参被写入（mock setParameter 被调用）', writes.length > 0, `writes=${writes.length}`)
  check(
    '全部写入落在 ParamMouthOpenY',
    writes.every((w) => w.paramId === 'ParamMouthOpenY'),
  )
  check(
    'smoothed 收敛到 clamp01(0.8*2.8)=1',
    Math.abs(snap1.smoothedMouth - 1) < 0.02,
    `smoothed=${snap1.smoothedMouth.toFixed(4)}`,
  )
  check(
    'lastMouthWrite ≈ 1',
    Math.abs(snap1.lastMouthWrite - 1) < 0.02,
    `last=${snap1.lastMouthWrite.toFixed(4)}`,
  )

  console.log('[proof:logic] 场景 2：嘴参值随 level 变化（0.8 → 0.2）')
  lip.handleEvent({ type: 'audio-level', level: 0.2 })
  frames(40)
  const snap2 = lip.snapshot()
  // clamp01(0.2*2.8) = 0.56
  check(
    'level 0.2 → smoothed ≈ 0.56',
    Math.abs(snap2.smoothedMouth - 0.56) < 0.05,
    `smoothed=${snap2.smoothedMouth.toFixed(4)}`,
  )
  const values = new Set(writes.map((w) => w.value.toFixed(3)))
  check('写入值序列随 level 变化（非恒定）', values.size > 2, `distinct=${values.size}`)

  console.log('[proof:logic] 场景 3：900ms 短静音保持')
  lip.handleEvent({ type: 'audio-level', level: 0 })
  frames(30) // ≈500ms < 900ms hold
  check(
    '静音 500ms 内保持 speaking',
    lip.snapshot().activity === 'speaking',
    lip.snapshot().activity,
  )
  check('静音期间嘴参目标平滑回落中', lip.snapshot().smoothedMouth < 0.2,
    `smoothed=${lip.snapshot().smoothedMouth.toFixed(4)}`)
  frames(30) // 累计 ≈1000ms > 900ms hold
  check(
    '静音超 900ms 回落 listening',
    lip.snapshot().activity === 'listening',
    lip.snapshot().activity,
  )
  frames(60)
  check('回落后嘴闭（smoothed → 0）', lip.snapshot().smoothedMouth < 0.01,
    `smoothed=${lip.snapshot().smoothedMouth.toFixed(4)}`)

  console.log('[proof:logic] 场景 4：会话结束立即 idle')
  lip.handleEvent({ type: 'audio-level', level: 0.7 })
  frames(10)
  lip.handleEvent({ type: 'state', state: { phase: 'inactive' } })
  check('session 结束 → idle', lip.snapshot().activity === 'idle', lip.snapshot().activity)

  const snap = lip.snapshot()
  console.log(`[proof:logic] 事件 ${snap.events} 条，嘴参写入 ${snap.mouthWrites} 次`)
  check('事件计数与写入计数合理', snap.events >= 6 && snap.mouthWrites > 10)
}

// ----------------------------------------------------------------- e2e 模式
const CDP_PORT = 9223

async function fetchJson(url, retries = 40, intervalMs = 250) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch {
      // CDP 尚未就绪
    }
    await new Promise((r) => setTimeout(r, intervalMs))
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
  console.log('[proof:e2e] 启动 Electron（LIVE2D_VOICE_INJECT=1，prod dist，隔离 user-data-dir）…')
  const distIndex = path.join(ROOT, 'renderer', 'dist', 'index.html')
  if (!fs.existsSync(distIndex)) {
    throw new Error('renderer/dist/index.html 不存在，请先运行 npm run build')
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live2d-f3-e2e-'))
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron')
  const child = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run'],
    {
      cwd: ROOT,
      env: { ...process.env, LIVE2D_VOICE_INJECT: '1', LIVE2D_RENDERER_LOG: '1' },
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

    // 等 renderer 口型挂接完成
    let injected = false
    for (let i = 0; i < 40 && !injected; i++) {
      injected = await evaluate(
        `typeof window.live2d !== 'undefined' && typeof window.live2d.injectVoice === 'function' && !!window.__live2dVoiceDebug`,
      ).catch(() => false)
      if (!injected) await new Promise((r) => setTimeout(r, 250))
    }
    check('页面内 injectVoice 与调试快照可用', injected === true)

    const snap0 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 初始快照:', JSON.stringify(snap0))
    check('初始 idle 且不张嘴', snap0.activity === 'idle' && snap0.smoothedMouth === 0)
    check('inject 模式已在页面侧生效', snap0.injectEnabled === true)

    // 注入：speaking + level 0.8（走 renderer→main→renderer 完整 IPC 回环）
    const inj1 = await evaluate(
      `window.live2d.injectVoice({ type: 'state', state: { phase: 'active', activity: 'speaking' } })`,
    )
    const inj2 = await evaluate(`window.live2d.injectVoice({ type: 'audio-level', level: 0.8 })`)
    check('injectVoice 受理（浅校验通过）', inj1 === true && inj2 === true)
    await new Promise((r) => setTimeout(r, 500))
    const snap1 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 注入 level 0.8 后 500ms:', JSON.stringify(snap1))
    check('activity → speaking', snap1.activity === 'speaking', snap1.activity)
    check('smoothed 显著上升（> 0.5）', snap1.smoothedMouth > 0.5, `smoothed=${snap1.smoothedMouth}`)
    check('嘴参写入计数递增', snap1.mouthWrites > snap0.mouthWrites,
      `${snap0.mouthWrites} → ${snap1.mouthWrites}`)
    check('事件计数递增', snap1.events > snap0.events, `${snap0.events} → ${snap1.events}`)

    // level 变化 → 嘴参目标值变化
    await evaluate(`window.live2d.injectVoice({ type: 'audio-level', level: 0.2 })`)
    await new Promise((r) => setTimeout(r, 600))
    const snap2 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 注入 level 0.2 后 600ms:', JSON.stringify(snap2))
    check('嘴参目标随 level 下降（< 0.7）', snap2.lastMouthWrite < 0.7,
      `last=${snap2.lastMouthWrite}`)

    // 短静音保持：level 归零后 400ms 仍 speaking
    await evaluate(`window.live2d.injectVoice({ type: 'audio-level', level: 0 })`)
    await new Promise((r) => setTimeout(r, 400))
    const snap3 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 静音后 400ms:', JSON.stringify(snap3))
    check('静音 400ms 内保持 speaking（900ms hold）', snap3.activity === 'speaking', snap3.activity)

    // 超过 900ms → 回落
    await new Promise((r) => setTimeout(r, 800))
    const snap4 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 静音后 ~1200ms:', JSON.stringify(snap4))
    check('静音超 900ms 回落（listening/idle）', snap4.activity !== 'speaking', snap4.activity)

    // 会话结束 → idle
    await evaluate(
      `window.live2d.injectVoice({ type: 'state', state: { phase: 'inactive' } })`,
    )
    await new Promise((r) => setTimeout(r, 300))
    const snap5 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] session inactive 后:', JSON.stringify(snap5))
    check('session 结束 → idle', snap5.activity === 'idle', snap5.activity)
    check('模型状态可见（本环境预期无模型 → 写入 no-op 但目标值仍被驱动）',
      typeof snap5.modelLoaded === 'boolean')

    // 非法注入被 main 规范化拒绝（事件计数不再增长）
    const before = snap5.events
    await evaluate(`window.live2d.injectVoice({ type: 'audio-level', level: 'loud' })`)
    await evaluate(`window.live2d.injectVoice({ type: 'motion', group: 'Idle' })`)
    await new Promise((r) => setTimeout(r, 300))
    const snap6 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    check('非法负载被 main 规范化丢弃', snap6.events === before,
      `events ${before} → ${snap6.events}`)

    check('主进程日志确认注入模式开启', appLog.includes('voice 测试注入已开启'))
  } finally {
    if (cdp) cdp.close()
    child.kill('SIGTERM')
    const code = await Promise.race([
      once(child, 'exit').then(([c]) => c),
      new Promise((r) => setTimeout(() => r('timeout'), 8000)),
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
console.log('=== F3 口型证据：注入 level/activity → 嘴参目标值变化 ===')
await runLogic()
if (withE2e) {
  console.log('')
  await runE2e()
}
console.log('')
if (failures > 0) {
  console.error(`✘ F3 证据失败：${failures} 项断言未过`)
  process.exit(1)
}
console.log('✔ F3 证据通过：注入 level/activity 可改变嘴参目标（mock 与' +
  (withE2e ? ' CDP 端到端' : '') + '证据）')
