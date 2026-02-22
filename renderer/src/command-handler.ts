/**
 * 命令处理器 - 解析来自 MCP Server 的命令，调用对应的 Live2D 操作
 */

import type { Command, CommandResponse } from './ws-client.js'
import type { Live2DApp } from './live2d-app.js'

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

        default:
          return { requestId, success: false, error: `Unknown command type: ${type}` }
      }
    } catch (e) {
      return { requestId, success: false, error: String(e) }
    }
  }
}
