/**
 * Voice 状态机 + 电平平滑 + 伪 viseme 映射（ADR 0001 · F3）
 *
 * 纯逻辑模块：无 DOM / pixi / Electron 依赖，node:test 可经 Node ≥22.6
 * type-stripping 直接 import（测试见 renderer/test/voice-state.test.ts）。
 *
 * 契约对齐 SPEC §5.4 / docs/ARCHITECTURE.md §4（思想借自 persona，MIT）：
 *  - activity ∈ { idle, listening, speaking }
 *  - speaking 期间 level 短暂归零时，silenceHoldMs（默认 900ms）内保持 speaking，
 *    避免句间抖动切回 idle（对齐 persona audio-activity-gate 的 speech release）。
 *  - 嘴参强度目标 = speaking ? clamp01(level * levelGain) : 0；audibleFloor 以下视作无声
 *    （对齐 persona useAmplitudeLipSync 的 audible 判定）。
 *  - 平滑：一阶指数趋近，上升沿 attackMs、下降沿 releaseMs 两个时间常数
 *    （对齐 persona useAmplitudeLipSync 的 0.055s/0.1s）。
 *  - 伪 viseme：将平滑强度 + 相位折叠为 Live2D 双轴
 *    ParamMouthOpenY（开合）+ ParamMouthForm（嘴形），含邻接衰减 / flutter / 峰值 cap；
 *    禁止 VRM/Three，禁止真音素时间轴。
 */

export type VoiceActivity = 'idle' | 'listening' | 'speaking'
export type VoicePhase = 'inactive' | 'starting' | 'active' | 'stopping'

/** SPEC §8.1 state 事件（main 侧已规范化；activity 省略表示保持现状） */
export interface VoiceStatePayload {
  phase?: VoicePhase
  activity?: VoiceActivity
  microphoneMuted?: boolean
  outputMuted?: boolean
}

/** SPEC §8.1/§8.2：main 经 preload 推送到 renderer 的规范化 voice 事件 */
export type VoiceEvent =
  | { type: 'state'; state: VoiceStatePayload }
  | { type: 'audio-level'; level: number }

export const VOICE_DEFAULTS = {
  /** level 超过该值视为有声（persona gate 默认 0.018） */
  speechThreshold: 0.018,
  /**
   * level 低于该值时嘴参目标直接为 0（persona lip-sync 的 0.008）。
   * 与 electron/native-process-audio-listener.cjs 的 SESSION_AUDIBLE_LEVEL 语义耦合，
   * 两侧必须相等——renderer/test/voice-state.test.ts 有跨侧一致性护栏。
   */
  audibleFloor: 0.008,
  /** 短静音保持：speaking 期间无声后保持 speaking 的时长（SPEC §5.4 默认 900ms） */
  silenceHoldMs: 900,
  /** level → 嘴参目标的增益（persona lip-sync 的 2.8），增益后 clamp 到 [0,1] */
  levelGain: 2.8,
  /** 平滑上升时间常数 ms（persona 0.055s） */
  attackMs: 55,
  /** 平滑下降时间常数 ms（persona 0.1s） */
  releaseMs: 100,
  /**
   * 伪 viseme 峰值 cap（persona setValue 上限 0.62）。
   * 开合写入不超过此值，避免大声时一口张满。
   */
  peakCap: 0.62,
  /** 相位推进：phase += dtSec * (phaseRateBase + smoothed * phaseRateScale) */
  phaseRateBase: 8,
  phaseRateScale: 9,
  /** flutter = flutterBase + sin(phase * flutterFreq + i) * flutterAmp */
  flutterBase: 0.74,
  flutterAmp: 0.18,
  flutterFreq: 5.7,
  /** 邻接 viseme 衰减系数（persona：1 - |i-active| * 0.72） */
  neighborFalloff: 0.72,
  /** 伪 viseme 槽位数（对应 persona aa/ee/ih/oh/ou；折叠进 form，非真音素） */
  visemeCount: 5,
} as const

/**
 * 五个伪 viseme 在 ParamMouthForm 归一化域 [-1,1] 上的目标形状
 * （aa 略开、ee 偏扁、ih 中性、oh/ou 偏圆；仅启发式，非音素对齐）。
 */
export const PSEUDO_VISEME_FORM_TARGETS = [0.25, 0.85, 0.35, -0.45, -0.85] as const

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function resolveParamAlias(
  paramIds: readonly string[],
  aliases: readonly string[],
): string | null {
  const byLower = new Map<string, string>()
  for (const id of paramIds) byLower.set(id.toLowerCase(), id)
  for (const alias of aliases) {
    const hit = byLower.get(alias.toLowerCase())
    if (hit !== undefined) return hit
  }
  return null
}

