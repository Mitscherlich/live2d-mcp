'use strict'

/**
 * BridgeService：loopback bridge HTTP 与 Streamable HTTP MCP 的生命周期封装
 * （ADR 0001 · F4/F5）。
 *
 * 收编此前 main.cjs 里的 bridge/mcpHandler 模块级变量与 startBridge 编排：
 * 端口解析（LIVE2D_BRIDGE_PORT）→ McpSessionManager → createBridgeServer →
 * listen → 启动日志；关闭幂等（应用退出时调用一次）。
 *
 * /events 的 onEvent 由组合根注入（CompanionApp.dispatchVoiceEvent）——
 * curl 注入与测试注入、native listener 走完全相同的规范化 + IPC 路径。
 * 监听失败不杀应用，打印清晰日志提示换端口。
 *
 * 纯 node 模块（Electron 依赖零）：node:test 可直测。
 */

const {
  DEFAULT_PORT,
  bridgeHttpUrl,
  buildCodexMcpCommand,
  mcpHttpUrl,
  resolveBridgePort,
} = require('./bridge-endpoint.cjs')
const { createBridgeServer } = require('./bridge-server.cjs')
const { MCP_PATH } = require('./mcp-protocol.cjs')
const { McpSessionManager } = require('./mcp-server.cjs')

class BridgeService {
  /**
   * @param {object} options
   * @param {(event: object) => boolean} options.onEvent 规范化后 voice 事件投递出口
   * @param {() => object} options.getHealthExtra /health 附加字段回调（不含用户内容）
   * @param {() => void} [options.onListening] 监听成功后的通知（设置窗热更新）
   * @param {object} [options.environment] env（默认 process.env）
   * @param {object} [options.logger] 日志出口（默认 console）
   */
  constructor({
    onEvent,
    getHealthExtra,
    onListening = () => {},
    environment = process.env,
    logger = console,
  } = {}) {
    if (typeof onEvent !== 'function') throw new TypeError('BridgeService: onEvent 必填')
    if (typeof getHealthExtra !== 'function') {
      throw new TypeError('BridgeService: getHealthExtra 必填')
    }
    this._onEvent = onEvent
    this._getHealthExtra = getHealthExtra
    this._onListening = onListening
    this._environment = environment
    this._logger = logger
    this._bridge = null
    this._mcpSessions = null
  }

  /** 当前 bridge 实际端口（未监听为 null） */
  get port() {
    return this._bridge?.address()?.port ?? null
  }

  /** MCP 端点摘要（/health 与 get_status 共用，避免两处对象字面量逐字重复） */
  endpointSummary() {
    const port = this.port
    return {
      path: MCP_PATH,
      implemented: true,
      url: port === null ? null : mcpHttpUrl(port),
    }
  }

  /** voice 统计摘要（与 /health 的 voice 字段同源；未监听为 null） */
  get voiceSummary() {
    return this._bridge?.getVoiceSummary() ?? null
  }

  /**
   * 启动 loopback bridge（默认 127.0.0.1:47832，LIVE2D_BRIDGE_PORT 覆盖端口）并
   * 在同端口挂载 Streamable HTTP MCP（/mcp）。
   * @param {object} mcpController MCP 工具面回调（见 mcp-server.cjs）
   */
  async start(mcpController) {
    const envRaw = this._environment.LIVE2D_BRIDGE_PORT
    const envPort = resolveBridgePort(envRaw)
    if (envRaw && envPort === null) {
      this._logger.warn(`[live2d] LIVE2D_BRIDGE_PORT=${JSON.stringify(envRaw)} 非法（需 1-65535 整数），回退默认 ${DEFAULT_PORT}`)
    }
    const port = envPort ?? DEFAULT_PORT
    this._mcpSessions = new McpSessionManager(mcpController)
    this._bridge = createBridgeServer({
      port,
      onEvent: this._onEvent,
      getHealth: this._getHealthExtra,
      mcpHandler: (request, response, body) => this._mcpSessions.handle(request, response, body),
    })
    try {
      const address = await this._bridge.listen()
      this._logger.log(`[live2d] bridge 已监听（仅 loopback）: ${bridgeHttpUrl(address.port)}/health 与 /events`)
      this._logger.log(`[live2d] MCP Streamable HTTP 已就绪: ${mcpHttpUrl(address.port)}`)
      this._logger.log(`[live2d] MCP 连接示例: ${buildCodexMcpCommand(mcpHttpUrl(address.port))}`)
      this._onListening()
    } catch (error) {
      this._bridge = null
      this._mcpSessions = null
      this._logger.error(
        `[live2d] bridge 监听失败（${error?.code ?? error}）：端口 ${port} 不可用；` +
          '可用环境变量 LIVE2D_BRIDGE_PORT 换端口后重启。窗口与口型主路径不受影响。',
      )
    }
  }

  /** 关闭 MCP sessions 与 bridge；幂等，容忍未 start / start 失败 */
  async close() {
    const sessions = this._mcpSessions
    const bridge = this._bridge
    this._mcpSessions = null
    this._bridge = null
    await Promise.allSettled([sessions?.close(), bridge?.close()])
  }
}

module.exports = { BridgeService }
