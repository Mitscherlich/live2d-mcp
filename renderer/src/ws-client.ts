/**
 * WebSocket 客户端 - 连接到 MCP Server 的 WebSocket Bridge
 */

const WS_URL = 'ws://localhost:8765'
const RECONNECT_DELAY_MS = 3000

export type CommandType =
  | 'setExpression'
  | 'playMotion'
  | 'lookAt'
  | 'setParameter'
  | 'reset'
  | 'getInfo'

export interface Command {
  requestId: string
  type: CommandType
  params: Record<string, unknown>
}

export interface CommandResponse {
  requestId: string
  success: boolean
  data?: unknown
  error?: string
}

type CommandHandler = (command: Command) => Promise<CommandResponse>

export class WsClient {
  private ws: WebSocket | null = null
  private commandHandler: CommandHandler | null = null
  private onConnectCallbacks: (() => void)[] = []
  private onDisconnectCallbacks: (() => void)[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler
  }

  onConnect(cb: () => void): void {
    this.onConnectCallbacks.push(cb)
  }

  onDisconnect(cb: () => void): void {
    this.onDisconnectCallbacks.push(cb)
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.ws = new WebSocket(WS_URL)

    this.ws.onopen = () => {
      console.log('[WS Client] Connected to MCP Server')
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.onConnectCallbacks.forEach((cb) => cb())
    }

    this.ws.onmessage = async (event) => {
      try {
        const command = JSON.parse(event.data as string) as Command
        if (!this.commandHandler) return

        const response = await this.commandHandler(command)
        this.ws?.send(JSON.stringify(response))
      } catch (e) {
        console.error('[WS Client] Error handling message:', e)
      }
    }

    this.ws.onclose = () => {
      console.log('[WS Client] Disconnected, reconnecting in', RECONNECT_DELAY_MS, 'ms...')
      this.ws = null
      this.onDisconnectCallbacks.forEach((cb) => cb())
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
    }

    this.ws.onerror = (err) => {
      console.error('[WS Client] WebSocket error:', err)
    }
  }

  sendReady(modelInfo: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'ready', modelInfo }))
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