/**
 * 常见嘴开合参别名（SPEC §5.4「ParamMouthOpenY 或等效」）。
 * 按优先级匹配模型实际参数表；大小写不敏感。
 */
export const MOUTH_PARAM_ALIASES = [
  'ParamMouthOpenY', // Cubism 4 标准
  'PARAM_MOUTH_OPEN_Y', // Cubism 2.1 风格
  'ParamMouthOpen',
  'PARAM_MOUTH_OPEN',
] as const

/** 嘴形（form）参数别名；Hiyori 为 ParamMouthForm */
export const MOUTH_FORM_PARAM_ALIASES = [
  'ParamMouthForm',
  'PARAM_MOUTH_FORM',
  'ParamMouthFormY',
  'PARAM_MOUTH_FORM_Y',
] as const

/** 在模型参数 id 列表中解析开合嘴参；无匹配返回 null（调用方 no-op 并日志一次） */
export function resolveMouthParamId(paramIds: readonly string[]): string | null {
  return resolveParamAlias(paramIds, MOUTH_PARAM_ALIASES)
}

/** 解析嘴形参数；无匹配返回 null（仅写开合轴） */
export function resolveMouthFormParamId(paramIds: readonly string[]): string | null {
  return resolveParamAlias(paramIds, MOUTH_FORM_PARAM_ALIASES)
}

/** 说话体态选择（Hiyori 仅 Idle 组；用 index + priority 拉开 speaking / 非 speaking） */
export interface VoiceBodyMotionSelection {
  group: string
  /** 固定 Idle 索引；Hiyori Idle 有 3 条（0/1/2） */
  index: number
  priority: number
}

/**
 * Hiyori 无 Speaking 组：speaking → Idle:1 priority 2；listening/idle → Idle:0 priority 1。
 * 可测、无随机，便于 proof 断言行为差。
 */
export function selectVoiceBodyMotion(activity: VoiceActivity): VoiceBodyMotionSelection {
  if (activity === 'speaking') {
    return { group: 'Idle', index: 1, priority: 2 }
  }
  return { group: 'Idle', index: 0, priority: 1 }
}

/** 伪 viseme 输出：归一化开合 [0, peakCap] + form 域 [-1,1]（再由绑定层映射到模型 min/max） */
export interface PseudoVisemeOutput {
  /** 开合强度，已含 flutter 与 peakCap */
  open: number
  /** 嘴形，[-1,1]；闭口时趋近 0 */
  form: number
  /** 累积相位（秒尺度推进） */
  phase: number
  /** 当前激活 viseme 槽 0..visemeCount-1 */
  activeViseme: number
}

export interface PseudoVisemeOptions {
  peakCap?: number
  phaseRateBase?: number
  phaseRateScale?: number
  flutterBase?: number
  flutterAmp?: number
  flutterFreq?: number
  neighborFalloff?: number
  visemeCount?: number
  formTargets?: readonly number[]
}

/**
 * 将平滑后的嘴开合强度映射为开合 + 嘴形（persona useAmplitudeLipSync 的 2D 折叠）。
 * 输入 strength 已是 LevelSmoother 输出 [0,1]；dtMs 为帧间隔。
 */
export class PseudoVisemeMapper {
  private phase = 0
  private readonly peakCap: number
  private readonly phaseRateBase: number
  private readonly phaseRateScale: number
  private readonly flutterBase: number
  private readonly flutterAmp: number
  private readonly flutterFreq: number
  private readonly neighborFalloff: number
  private readonly visemeCount: number
  private readonly formTargets: readonly number[]

  constructor(options: PseudoVisemeOptions = {}) {
    this.peakCap = options.peakCap ?? VOICE_DEFAULTS.peakCap
    this.phaseRateBase = options.phaseRateBase ?? VOICE_DEFAULTS.phaseRateBase
    this.phaseRateScale = options.phaseRateScale ?? VOICE_DEFAULTS.phaseRateScale
    this.flutterBase = options.flutterBase ?? VOICE_DEFAULTS.flutterBase
    this.flutterAmp = options.flutterAmp ?? VOICE_DEFAULTS.flutterAmp
    this.flutterFreq = options.flutterFreq ?? VOICE_DEFAULTS.flutterFreq
    this.neighborFalloff = options.neighborFalloff ?? VOICE_DEFAULTS.neighborFalloff
    this.visemeCount = options.visemeCount ?? VOICE_DEFAULTS.visemeCount
    this.formTargets = options.formTargets ?? PSEUDO_VISEME_FORM_TARGETS
  }

