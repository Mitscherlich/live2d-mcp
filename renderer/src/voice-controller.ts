import { createVoiceLipSync, type MouthParamTarget, type VoiceLipSync } from './lip-sync.js'
import { resolveMouthParamId, type VoiceActivity } from './voice-state.js'
import { motionTag } from './model-config.ts'
import type { Live2DApp } from './live2d-app.js'
import type { Live2dApi } from './live2d-bridge.js'
import type { StatusBar } from './status-bar.js'

/**
 * ADR 0001 · F3：voice 状态机 + 口型驱动（Electron 一体化路径）。
 *
 * - 事件源：preload onVoiceEvent（main 推送的规范化 state/audio-level；
 *   F4 bridge /events 与本片测试注入 injectVoice 共用该通道）。
 * - 嘴参：模型参数表解析 ParamMouthOpenY 或等效别名；模型缺失/无该参时写入 no-op
 *   （状态机与平滑照常推进，调试快照可见 smoothed 值变化）。
 * - 帧驱动：有模型走 PIXI ticker（LOW 优先级，motion 之后写嘴参）；
 *   无模型走 rAF（注入链路在无模型环境仍可证明嘴参目标值变化）。
 * - 调试快照 __live2dVoiceDebug：scripts/f3-lipsync-proof.mjs 经 CDP 读取，
 *   字段名逐字保持（proof 断言契约）。
 */
export class VoiceController {
  private readonly lip: VoiceLipSync
  private mouthParam: MouthParamTarget | null = null
  private rafHandle: number | null = null
  private readonly offVoice: () => void

  constructor(
    private readonly app: Live2DApp | null,
    api: Live2dApi,
    private readonly statusBar: StatusBar,
  ) {
    const info = app?.getModelInfo() ?? null
    if (info) {
      const mouthId = resolveMouthParamId(info.parameters.map((p) => p.id))
      if (mouthId) {
        const p = info.parameters.find((param) => param.id === mouthId)!
        this.mouthParam = { id: p.id, min: p.min, max: p.max }
      } else {
        console.warn('[Voice] 模型参数表无 ParamMouthOpenY 或等效嘴参，口型写入 no-op（仅一次）')
      }
    }

    this.lip = createVoiceLipSync({
      mouthParam: this.mouthParam,
      writeMouth: (paramId, value) => {
        if (paramId && app) app.setParameter(paramId, value)
        // 无嘴参/无模型：no-op（快照仍记录 lastMouthWrite，证明目标值被驱动）
      },
    })

    this.syncVoice(true)

    this.offVoice = api.onVoiceEvent((event) => {
      this.lip.handleEvent(event)
      // 立即刷 UI（不等下一帧），便于 live-voice 出声瞬间看到 speaking
      this.syncVoice()
    })

    if (app) {
      app.addTicker((dt) => {
        this.lip.tick(dt)
        this.syncVoice()
      })
    } else {
      let prev = performance.now()
      const frame = (t: number) => {
        const dt = t - prev
        prev = t
        this.lip.tick(dt)
        this.syncVoice()
        this.rafHandle = requestAnimationFrame(frame)
      }
      this.rafHandle = requestAnimationFrame(frame)
    }

    // 调试快照：scripts/f3-lipsync-proof.mjs 经 CDP 读取，证明注入改变了嘴参目标
    window.__live2dVoiceDebug = {
      snapshot: () => ({
        ...this.lip.snapshot(),
        modelLoaded: app?.isLoaded() ?? false,
        injectEnabled: typeof api.injectVoice === 'function',
      }),
    }
    console.log(`[Voice] 口型驱动已挂接（嘴参: ${this.mouthParam?.id ?? '未解析（no-op）'}，注入: ${
      typeof api.injectVoice === 'function' ? '开' : '关'
    }）`)
  }

  dispose(): void {
    this.offVoice()
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
  }

  /**
   * 助手（Codex）出声时的肢体表现：对齐 persona 的 Listening/Speaking 槽位思想。
   * 当前模型无独立 Speaking 组时用 Idle 循环；speaking 时用略高优先级保证口型期间有体态。
   * 注意：这是 **agent 播放音频** 的视觉反应，不是用户麦克风说话。
   */
  private applyVoiceBodyMotion(activity: VoiceActivity): void {
    if (!this.app?.isLoaded()) return
    if (activity === 'speaking') {
      // priority 2：体态；口型仍由 LOW ticker 在 motion 之后写 ParamMouthOpenY
      this.app.playMotion('Idle', -1, 2)
      this.statusBar.noteMotion(motionTag('Idle'))
      return
    }
    if (activity === 'listening' || activity === 'idle') {
      this.app.playMotion('Idle', -1, 1)
      this.statusBar.noteMotion(motionTag('Idle'))
    }
  }

  /**
   * 每帧 + 每条事件调用。activity 变化可能由 tick 触发（900ms 静音保持到期回落），
   * 不只由事件触发，所以体态检测必须留在每帧；DOM 差分归 StatusBar。
   */
  private syncVoice(force = false): void {
    const activity = this.lip.getActivity()
    const activityChanged = this.statusBar.syncVoice(activity, this.lip.getLevel(), force)
    if (activityChanged) {
      this.applyVoiceBodyMotion(activity)
      console.log(`[Voice] activity → ${activity} (level=${this.lip.getLevel().toFixed(3)})`)
    }
  }
}
