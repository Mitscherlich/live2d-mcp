/**
 * Electron preload（electron/preload.cjs）暴露的窄 API 类型声明。
 * 渲染器只在 Electron 壳内运行；未经 preload 加载时 window.live2d 不存在，
 * 各处调用均以可选链降级（见 renderer/src/main.ts）。
 *
 * ADR 0001 · F3：voice 事件订阅（onVoiceEvent，F4 bridge 推送共用通道）
 * 与测试注入（injectVoice，仅 LIVE2D_VOICE_INJECT=1 启动时由 preload 暴露）。
 * ADR 0001 · F5：main → renderer 命令通道（onCommand，MCP 视觉工具执行路径），
 * __live2dVoiceDebug / __live2dCommandDebug 为 renderer 挂的调试快照（脚本证据用）。
 */

import type { VoiceEvent, VoiceActivity } from './voice-state.js'

/** F5 命令通道：main 下发的命令类型（与 electron/renderer-commands.cjs 白名单一致） */
export type Live2dCommandType =
  | 'getModelInfo'
  | 'setExpression'
  | 'playMotion'
  | 'lookAt'
  | 'setParameter'
  | 'reset'

export interface Live2dCommandRequest {
  type: Live2dCommandType
  params: Record<string, unknown>
}

export interface Live2dCommandResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface Live2dWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export {}

declare global {
  interface Window {
    live2d?: {
      isElectron: true
      platform: string
      /** true：显示顶栏/底栏调试 UI（LIVE2D_UI_CHROME / RENDERER_LOG / DEVTOOLS） */
      uiChrome?: boolean
      versions: {
        electron?: string
        chrome?: string
        node?: string
      }
      /** 按屏幕坐标增量移动角色窗；main 会执行跨屏 snap */
      moveWindow?: (deltaX: number, deltaY: number) => Promise<Live2dWindowBounds>
      getWindowBounds?: () => Promise<Live2dWindowBounds>
      getWindowScale?: () => Promise<number>
      setWindowScale?: (scale: number) => Promise<number>
      /** 切换角色窗鼠标穿透；S2 锁定按钮使用，S3 完善热区恢复。 */
      setMouseIgnore?: (ignore: boolean) => Promise<boolean>
      /** 打开已有的 Electron 设置窗。 */
      openSettings?: () => Promise<boolean>
      /** 订阅 main 约 30fps 推送的全局鼠标屏幕坐标；第三参为同帧窗口 bounds（热区判定用），形状非法时为 null */
      onGlobalMouseMove?: (
        callback: (x: number, y: number, bounds: Live2dWindowBounds | null) => void,
      ) => () => void
      /** 订阅 main 权威钳制后的模型缩放值 */
      onSetScale?: (callback: (scale: number) => void) => () => void
      /** 订阅 main 推送的规范化 voice 事件（state / audio-level）；返回取消订阅函数 */
      onVoiceEvent?: (callback: (event: VoiceEvent) => void) => () => void
      /** 注册 main → renderer 命令处理器（F5 MCP 执行路径）；返回取消注册函数 */
      onCommand?: (
        handler: (command: Live2dCommandRequest) => Live2dCommandResult | Promise<Live2dCommandResult>,
      ) => () => void
      /** 仅测试注入（main 以 LIVE2D_VOICE_INJECT=1 启动时存在）：回环经 main 规范化后再次到达 onVoiceEvent；返回浅校验是否受理 */
      injectVoice?: (event: unknown) => boolean
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
    /** renderer 命令通道调试快照（scripts/f5-mcp-proof.mjs 经 CDP 读取） */
    __live2dCommandDebug?: {
      snapshot: () => {
        counts: Record<string, number>
        lastCommand: string | null
        lastError: string | null
        modelLoaded: boolean
        channelAttached: boolean
      }
    }
  }
}