  get phaseValue(): number {
    return this.phase
  }

  reset(): void {
    this.phase = 0
  }

  /**
   * @param strength 平滑后的开合强度 [0,1]（非 speaking / 静音时应为 0）
   * @param dtMs 帧间隔毫秒
   */
  tick(dtMs: number, strength: number): PseudoVisemeOutput {
    const s = clamp01(strength)
    const dtSec = Number.isFinite(dtMs) && dtMs > 0 ? dtMs / 1000 : 0
    if (s <= 1e-6) {
      // 闭口：相位冻结，开合/嘴形归零（避免静音时 form 空转）
      return { open: 0, form: 0, phase: this.phase, activeViseme: 0 }
    }

    this.phase += dtSec * (this.phaseRateBase + s * this.phaseRateScale)
    const n = this.visemeCount
    const active = Math.floor(this.phase) % n
    let openAcc = 0
    let formAcc = 0
    let weightAcc = 0

    for (let i = 0; i < n; i++) {
      const shape = Math.max(0, 1 - Math.abs(i - active) * this.neighborFalloff)
      if (shape <= 0) continue
      const flutter =
        this.flutterBase + Math.sin(this.phase * this.flutterFreq + i) * this.flutterAmp
      const w = shape * Math.max(0, flutter)
      const openI = Math.min(this.peakCap, s * w)
      openAcc = Math.max(openAcc, openI)
      const formTarget = this.formTargets[i % this.formTargets.length] ?? 0
      formAcc += formTarget * w
      weightAcc += w
    }

    const formUnit = weightAcc > 0 ? formAcc / weightAcc : 0
    // 开合越大嘴形越明显；闭口趋 0
    const form = formUnit * (openAcc / this.peakCap)
    return {
      open: openAcc,
      form: Math.max(-1, Math.min(1, form)),
      phase: this.phase,
      activeViseme: active,
    }
  }
}

/**
 * 把伪 viseme 归一化输出映射到模型参数范围。
 * open: [0, peakCap] → [min, min + peakCap*(max-min)] 的线性（保留 cap 语义，不把 0.62 拉伸到满量程）
 * form: [-1,1] → [min,max] 线性
 */
export function mapOpenToParamRange(
  open: number,
  min: number,
  max: number,
): number {
  const span = max - min
  return min + clamp01(open) * span
}

export function mapFormToParamRange(
  form: number,
  min: number,
  max: number,
): number {
  const f = Number.isFinite(form) ? Math.max(-1, Math.min(1, form)) : 0
  // [-1,1] → [0,1] → [min,max]
  const t = (f + 1) / 2
  return min + t * (max - min)
}

export interface VoiceMachineOptions {
  silenceHoldMs?: number
  speechThreshold?: number
  audibleFloor?: number
  levelGain?: number
}

/**
 * activity 状态机。
 *
 * 事件驱动 applyEvent/applyLevel/applyActivity/applySession 立即生效；
 * 短静音保持的超时回落由 update(nowMs) 判定（renderer 每帧调用；
 * 测试用显式假钟推进，不依赖真实定时器）。
 */
export class VoiceStateMachine {
  private _activity: VoiceActivity = 'idle'
  private _level = 0
  private sessionActive = false
  /** 最近一次检测到有声（level > speechThreshold）或显式进入 speaking 的时刻（ms） */
  private lastAudibleAt = 0
  /** speaking 期间首次观测到无声（level ≤ speechThreshold）的时刻；有声时清空 */
  private silentSince: number | null = null

  private readonly silenceHoldMs: number
  private readonly speechThreshold: number
  private readonly audibleFloor: number
  private readonly levelGain: number

  constructor(options: VoiceMachineOptions = {}) {
    this.silenceHoldMs = options.silenceHoldMs ?? VOICE_DEFAULTS.silenceHoldMs
    this.speechThreshold = options.speechThreshold ?? VOICE_DEFAULTS.speechThreshold
    this.audibleFloor = options.audibleFloor ?? VOICE_DEFAULTS.audibleFloor
    this.levelGain = options.levelGain ?? VOICE_DEFAULTS.levelGain
  }

  get activity(): VoiceActivity {
    return this._activity
  }

