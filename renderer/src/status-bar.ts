import type { VoiceActivity } from './voice-state.js'

/**
 * 顶部状态栏 + voice 状态点（ui-chrome 开启时才可见）。
 *
 * 收编此前 main.ts 的模块级状态（currentExpression/currentMotion）与散在
 * 命令通道/点击交互/voice 体态/调试面板四处的 updateStateBar 样板；
 * voice 状态点/电平的 DOM 差分（:504-532）也归这里——enabled=false（陪伴模式）
 * 时全部 DOM 写入跳过，但差分状态照常推进（activity 变化判定对调用方仍可用）。
 */
export class StatusBar {
  private currentExpression = '-'
  private currentMotion = '-'
  private shownActivity: VoiceActivity | '' = ''
  private lastShownLevel = -1

  private readonly modelDot = document.getElementById('model-dot') as HTMLDivElement
  private readonly modelStatus = document.getElementById('model-status') as HTMLSpanElement
  private readonly voiceDot = document.getElementById('voice-dot') as HTMLDivElement
  private readonly voiceStatus = document.getElementById('voice-status') as HTMLSpanElement
  private readonly currentStateEl = document.getElementById('current-state') as HTMLDivElement

  constructor(private readonly enabled: boolean) {}

  noteExpression(name: string): void {
    this.currentExpression = name
    this.updateStateBar()
  }

  noteMotion(tag: string): void {
    this.currentMotion = tag
    this.updateStateBar()
  }

  /** 表情/动作文案复位（reset 命令与调试面板「重置」共用） */
  resetExpressionMotion(): void {
    this.currentExpression = '-'
    this.currentMotion = '-'
    this.updateStateBar()
  }

  /** 模型加载结果：无论 ui-chrome 与否都写（陪伴模式也显示加载失败文案） */
  setModelStatus(loaded: boolean): void {
    if (loaded) this.modelDot.classList.add('connected')
    this.modelStatus.textContent = loaded ? '模型已加载' : '模型加载失败'
  }

  /**
   * 每帧 + 每条 voice 事件调用。返回 activity 是否变化（调用方据此触发体态动作）。
   * DOM 写入只在 enabled 下做；电平按 0.05 分桶避免每帧刷文本。
   */
  syncVoice(activity: VoiceActivity, level: number, force = false): boolean {
    const activityChanged = activity !== this.shownActivity
    if (activityChanged) this.shownActivity = activity
    if (!this.enabled) return activityChanged
    if (activityChanged) {
      this.voiceDot.classList.toggle('listening', activity === 'listening')
      this.voiceDot.classList.toggle('speaking', activity === 'speaking')
    }
    // 状态栏展示电平，便于确认「Codex 出声」是否被采到（非用户麦克风）
    const levelBucket = Math.round(level * 20) / 20
    if (force || activityChanged || levelBucket !== this.lastShownLevel) {
      this.lastShownLevel = levelBucket
      const levelStr = level > 0.005 ? ` · L${level.toFixed(2)}` : ''
      this.voiceStatus.textContent = `助手语音 ${activity}${levelStr}`
    }
    return activityChanged
  }

  private updateStateBar(): void {
    if (!this.enabled) return
    this.currentStateEl.textContent = `表情: ${this.currentExpression} | 动作: ${this.currentMotion}`
  }
}
