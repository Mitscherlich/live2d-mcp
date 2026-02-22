import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendCommand, isRendererConnected } from '../ws-bridge.js'
import { setExpression, getState } from '../state.js'

export function registerExpressionTools(server: McpServer): void {
  server.tool(
    'set_expression',
    '切换 Live2D 角色的表情。可用表情取决于模型，通常包括 normal(正常)、happy(高兴)、sad(伤心)、angry(生气)、surprised(惊讶) 等。调用前可用 get_model_info 查询可用表情列表。',
    {
      expression: z
        .string()
        .describe('表情名称，如 "happy"、"sad"、"angry"。传入 "normal" 恢复默认表情。'),
    },
    async ({ expression }) => {
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

      try {
        const result = await sendCommand('setExpression', { expression })
        if (result.success) {
          setExpression(expression)
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: result.success,
                expression,
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
