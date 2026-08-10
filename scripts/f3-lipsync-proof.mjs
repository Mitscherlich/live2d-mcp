#!/usr/bin/env node
/**
 * ADR 0001 · F3 口型证据脚本
 *
 * 用法：
 *   node scripts/f3-lipsync-proof.mjs          # logic 模式（默认，无外部依赖）
 *   node scripts/f3-lipsync-proof.mjs --e2e    # logic + CDP 端到端（需 GUI；先 bun run build）
 *
 * logic 模式：直接 import renderer 口型绑定层（lip-sync.ts，Node type-stripping
 * 加载），用 mock writeMouth + 假钟连发 level/activity，断言：
 *   - level 注入驱动多维嘴参（ParamMouthOpenY + ParamMouthForm）
 *   - 峰值 cap（默认 0.62）、静音归零、900ms silenceHold
 *   - 伪 viseme 相位使 form 非恒定
 *
 * e2e 模式：LIVE2D_VOICE_INJECT=1 启动 Electron（prod dist，独立 user-data-dir
 * 隔离单实例锁），经 CDP 在页面内调 window.live2d.injectVoice 注入事件
 * （renderer → main 规范化 → 'live2d:voice' 回环，与 F4 推送同路径），
 * 再读 window.__live2dVoiceDebug.snapshot() 断言 activity/smoothed/写入次数变化。
 * 无真实模型时写入为 no-op，但快照的 smoothed/lastMouthWrite 仍证明嘴参目标被驱动。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchElectron } from './lib/electron-harness.mjs'
import {
  check,
  connectCdp,
  createEvaluate,
  findRendererTarget,
  proofCounts,
  sleep,
} from './lib/proof-harness.mjs'

const FRAME_MS = 16.7
const PEAK_CAP = 0.62

// 可选：将 mouth writes 快照落到环境变量指定路径（goal 验证用）
const MOUTH_WRITES_OUT = process.env.LIVE2D_F3_MOUTH_WRITES_OUT || ''

// ---------------------------------------------------------------- logic 模式
async function runLogic() {
  console.log('[proof:logic] import renderer/src/lip-sync.ts（Node type-stripping）…')
  const { createVoiceLipSync } = await import('../renderer/src/lip-sync.ts')
  const { selectVoiceBodyMotion, VOICE_DEFAULTS } = await import(
    '../renderer/src/voice-state.ts'
  )

  const writes = []
  let now = 0
  const lip = createVoiceLipSync({
    mouthParam: { id: 'ParamMouthOpenY', min: 0, max: 1 },
    formParam: { id: 'ParamMouthForm', min: -1, max: 1 },
    writeMouth: (paramId, value) => writes.push({ t: now, paramId, value }),
    now: () => now,
  })
  const frames = (n) => {
    for (let i = 0; i < n; i++) {
      now += FRAME_MS
      lip.tick(FRAME_MS)
    }
  }

  console.log('[proof:logic] 场景 1：idle 不张嘴 → 注入 level 张嘴（多维）')
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

  const openIds = writes.filter((w) => w.paramId === 'ParamMouthOpenY')
  const formIds = writes.filter((w) => w.paramId === 'ParamMouthForm')
  check('写入包含 ParamMouthOpenY', openIds.length > 0, `openWrites=${openIds.length}`)
  check('写入包含 ParamMouthForm（多维）', formIds.length > 0, `formWrites=${formIds.length}`)
  check(
    '开合不超过 peakCap(+tol)',
    openIds.every((w) => w.value <= PEAK_CAP + 0.02),
    `maxOpen=${Math.max(...openIds.map((w) => w.value)).toFixed(3)}`,
  )
  check(
    'smoothed 收敛到 clamp01(0.8*2.8)=1',
    Math.abs(snap1.smoothedMouth - 1) < 0.02,
    `smoothed=${snap1.smoothedMouth.toFixed(4)}`,
  )
  check(
    'lastMouthWrite ≤ peakCap（非满量程 1）',
    snap1.lastMouthWrite <= PEAK_CAP + 0.02,
    `last=${snap1.lastMouthWrite.toFixed(4)}`,
  )

  console.log('[proof:logic] 场景 2：嘴参随 level / 相位变化（0.8 → 0.2）')
  const formBefore = formIds.map((w) => w.value)
  lip.handleEvent({ type: 'audio-level', level: 0.2 })
  frames(40)
  const snap2 = lip.snapshot()
  // clamp01(0.2*2.8) = 0.56 strength；open 经 cap/flutter 更低
  check(
    'level 0.2 → smoothed ≈ 0.56',
    Math.abs(snap2.smoothedMouth - 0.56) < 0.05,
    `smoothed=${snap2.smoothedMouth.toFixed(4)}`,
  )
  const openValues = new Set(
    writes.filter((w) => w.paramId === 'ParamMouthOpenY').map((w) => w.value.toFixed(3)),
  )
  check('开合写入值序列非恒定', openValues.size > 2, `distinctOpen=${openValues.size}`)
  const formValues = new Set(
    writes.filter((w) => w.paramId === 'ParamMouthForm').map((w) => w.value.toFixed(2)),
  )
  check('嘴形写入值随相位变化（非恒定）', formValues.size > 2, `distinctForm=${formValues.size}`)
  check(
    'form 快照字段存在且 phase 推进',
    typeof snap2.lastFormWrite === 'number' && snap2.phase > 0,
    `form=${snap2.lastFormWrite} phase=${snap2.phase}`,
  )
  check(
    'speaking 期间 form 相对 formBefore 有新增写入',
    writes.filter((w) => w.paramId === 'ParamMouthForm').length > formBefore.length,
  )

  console.log('[proof:logic] 场景 3：900ms 短静音保持')
  lip.handleEvent({ type: 'audio-level', level: 0 })
  frames(30) // ≈500ms < 900ms hold
  check(
    '静音 500ms 内保持 speaking',
    lip.snapshot().activity === 'speaking',
    lip.snapshot().activity,
  )
  check(
    '静音期间嘴参目标平滑回落中',
    lip.snapshot().smoothedMouth < 0.2,
    `smoothed=${lip.snapshot().smoothedMouth.toFixed(4)}`,
  )
  frames(30) // 累计 ≈1000ms > 900ms hold
  check(
    '静音超 900ms 回落 listening',
    lip.snapshot().activity === 'listening',
    lip.snapshot().activity,
  )
  frames(60)
  check(
    '回落后嘴闭（smoothed → 0）',
    lip.snapshot().smoothedMouth < 0.01,
    `smoothed=${lip.snapshot().smoothedMouth.toFixed(4)}`,
  )
  check(
    '回落后 form 趋近中性/0',
    Math.abs(lip.snapshot().lastFormWrite) < 0.08,
    `form=${lip.snapshot().lastFormWrite}`,
  )

  console.log('[proof:logic] 场景 4：会话结束立即 idle')
  lip.handleEvent({ type: 'audio-level', level: 0.7 })
  frames(10)
  lip.handleEvent({ type: 'state', state: { phase: 'inactive' } })
  check('session 结束 → idle', lip.snapshot().activity === 'idle', lip.snapshot().activity)

  console.log('[proof:logic] 场景 5：speaking/idle 体态选择可区分（Hiyori Idle-only）')
  const bodySpeaking = selectVoiceBodyMotion('speaking')
  const bodyIdle = selectVoiceBodyMotion('idle')
  check('body group 均为 Idle（资产限制）', bodySpeaking.group === 'Idle' && bodyIdle.group === 'Idle')
  check(
    'speaking 与 idle 的 index/priority 不同',
    bodySpeaking.index !== bodyIdle.index || bodySpeaking.priority !== bodyIdle.priority,
    JSON.stringify({ bodySpeaking, bodyIdle }),
  )
  check('VOICE_DEFAULTS.peakCap === 0.62', VOICE_DEFAULTS.peakCap === PEAK_CAP)

  const snap = lip.snapshot()
  console.log(
    `[proof:logic] 事件 ${snap.events} 条，嘴参写入 ${snap.mouthWrites} 次` +
      `（open=${snap.openWrites}, form=${snap.formWrites}）`,
  )
  check(
    '事件计数与多维写入计数合理',
    snap.events >= 6 && snap.openWrites > 5 && snap.formWrites > 2,
  )

  if (MOUTH_WRITES_OUT) {
    mkdirSync(dirname(MOUTH_WRITES_OUT), { recursive: true })
    writeFileSync(
      MOUTH_WRITES_OUT,
      JSON.stringify(
        {
          writes,
          snapshot: snap,
          body: { speaking: bodySpeaking, idle: bodyIdle },
          peakCap: PEAK_CAP,
        },
        null,
        2,
      ),
    )
    console.log(`[proof:logic] mouth writes → ${MOUTH_WRITES_OUT}`)
  }
}

// ----------------------------------------------------------------- e2e 模式
const CDP_PORT = 9223

async function runE2e() {
  console.log('[proof:e2e] 启动 Electron（LIVE2D_VOICE_INJECT=1，prod dist，隔离 user-data-dir）…')
  // bridgePort=null：F3 只走 renderer→main→renderer 的注入回环，不依赖 bridge 端口。
  const app = await launchElectron({
    name: 'f3-e2e',
    bridgePort: null,
    cdpPort: CDP_PORT,
    environment: { LIVE2D_VOICE_INJECT: '1' },
  })

  let cdp
  try {
    const page = await findRendererTarget(CDP_PORT)
    cdp = connectCdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    const evaluate = createEvaluate(cdp)

    // 等 renderer 口型挂接完成
    let injected = false
    for (let i = 0; i < 40 && !injected; i++) {
      injected = await evaluate(
        `typeof window.live2d !== 'undefined' && typeof window.live2d.injectVoice === 'function' && !!window.__live2dVoiceDebug`,
      ).catch(() => false)
      if (!injected) await sleep(250)
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
    await sleep(500)
    const snap1 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 注入 level 0.8 后 500ms:', JSON.stringify(snap1))
    check('activity → speaking', snap1.activity === 'speaking', snap1.activity)
    check('smoothed 显著上升（> 0.5）', snap1.smoothedMouth > 0.5, `smoothed=${snap1.smoothedMouth}`)
    check(
      '嘴参写入计数递增',
      snap1.mouthWrites > snap0.mouthWrites,
      `${snap0.mouthWrites} → ${snap1.mouthWrites}`,
    )
    check('事件计数递增', snap1.events > snap0.events, `${snap0.events} → ${snap1.events}`)
    if (typeof snap1.phase === 'number') {
      check('伪 viseme phase 推进', snap1.phase > 0, `phase=${snap1.phase}`)
    }

    // level 变化 → 嘴参目标值变化
    await evaluate(`window.live2d.injectVoice({ type: 'audio-level', level: 0.2 })`)
    await sleep(600)
    const snap2 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 注入 level 0.2 后 600ms:', JSON.stringify(snap2))
    check(
      '嘴参目标随 level 下降（< 0.7）',
      snap2.lastMouthWrite < 0.7,
      `last=${snap2.lastMouthWrite}`,
    )

    // 短静音保持：level 归零后 400ms 仍 speaking
    await evaluate(`window.live2d.injectVoice({ type: 'audio-level', level: 0 })`)
    await sleep(400)
    const snap3 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 静音后 400ms:', JSON.stringify(snap3))
    check('静音 400ms 内保持 speaking（900ms hold）', snap3.activity === 'speaking', snap3.activity)

    // 超过 900ms → 回落
    await sleep(800)
    const snap4 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] 静音后 ~1200ms:', JSON.stringify(snap4))
    check('静音超 900ms 回落（listening/idle）', snap4.activity !== 'speaking', snap4.activity)

    // 会话结束 → idle
    await evaluate(
      `window.live2d.injectVoice({ type: 'state', state: { phase: 'inactive' } })`,
    )
    await sleep(300)
    const snap5 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    console.log('[proof:e2e] session inactive 后:', JSON.stringify(snap5))
    check('session 结束 → idle', snap5.activity === 'idle', snap5.activity)
    check(
      '模型状态可见（本环境预期无模型 → 写入 no-op 但目标值仍被驱动）',
      typeof snap5.modelLoaded === 'boolean',
    )

    // 非法注入被 main 规范化拒绝（事件计数不再增长）
    const before = snap5.events
    await evaluate(`window.live2d.injectVoice({ type: 'audio-level', level: 'loud' })`)
    await evaluate(`window.live2d.injectVoice({ type: 'motion', group: 'Idle' })`)
    await sleep(300)
    const snap6 = await evaluate(`window.__live2dVoiceDebug.snapshot()`)
    check(
      '非法负载被 main 规范化丢弃',
      snap6.events === before,
      `events ${before} → ${snap6.events}`,
    )

    check('主进程日志确认注入模式开启', app.appLog().includes('voice 测试注入已开启'))
  } finally {
    cdp?.close()
    const exit = await app.close()
    const leaked = app.appLog().includes('render-process-gone')
    check('Electron 干净退出（无 renderer 崩溃）', !leaked)
    console.log('[proof:e2e] Electron 退出码:', exit === null ? 'timeout' : exit.code)
  }
}

// --------------------------------------------------------------------- main
const withE2e = process.argv.includes('--e2e')
console.log('=== F3 口型证据：伪 viseme 多维嘴参 + silenceHold ===')
await runLogic()
if (withE2e) {
  console.log('')
  await runE2e()
}
console.log('')
const { checks, failures } = proofCounts()
if (failures > 0) {
  console.error(`✘ F3 证据失败：${failures}/${checks} 项断言未过`)
  process.exit(1)
}
console.log(
  `✔ F3 证据通过（${checks} 项断言）：多维口型（open+form）与 silenceHold` +
    (withE2e ? ' + CDP 端到端' : '') +
    ' 证据',
)
