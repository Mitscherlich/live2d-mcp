/**
 * 命令处理器 - 解析来自 MCP Server 的命令，调用对应的 Live2D 操作
 */

import type { Command, CommandResponse } from './ws-client.js'
import type { Live2DApp } from './live2d-app.js'

// --- 字幕管理 ---
let subtitleTimer: ReturnType<typeof setTimeout> | null = null

function showSubtitle(text: string, durationMs: number): void {
  const bar = document.getElementById('subtitle-bar')
  const textEl = document.getElementById('subtitle-text')
  if (!bar || !textEl) return

  if (subtitleTimer !== null) {
    clearTimeout(subtitleTimer)
    subtitleTimer = null
  }

  textEl.textContent = text
  bar.classList.add('visible')

  subtitleTimer = setTimeout(() => {
    bar.classList.remove('visible')
    subtitleTimer = null
  }, durationMs + 500) // 多留 500ms 淡出
}

export function createCommandHandler(app: Live2DApp) {
  return async (command: Command): Promise<CommandResponse> => {
    const { requestId, type, params } = command

    if (!app.isLoaded()) {
      return {
        requestId,
        success: false,
        error: 'Model not loaded yet',
      }
    }

    try {
      switch (type) {
        case 'setExpression': {
          const expression = params.expression as string
          const ok = app.setExpression(expression)
          return { requestId, success: ok, error: ok ? undefined : `Expression "${expression}" not found` }
        }

        case 'playMotion': {
          const group = params.group as string
          const index = (params.index as number) ?? -1
          const priority = (params.priority as number) ?? 2
          const ok = app.playMotion(group, index, priority)
          return { requestId, success: ok, error: ok ? undefined : `Motion group "${group}" not found` }
        }

        case 'lookAt': {
          const x = params.x as number
          const y = params.y as number
          const ok = app.lookAt(x, y)
          return { requestId, success: ok }
        }

        case 'setParameter': {
          const paramId = params.param_id as string
          const value = params.value as number
          const ok = app.setParameter(paramId, value)
          return { requestId, success: ok, error: ok ? undefined : `Parameter "${paramId}" not found` }
        }

        case 'reset': {
          const ok = app.reset()
          return { requestId, success: ok }
        }

        case 'getInfo': {
          const info = app.getModelInfo()
          return { requestId, success: true, data: info }
        }

        case 'startSpeak': {
          const subtitleText = params.text as string | undefined
          if (subtitleText) {
            const duration = subtitleText.length * 200
            showSubtitle(subtitleText, duration)
          }
          const ok = app.startSpeak()
          return { requestId, success: ok }
        }

        case 'audioChunk': {
          const audio = params.audio as string
          const lipSyncData = (params.lipSyncData as Array<{ time: number; value: number }>) ?? []
          const durationMs = (params.durationMs as number) ?? 2000
          const ok = app.appendChunk(audio, lipSyncData, durationMs)
          return { requestId, success: ok }
        }

        case 'endSpeak': {
          const ok = app.endSpeak()
          return { requestId, success: ok }
        }

        case 'startLipSyncOnly': {
          const duration = params.duration as number
          const emotion = params.emotion as string
          const subtitleText = params.text as string | undefined
          if (subtitleText) showSubtitle(subtitleText, duration)
          const ok = app.startLipSyncOnly(duration, emotion)
          return { requestId, success: ok }
        }

        case 'lipSync': {
          const audioUrl = params.audioUrl as string | undefined
          const audioBase64 = params.audioBase64 as string | undefined
          const lipSyncData = params.lipSyncData as Array<{time: number, value: number}> | undefined
          const subtitleText = params.text as string | undefined
if (subtitleText) {
            const duration = (lipSyncData && lipSyncData.length > 0)
              ? lipSyncData[lipSyncData.length - 1].time
              : subtitleText.length * 200  // 估算：每字约 200ms
            showSubtitle(subtitleText, duration)
          }
          const ok = app.lipSync(audioUrl, audioBase64, lipSyncData)
          return { requestId, success: ok }
        }

        default:
          return { requestId, success: false, error: `Unknown command type: ${type}` }
      }
    } catch (e) {
      return { requestId, success: false, error: String(e) }
    }
  }
}
