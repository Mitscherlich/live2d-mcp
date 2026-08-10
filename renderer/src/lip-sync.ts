/**
 * 口型驱动绑定层（ADR 0001 · F3）
 *
 * 组合 voice-state.ts 的状态机、平滑器与伪 viseme 映射，把「每帧多维嘴参」
 * 写到调用方给的 writeMouth 回调（真实模型 = Live2DApp.setParameter 包装；
 * 缺模型 = 调试记录器）。
 *
 * 本层同样无 DOM / pixi 依赖：node:test 与 scripts/f3-lipsync-proof.mjs
 * 可用 mock writeMouth 直接证明「注入 level → 开合+嘴形变化」。
 */

// 注意：本模块被 Node（单测与 scripts/f3-lipsync-proof.mjs 的 mock 证据）经
// type-stripping 直接加载，import 必须写真文件名 `.ts`（Node 不做 .js→.ts 重映射）；
// renderer/tsconfig.json 已开 allowImportingTsExtensions，tsc/vite 同样接受。
import {
  VoiceStateMachine,
  LevelSmoother,
  PseudoVisemeMapper,
  mapOpenToParamRange,
  mapFormToParamRange,
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
  /** 开合嘴参；模型缺失或无匹配参数时传 null（仍推进状态机与平滑，供调试快照） */
  mouthParam: MouthParamTarget | null
  /**
   * 嘴形参数（Hiyori: ParamMouthForm）；null 时仅写开合轴。
   * 伪 viseme 相位/form 仍会推进，供快照证明多维驱动。
   */
  formParam?: MouthParamTarget | null
  /** 写入回调：value 已按对应参数范围换算（无目标 id 时 paramId 为 null，value 为 [0,1] 开度） */
  writeMouth: (paramId: string | null, value: number) => void
  /** 时钟（默认 performance.now；测试注入假钟） */
  now?: () => number
  machine?: VoiceStateMachine
  smoother?: LevelSmoother
  viseme?: PseudoVisemeMapper
}

export interface VoiceLipSyncSnapshot {
  activity: VoiceActivity
  level: number
  /** 平滑后的嘴参强度 [0,1]（未 cap / 未映射范围） */
  smoothedMouth: number
  mouthParamId: string | null
  formParamId: string | null
  /** 最近一次开合写入值（按参数范围换算后） */
  lastMouthWrite: number
  /** 最近一次嘴形写入值（按参数范围换算后；无 form 参时为归一化 form） */
  lastFormWrite: number
  /** 伪 viseme 相位 */
  phase: number
  /** 当前激活 viseme 槽 */
  activeViseme: number
  /** 累计写入次数（开合+嘴形合计，证明 IPC/注入改变了嘴参目标） */
  mouthWrites: number
  /** 开合轴写入次数 */
  openWrites: number
  /** 嘴形轴写入次数 */
  formWrites: number
  /** 累计接收的规范化事件数 */
  events: number
}

export interface VoiceLipSync {
  handleEvent: (event: VoiceEvent) => void
  /** 每帧推进：静音保持判定 + 平滑 + 伪 viseme + 写嘴参；返回本次开合写入值 */
  tick: (dtMs: number) => number
  /** 每帧读的标量访问器（不构造对象）：activity 变化检测走这里，别用 snapshot */
  getActivity: () => VoiceActivity
  /** 每帧读的标量访问器（不构造对象） */
  getLevel: () => number
  /** 完整快照：仅调试用（__live2dVoiceDebug / 证据脚本），每次调用新建对象 */
  snapshot: () => VoiceLipSyncSnapshot
}

export function createVoiceLipSync(options: VoiceLipSyncOptions): VoiceLipSync {
  const machine = options.machine ?? new VoiceStateMachine()
  const smoother = options.smoother ?? new LevelSmoother()
  const viseme = options.viseme ?? new PseudoVisemeMapper()
  const now = options.now ?? (() => performance.now())
  const mouthParam = options.mouthParam
  const formParam = options.formParam ?? null
  const writeMouth = options.writeMouth

  let lastMouthWrite = 0
  /** form 休止值：按 form 参数中点（[-1,1]→0；[0,1]→0.5），idle 不触发假写入 */
  const formRest = formParam
    ? mapFormToParamRange(0, formParam.min, formParam.max)
    : 0
  let lastFormWrite = formRest
  let lastPhase = 0
  let lastActiveViseme = 0
  let mouthWrites = 0
  let openWrites = 0
  let formWrites = 0
  let events = 0

  function handleEvent(event: VoiceEvent): void {
    events += 1
    machine.applyEvent(event, now())
  }

  function writeOpen(value: number): void {
    const id = mouthParam?.id ?? null
    if (value !== lastMouthWrite) {
      lastMouthWrite = value
      mouthWrites += 1
      openWrites += 1
      writeMouth(id, value)
    }
  }

  function writeForm(value: number): void {
    // 无 form 参数时仍记录 lastFormWrite 供快照，但不调用 writeMouth（避免假 id）
    if (!formParam) {
      lastFormWrite = value
      return
    }
    if (value !== lastFormWrite) {
      lastFormWrite = value
      mouthWrites += 1
      formWrites += 1
      writeMouth(formParam.id, value)
    }
  }

  function tick(dtMs: number): number {
    // 状态机 → 强度平滑 → 伪 viseme → 写开合/嘴形
    machine.update(now())
    const smoothed = smoother.tick(dtMs, machine.mouthTarget())
    const mapped = viseme.tick(dtMs, smoothed)
    lastPhase = mapped.phase
    lastActiveViseme = mapped.activeViseme

    const openValue = mouthParam
      ? mapOpenToParamRange(mapped.open, mouthParam.min, mouthParam.max)
      : mapped.open
    writeOpen(openValue)

    const formValue = formParam
      ? mapFormToParamRange(mapped.form, formParam.min, formParam.max)
      : mapped.form
    writeForm(formValue)

    return openValue
  }

  function getActivity(): VoiceActivity {
    return machine.activity
  }

  function getLevel(): number {
    return machine.level
  }

  function snapshot(): VoiceLipSyncSnapshot {
    return {
      activity: machine.activity,
      level: machine.level,
      smoothedMouth: smoother.value,
      mouthParamId: mouthParam?.id ?? null,
      formParamId: formParam?.id ?? null,
      lastMouthWrite,
      lastFormWrite,
      phase: lastPhase,
      activeViseme: lastActiveViseme,
      mouthWrites,
      openWrites,
      formWrites,
      events,
    }
  }

  return { handleEvent, tick, getActivity, getLevel, snapshot }
}
