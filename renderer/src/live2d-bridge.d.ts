/**
 * Electron preload（electron/preload.cjs）暴露的窄 API 类型声明。
 * 浏览器（legacy 双进程路径）环境下不存在 window.live2d。
 *
 * ADR 0001 · F3：新增 voice 事件订阅（onVoiceEvent，F4 bridge 推送共用通道）
 * 与测试注入（injectVoice，仅 LIVE2D_VOICE_INJECT=1 启动时由 preload 暴露）。
 * __live2dVoiceDebug 为 renderer 挂的口型调试快照（F3 脚本证据用）。
 */

import type { VoiceEvent, VoiceActivity } from './voice-state.js'

export {}

declare global {
  interface Window {
    live2d?: {
      isElectron: true
      platform: string
      versions: {
        electron?: string
        chrome?: string
        node?: string
      }
      /** 订阅 main 推送的规范化 voice 事件（state / audio-level）；返回取消订阅函数 */
      onVoiceEvent?: (callback: (event: VoiceEvent) => void) => () => void
      /** 仅测试注入（main 以 LIVE2D_VOICE_INJECT=1 启动时存在）：回环经 main 规范化后再次到达 onVoiceEvent */
      injectVoice?: (event: unknown) => void
    }
    /** renderer 口型调试快照（scripts/f3-lipsync-proof.mjs 经 CDP 读取） */
    __live2dVoiceDebug?: {
      snapshot: () => {
        activity: VoiceActivity
        level: number
        smoothedMouth: number
        mouthParamId: string | null
        lastMouthWrite: number
        mouthWrites: number
        events: number
        modelLoaded: boolean
        injectEnabled: boolean
      }
    }
  }
}
