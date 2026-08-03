/**
 * WebSocket 桥接层
 * - 作为 WebSocket Server，接受来自浏览器渲染器的连接
 * - 提供 sendCommand() 方法，将 MCP 工具调用转发给渲染器
 */

import { WebSocketServer, WebSocket } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import {
  setRendererConnected,
  setModelInfo,
  type ModelInfo,
} from './state.js'

const WS_PORT = parseInt(process.env.WS_PORT ?? '8765', 10)
const COMMAND_TIMEOUT_MS = 5000

export interface Command {
  requestId: string
  type: 'setExpression' | 'playMotion' | 'lookAt' | 'setParameter' | 'reset' | 'getInfo'
  params: Record<string, unknown>
}

export interface CommandResponse {
  requestId: string
  success: boolean
  data?: unknown
  error?: string
}

type PendingResolver = {
  resolve: (res: CommandResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let wss: WebSocketServer | null = null
let rendererSocket: WebSocket | null = null
const pending = new Map<string, PendingResolver>()

export function startWebSocketServer(): void {
  wss = new WebSocketServer({ port: WS_PORT })

  wss.on('listening', () => {
    console.error(`[WS Bridge] WebSocket server listening on ws://localhost:${WS_PORT}`)
  })

  wss.on('connection', (ws) => {
    console.error('[WS Bridge] Renderer connected')
    rendererSocket = ws
    setRendererConnected(true)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>

        // 渲染器就绪通知，携带模型元数据
        if (msg.type === 'ready') {
          setModelInfo(msg.modelInfo as ModelInfo)
          console.error('[WS Bridge] Renderer ready, model info received')
          return
        }

        // 命令响应
        const resp = msg as unknown as CommandResponse
        const resolver = pending.get(resp.requestId)
        if (resolver) {
          clearTimeout(resolver.timer)
          pending.delete(resp.requestId)
          resolver.resolve(resp)
        }
      } catch (e) {
        console.error('[WS Bridge] Failed to parse message:', e)
      }
    })

    ws.on('close', () => {
      console.error('[WS Bridge] Renderer disconnected')
      rendererSocket = null
      setRendererConnected(false)
      // 拒绝所有待处理的命令
      for (const [id, resolver] of pending) {
        clearTimeout(resolver.timer)
        resolver.reject(new Error('Renderer disconnected'))
        pending.delete(id)
      }
    })

    ws.on('error', (err) => {
      console.error('[WS Bridge] WebSocket error:', err)
    })
  })

  wss.on('error', (err) => {
    console.error('[WS Bridge] Server error:', err)
  })
}

export function sendCommand(
  type: string,
  params: Command['params'] = {}
): Promise<CommandResponse> {
  return new Promise((resolve, reject) => {
    if (!rendererSocket || rendererSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('Renderer is not connected. Please open the renderer page first.'))
      return
    }

    const requestId = uuidv4()
    const command: Command = { requestId, type: type as Command['type'], params }

    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Command "${type}" timed out after ${COMMAND_TIMEOUT_MS}ms`))
    }, COMMAND_TIMEOUT_MS)

    pending.set(requestId, { resolve, reject, timer })

    try {
      rendererSocket.send(JSON.stringify(command))
    } catch (e) {
      clearTimeout(timer)
      pending.delete(requestId)
      reject(e)
    }
  })
}

export function isRendererConnected(): boolean {
  return rendererSocket !== null && rendererSocket.readyState === WebSocket.OPEN
}

export function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) {
      resolve()
      return
    }
    wss.close(() => resolve())
  })
}
