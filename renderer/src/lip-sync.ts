/**
 * 口型驱动绑定层（ADR 0001 · F3）
 *
 * 组合 voice-state.ts 的状态机与平滑器，把「每帧嘴参开度」写到调用方给的
 * writeMouth 回调（真实模型 = Live2DApp.setParameter 包装；缺模型 = 调试记录器）。
 *
 * 本层同样无 DOM / pixi 依赖：node:test 与 scripts/f3-lipsync-proof.mjs
 * 可用 mock writeMouth 直接证明「注入 level → 嘴参目标值变化」。
 */

// 注意：本模块被 Node（单测与 scripts/f3-lipsync-proof.mjs 的 mock 证据）经
// type-stripping 直接加载，import 必须写真文件名 `.ts`（Node 不做 .js→.ts 重映射）；
// renderer/tsconfig.json 已开 allowImportingTsExtensions，tsc/vite 同样接受。
import {
  VoiceStateMachine,
  LevelSmoother,
  clamp01,
  type VoiceEvent,
  type VoiceActivity,
} from './voice-state.ts'

/** 嘴参目标（已解析到模型实际参数 id 与取值范围）；null = 未解析到（no-op 写） */
export interface MouthParamTarget {
  id: string
  min: number
  max: number
}

export interface VoiceLipSyncOptions {
  /** 嘴参目标；模型缺失或无匹配参数时传 null（仍推进状态机与平滑，供调试快照） */
  mouthParam: MouthParamTarget | null
  /** 写入回调：value 已按 mouthParam 范围换算（无 mouthParam 时为 [0,1] 开度） */
  writeMouth: (paramId: string | null, value: number) => void
  /** 时钟（默认 performance.now；测试注入假钟） */
  now?: () => number
  machine?: VoiceStateMachine
  smoother?: LevelSmoother
}

export interface VoiceLipSyncSnapshot {
  activity: VoiceActivity
  level: number
  /** 平滑后的嘴参开度 [0,1]（未按参数范围换算） */
  smoothedMouth: number
  mouthParamId: string | null
  /** 最近一次写入值（按参数范围换算后；mock 场景同样记录） */
  lastMouthWrite: number
  /** 累计写入次数（证明 IPC/注入改变了嘴参目标） */
  mouthWrites: number
  /** 累计接收的规范化事件数 */
  events: number
}

export interface VoiceLipSync {
  handleEvent: (event: VoiceEvent) => void
  /** 每帧推进：静音保持判定 + 平滑 + 写嘴参；返回本次写入值 */
  tick: (dtMs: number) => number
  snapshot: () => VoiceLipSyncSnapshot
}

export function createVoiceLipSync(options: VoiceLipSyncOptions): VoiceLipSync {
  const machine = options.machine ?? new VoiceStateMachine()
  const smoother = options.smoother ?? new LevelSmoother()
  const now = options.now ?? (() => performance.now())
  const mouthParam = options.mouthParam
  const writeMouth = options.writeMouth

  let lastMouthWrite = 0
  let mouthWrites = 0
  let events = 0

  function handleEvent(event: VoiceEvent): void {
    events += 1
    machine.applyEvent(event, now())
  }

  function tick(dtMs: number): number {
    // 先推进状态机（900ms 静音保持判定），再平滑，最后写嘴参
    machine.update(now())
    const smoothed = smoother.tick(dtMs, machine.mouthTarget())
    const value = mouthParam
      ? mouthParam.min + clamp01(smoothed) * (mouthParam.max - mouthParam.min)
      : clamp01(smoothed)
    if (value !== lastMouthWrite) {
      lastMouthWrite = value
      mouthWrites += 1
      writeMouth(mouthParam?.id ?? null, value)
    }
    return value
  }

  function snapshot(): VoiceLipSyncSnapshot {
    return {
      activity: machine.activity,
      level: machine.level,
      smoothedMouth: smoother.value,
      mouthParamId: mouthParam?.id ?? null,
      lastMouthWrite,
      mouthWrites,
      events,
    }
  }

  return { handleEvent, tick, snapshot }
}