  /** 最近一次规范化后的 level（[0,1]；非 speaking 时保留原值供恢复） */
  get level(): number {
    return this._level
  }

  /** 处理一条规范化 voice 事件（main → preload → renderer 的唯一入口） */
  applyEvent(event: VoiceEvent, nowMs: number): void {
    if (event.type === 'audio-level') {
      this.applyLevel(event.level, nowMs)
      return
    }
    const { phase, activity } = event.state
    if (phase === 'inactive' || phase === 'stopping') {
      this.applySession(false, nowMs)
    } else if (phase === 'active' || phase === 'starting') {
      this.applySession(true, nowMs)
    }
    if (activity !== undefined) this.applyActivity(activity, nowMs)
  }

  applyLevel(level: number, nowMs: number): void {
    const normalized = clamp01(level)
    this._level = normalized
    if (normalized > this.speechThreshold) {
      this.lastAudibleAt = nowMs
      this.silentSince = null
      // level 推导：有声即 speaking，不要求外部先发 state（对齐 persona
      // AudioActivityGate 的纯电平推导；亦保证 G2「仅注入 level 可见嘴动」）。
      // 有声源视作会话活跃，静音保持超时后回落到 listening 而非 idle。
      this.sessionActive = true
      if (this._activity !== 'speaking') {
        this._activity = 'speaking'
      }
      return
    }
    // 无声：speaking 时不立即回落；记录首次无声时刻，由 update() 做静音保持判定
    // （hold 从「level 归零」起算，对齐 persona gate 的 silenceTimer 语义）
    if (this._activity === 'speaking' && this.silentSince === null) {
      this.silentSince = nowMs
    }
  }

  applyActivity(activity: VoiceActivity, nowMs: number): void {
    if (activity === 'speaking') {
      // 显式 speaking 视作刚有声，给静音保持一个起点
      this.sessionActive = true
      this.lastAudibleAt = nowMs
      this.silentSince = null
      this._activity = 'speaking'
      return
    }
    if (activity === 'listening') {
      this.sessionActive = true
      this.silentSince = null
      this._activity = 'listening'
      return
    }
    // idle：会话结束
    this.sessionActive = false
    this.silentSince = null
    this._activity = 'idle'
  }

  applySession(active: boolean, nowMs: number): void {
    if (active) {
      this.sessionActive = true
      if (this._activity === 'idle') this._activity = 'listening'
      return
    }
    this.sessionActive = false
    this.silentSince = null
    this._activity = 'idle'
    this._level = 0
  }

  /**
   * 每帧推进：speaking 无声超过 silenceHoldMs 后回落（默认 listening，无会话则 idle）。
   * 锚点取「首次观测到无声」的时刻（level 流持续时的句间停顿语义）；
   * 若之后没有任何 level 事件（源中断），退化为「最后有声」看门狗，同样超时回落。
   */
  update(nowMs: number): void {
    if (this._activity !== 'speaking') return
    const anchor = this.silentSince ?? this.lastAudibleAt
    if (nowMs - anchor < this.silenceHoldMs) return
    this._activity = this.sessionActive ? 'listening' : 'idle'
    this._level = 0
    this.silentSince = null
  }

  /** 当前帧嘴参目标开度（未平滑）：speaking 且有声 → clamp01(level * gain)，否则 0 */
  mouthTarget(): number {
    if (this._activity !== 'speaking') return 0
    if (this._level <= this.audibleFloor) return 0
    return clamp01(this._level * this.levelGain)
  }
}

/**
 * 一阶指数平滑（persona useAmplitudeLipSync 的 smoothing 公式）：
 *   k = 1 - exp(-dt / (target > value ? attack : release))
 *   value += (target - value) * k
 */
export class LevelSmoother {
  private _value = 0
  private readonly attackMs: number
  private readonly releaseMs: number

  constructor(options: { attackMs?: number; releaseMs?: number } = {}) {
    this.attackMs = options.attackMs ?? VOICE_DEFAULTS.attackMs
    this.releaseMs = options.releaseMs ?? VOICE_DEFAULTS.releaseMs
  }

  get value(): number {
    return this._value
  }

  tick(dtMs: number, target: number): number {
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0
    const tau = target > this._value ? this.attackMs : this.releaseMs
    const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1
    this._value += (target - this._value) * Math.min(1, k)
    // 数值稳定：贴底/贴顶后吸附，避免抖动写出
    if (Math.abs(this._value - target) < 1e-4) this._value = target
    return this._value
  }

  reset(): void {
    this._value = 0
  }
}
