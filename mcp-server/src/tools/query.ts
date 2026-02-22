import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sendCommand, isRendererConnected } from '../ws-bridge.js'
import { getState, resetState } from '../state.js'

export function registerQueryTools(server: McpServer): void {
  // 查询模型信息
  server.tool(
    'get_model_info',
    '获取当前 Live2D 模型的详细信息，包括可用的表情列表、动作分组和参数列表。在调用其他工具前，建议先调用此工具了解模型能力。',
    {},
    async () => {
      const state = getState()

      if (!isRendererConnected()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: '渲染器未连接，请先在浏览器中打开 renderer 页面（http://localhost:5173）',
                hint: '打开浏览器访问 http://localhost:5173 即可连接渲染器',
              }),
            },
          ],
        }
      }

      if (!state.modelInfo) {
        // 向渲染器请求最新的模型信息
        try {
          const result = await sendCommand('getInfo', {})
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: result.success,
                  modelInfo: result.data,
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              modelInfo: state.modelInfo,
              currentState: {
                expression: state.currentExpression,
                motion: state.currentMotion,
                lookAt: state.lookAt,
              },
            }),
          },
        ],
      }
    }
  )

  // 重置角色
  server.tool(
    'reset',
    '将 Live2D 角色重置为默认姿态，清除当前表情和动作。',
    {},
    async () => {
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
        const result = await sendCommand('reset', {})
        if (result.success) {
          resetState()
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: result.success,
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
