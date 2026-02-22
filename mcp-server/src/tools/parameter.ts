import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendCommand, isRendererConnected } from '../ws-bridge.js'
import { setParameter, setLookAt } from '../state.js'

export function registerParameterTools(server: McpServer): void {
  // 眼神控制（高级封装）
  server.tool(
    'look_at',
    '控制 Live2D 角色的眼神方向。x 轴控制左右，y 轴控制上下。',
    {
      x: z
        .number()
        .min(-1)
        .max(1)
        .describe('水平方向：-1.0 = 看左边，0 = 看正前方，1.0 = 看右边'),
      y: z
        .number()
        .min(-1)
        .max(1)
        .describe('垂直方向：-1.0 = 看下方，0 = 看正前方，1.0 = 看上方'),
    },
    async ({ x, y }) => {
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
        const result = await sendCommand('lookAt', { x, y })
        if (result.success) {
          setLookAt(x, y)
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: result.success, x, y, error: result.error }),
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

  // 精细参数控制
  server.tool(
    'set_parameter',
    '直接设置 Live2D 模型的参数值，用于精细控制。常用参数：ParamMouthOpenY（嘴巴张开度）、ParamEyeLOpen/ParamEyeROpen（左右眼睁开度）、ParamAngleX/Y/Z（头部旋转）。调用前可用 get_model_info 查询所有可用参数。',
    {
      param_id: z
        .string()
        .describe('参数 ID，如 "ParamMouthOpenY"、"ParamEyeLOpen"'),
      value: z
        .number()
        .describe('参数值，通常范围 0.0-1.0，部分参数如头部旋转范围为 -30 到 30'),
    },
    async ({ param_id, value }) => {
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
        const result = await sendCommand('setParameter', { param_id, value })
        if (result.success) {
          setParameter(param_id, value)
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: result.success,
                param_id,
                value,
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
