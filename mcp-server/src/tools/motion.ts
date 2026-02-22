import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendCommand, isRendererConnected } from '../ws-bridge.js'
import { setMotion } from '../state.js'

export function registerMotionTools(server: McpServer): void {
  server.tool(
    'play_motion',
    '让 Live2D 角色播放一段动作动画。动作按分组组织，如 Idle（待机）、TapBody（点击身体）、TapHead（点击头部）等。调用前可用 get_model_info 查询可用动作分组。',
    {
      group: z
        .string()
        .describe('动作分组名称，如 "Idle"、"TapBody"、"TapHead"'),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('分组内的动作序号，从 0 开始。不填则随机选择。'),
      priority: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe('优先级：1=低、2=普通（默认）、3=强制。高优先级会打断正在播放的动作。'),
    },
    async ({ group, index, priority = 2 }) => {
      if (!isRendererConnected()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: '渲染器未连接，请先在浏览器中打开 renderer 页面（http://localhost:5173）',
              }),
            },
          ],
        }
      }

      const resolvedIndex = index ?? -1  // -1 表示随机

      try {
        const result = await sendCommand('playMotion', {
          group,
          index: resolvedIndex,
          priority,
        })
        if (result.success) {
          setMotion(group, resolvedIndex)
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: result.success,
                group,
                index: resolvedIndex,
                error: result.error,
              }),
            },
          ],
        }
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: String(e) }),
            },
          ],
        }
      }
    }
  )
}
