'use strict'

/**
 * Streamable HTTP MCP（ADR 0001 · F5）
 *
 * SPEC §6.4 / G4 工具面（挂到 bridge 同端口 /mcp，默认 http://127.0.0.1:47832/mcp）：
 *  - get_status      只读：窗口可见性 / bridge / voice 摘要 / listener 状态 / 模型就绪
 *  - control_window  写：show | hide | toggle（hide 不退出应用）
 *  - get_model_info  只读：表情 / 动作分组 / 参数列表（经 renderer 往返）
 *  - set_expression  写：表情名
 *  - play_motion     写：group + 可选 index/priority
 *  - look_at / set_parameter / reset  写：低成本保留（决策 3）
 *
 * 禁止 speak / lip_sync* / 任何 TTS 工具（SPEC §9，决策 1/3）。
 * Server instructions 声明：本应用不说话、不播放 agent 音频，仅视觉与窗口控制。
 *
 * 职责边界：
 *  - 本模块只做 MCP 协议与工具面：zod 入参校验（非法输入由 SDK 以
 *    InvalidParams 拒绝，NFR-3 有单测）、session 管理、工具回调编排。
 *  - 实际能力全部由 controller 注入（main.cjs）：窗口控制 main 自完成；
 *    模型/表情/动作经 main ↔ renderer 命令通道（electron/renderer-commands.cjs）
 *    转发；无模型时 controller 返回 { ok:false, error }，工具回 isError 清晰降级，
 *    不崩溃。
 *  - 传输分层参考 persona electron/mcp-server.cjs（只读，MIT）：每 initialize
 *    一个 McpServer + StreamableHTTPServerTransport，enableJsonResponse；
 *    工具名为 Live2D 语义、server 名 live2d 系，未复制其 animation 逻辑。
 *
 * 纯 Node 依赖（@modelcontextprotocol/sdk + zod），无 Electron 依赖：
 * node:test 可用 stub controller + 真实 HTTP client 直测（NFR-3）。
 */

const { randomUUID } = require('node:crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js')
const z = require('zod/v4')

const { version: APP_VERSION } = require('../package.json')
const {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_SERVER_ERROR,
  sendJsonRpcError,
} = require('./mcp-protocol.cjs')

const SERVER_NAME = 'live2d-companion'
const WINDOW_ACTIONS = ['show', 'hide', 'toggle']

/**
 * session 空闲上限（30 分钟）。
 * enableJsonResponse 下没有 SSE 长连接可感知断线，客户端被 SIGKILL / 崩溃 / 断网时
 * 不会发 DELETE，transport.onclose 永不触发 —— 只能靠空闲超时兜底回收，否则
 * McpServer + transport 会永久留在 sessions Map 里（内存泄漏）。
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000
/** session 总数上限：清扫后仍达上限时，驱逐最久未活动的那个再放新 session 进来 */
const MAX_SESSIONS = 32

/** SPEC §6.4 强制声明：本应用不说话、不播放 agent 音频；仅视觉与窗口控制 */
const SERVER_INSTRUCTIONS = [
  'Live2D Companion 是本机桌面 Live2D 角色陪伴应用。本应用不说话、不播放 agent 音频、不提供任何 TTS/语音合成工具，仅提供视觉表现（表情、动作、视线、参数）与窗口控制。',
  'get_status 与 get_model_info 为只读；调用 set_expression / play_motion 前可先用 get_model_info 查询模型可用的表情与动作分组。',
  '视觉类工具需要模型已加载；模型缺失时返回 success:false 的清晰错误而不会崩溃。',
  'control_window 可 show / hide / toggle 角色窗；hide 只是隐藏窗口，不会退出应用。',
].join('\n')

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function jsonResult(payload) {
  return textResult(JSON.stringify(payload))
}

function errorResult(payload) {
  return { ...jsonResult(payload), isError: true }
}

/**
 * 调用 renderer 命令类 controller 回调并规范化为工具结果。
 * controller 约定返回 { ok:boolean, data?, error? }；ok:false → isError 降级文本。
 */
async function commandResult(call, successPayload) {
  const result = await call()
  if (!result || result.ok !== true) {
    const message = result?.error ?? 'renderer 未就绪或命令未执行'
    return errorResult({ success: false, error: message })
  }
  return jsonResult({ success: true, ...successPayload(result) })
}

// 名字类输入：拒绝空串/超长/控制字符（表情名、动作组名由模型定义，可为非 ASCII）
const NAME_PATTERN = /^[^\x00-\x1f]{1,64}$/
// 参数 ID：Cubism 参数为可打印 ASCII（如 ParamMouthOpenY）
const PARAM_ID_PATTERN = /^[\x21-\x7e]{1,128}$/

/**
 * 创建 Live2D Companion MCP server（工具注册）。
 * @param {object} controller main 注入的能力回调（全部可同步或 async）：
 *  - onWindowAction(action) => boolean            作用后的窗口可见性
 *  - getStatus() => object                        聚合状态（不含用户内容）
 *  - getModelInfo() => { ok, data?, error? }      renderer 往返
 *  - onExpression(expression) => { ok, error? }
 *  - onMotion({ group, index, priority }) => { ok, error? }
 *  - onLookAt({ x, y }) => { ok, error? }
 *  - onParameter({ param_id, value }) => { ok, error? }
 *  - onReset() => { ok, error? }
 */
function createLive2dMcpServer(controller) {
  const server = new McpServer(
    { name: SERVER_NAME, version: APP_VERSION ?? '0.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  )

  server.registerTool(
    'get_status',
    {
      title: '获取 Live2D Companion 状态',
      description:
        '只读。返回窗口可见性、bridge 端口、voice 摘要（phase/activity/level）、' +
        'listener 真实模式与状态、MCP 端点与模型就绪状态。不含任何用户内容。',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => jsonResult(await controller.getStatus()),
  )

  server.registerTool(
    'control_window',
    {
      title: '控制角色窗口',
      description:
        'show / hide / toggle 本机 Live2D 角色窗。hide 只是隐藏窗口，不会退出应用。',
      inputSchema: {
        action: z.enum(WINDOW_ACTIONS).describe('窗口动作：show | hide | toggle'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action }) => {
      const visible = await controller.onWindowAction(action)
      return jsonResult({ success: true, action, windowVisible: Boolean(visible) })
    },
  )

  server.registerTool(
    'get_model_info',
    {
      title: '获取模型信息',
      description:
        '只读。返回当前 Live2D 模型的表情列表、动作分组与参数列表。' +
        '调用 set_expression / play_motion 前建议先调用本工具确认可用名称。模型未加载时返回清晰错误。',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const result = await controller.getModelInfo()
      if (!result || result.ok !== true) {
        return errorResult({
          success: false,
          error: result?.error ?? '模型未加载',
        })
      }
      return jsonResult({ success: true, modelInfo: result.data ?? null })
    },
  )

  server.registerTool(
    'set_expression',
    {
      title: '切换表情',
      description:
        '切换 Live2D 角色表情。可用表情取决于模型（常见 happy/sad/angry/surprised 等），' +
        '用 get_model_info 查询准确列表。',
      inputSchema: {
        expression: z
          .string()
          .regex(NAME_PATTERN, '表情名需为 1-64 字符且不含控制字符')
          .describe('表情名称，如 "happy"、"sad"。'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ expression }) =>
      commandResult(
        () => controller.onExpression(expression),
        () => ({ expression }),
      ),
  )

  server.registerTool(
    'play_motion',
    {
      title: '播放动作',
      description:
        '让 Live2D 角色播放动作动画。动作按分组组织（如 Idle、Tap、Tap@Body），' +
        '用 get_model_info 查询可用分组。',
      inputSchema: {
        group: z
          .string()
          .regex(NAME_PATTERN, '动作分组名需为 1-64 字符且不含控制字符')
          .describe('动作分组名称，如 "Idle"、"Tap@Body"。'),
        index: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe('分组内动作序号（从 0 开始）；不填则随机选择。'),
        priority: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe('优先级：1=低、2=普通（默认）、3=强制（打断当前动作）。'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ group, index, priority }) =>
      commandResult(
        () => controller.onMotion({ group, index: index ?? -1, priority: priority ?? 2 }),
        () => ({ group, index: index ?? -1, priority: priority ?? 2 }),
      ),
  )

  server.registerTool(
    'look_at',
    {
      title: '控制视线',
      description: '控制 Live2D 角色视线方向，x/y 范围 [-1, 1]（0 为正视）。',
      inputSchema: {
        x: z.number().min(-1).max(1).describe('水平：-1 左，0 正前，1 右'),
        y: z.number().min(-1).max(1).describe('垂直：-1 下，0 正前，1 上'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ x, y }) =>
      commandResult(
        () => controller.onLookAt({ x, y }),
        () => ({ x, y }),
      ),
  )

  server.registerTool(
    'set_parameter',
    {
      title: '设置模型参数',
      description:
        '直接写 Cubism 参数（精细控制），如 ParamMouthOpenY、ParamAngleX。' +
        '用 get_model_info 查询参数 ID 与取值范围。',
      inputSchema: {
        param_id: z
          .string()
          .regex(PARAM_ID_PATTERN, '参数 ID 需为可打印 ASCII（1-128 字符）')
          .describe('参数 ID，如 "ParamMouthOpenY"。'),
        value: z.number().finite().describe('参数值（建议在模型给定 min/max 范围内）。'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ param_id, value }) =>
      commandResult(
        () => controller.onParameter({ param_id, value }),
        () => ({ param_id, value }),
      ),
  )

  server.registerTool(
    'reset',
    {
      title: '重置角色',
      description: '重置 Live2D 角色为默认姿态：恢复默认表情、回到 Idle 动作、视线归中。',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => commandResult(() => controller.onReset(), () => ({})),
  )

  return server
}

/**
 * 创建 /mcp 请求处理器（Streamable HTTP，session 维度管理 transport）。
 * 由 bridge-server.cjs 在 /mcp 路由委托调用：handler(request, response, parsedBody)。
 * @param {object} controller 见 createLive2dMcpServer
 * @param {object} [options]
 * @param {() => number} [options.now] 时钟注入（默认 Date.now）；仅为单测可控假时钟，
 *   现有调用方 main.cjs 仍以 createLive2dMcpHandler(controller) 单参数形式调用。
 */
function createLive2dMcpHandler(controller, { now = Date.now } = {}) {
  /** sessionId -> { server, transport, lastSeenAt } */
  const sessions = new Map()

  /**
   * 回收若干 session：先同步从 Map 摘除（清扫对后续请求立刻生效），再异步关闭
   * server（transport 随 server 关闭）。关闭耗时不阻塞请求处理路径；
   * allSettled + close 自身幂等，可容忍 double-close。
   * @param {Array<[string, object]>} entries [sessionId, session] 列表
   */
  const retireSessions = (entries) => {
    if (entries.length === 0) return
    for (const [id] of entries) sessions.delete(id)
    void Promise.allSettled(entries.map(([, session]) => session.server.close()))
  }

  /**
   * 新建 session 前的兜底回收：
   *  1) 清扫空闲达 SESSION_IDLE_TIMEOUT_MS 的 session（客户端崩溃/断网无 DELETE）
   *  2) 若仍达 MAX_SESSIONS 上限，驱逐 lastSeenAt 最久未活动的那个
   */
  const reclaimSessions = () => {
    const deadline = now() - SESSION_IDLE_TIMEOUT_MS
    retireSessions([...sessions].filter(([, session]) => session.lastSeenAt <= deadline))
    while (sessions.size >= MAX_SESSIONS) {
      let oldest = null
      for (const entry of sessions) {
        if (!oldest || entry[1].lastSeenAt < oldest[1].lastSeenAt) oldest = entry
      }
      if (!oldest) break
      retireSessions([oldest])
    }
  }

  const handler = async (request, response, parsedBody) => {
    const header = request.headers['mcp-session-id']
    const sessionId = Array.isArray(header) ? header[0] : header
    let session = sessionId ? sessions.get(sessionId) : null
    // 活跃刷新：命中已有 session 即视为客户端存活，推迟其空闲超时
    if (session) session.lastSeenAt = now()
    try {
      if (
        !session &&
        !sessionId &&
        request.method === 'POST' &&
        isInitializeRequest(parsedBody)
      ) {
        reclaimSessions()
        const server = createLive2dMcpServer(controller)
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (initializedSessionId) => {
            session = { server, transport, lastSeenAt: now() }
            sessions.set(initializedSessionId, session)
          },
        })
        transport.onclose = () => {
          const closedSessionId = transport.sessionId
          if (closedSessionId) sessions.delete(closedSessionId)
        }
        await server.connect(transport)
        await transport.handleRequest(request, response, parsedBody)
        return
      }

      if (!session) {
        sendJsonRpcError(
          response,
          sessionId ? 404 : 400,
          JSON_RPC_SERVER_ERROR,
          sessionId ? 'MCP session not found' : 'MCP session ID is required',
        )
        return
      }

      await session.transport.handleRequest(request, response, parsedBody)
    } catch (error) {
      if (!response.headersSent) {
        sendJsonRpcError(response, 500, JSON_RPC_INTERNAL_ERROR, 'Internal server error')
      }
      throw error
    }
  }

  /** 关闭全部 session transport（应用退出时随 bridge 一起调用） */
  handler.close = async () => {
    const activeSessions = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(activeSessions.map(({ server }) => server.close()))
  }

  /**
   * 只读内省快照：[{ sessionId, lastSeenAt }]（插入序）。
   * 仅供单测断言 session 生命周期（活跃刷新 / 空闲清扫 / 上限驱逐），不参与运行时逻辑。
   */
  handler.debugSessions = () =>
    [...sessions].map(([sessionId, { lastSeenAt }]) => ({ sessionId, lastSeenAt }))

  return handler
}

// MCP_PATH 与 sendJsonRpcError 的唯一出口是 ./mcp-protocol.cjs（零第三方依赖），
// 本模块只消费不转出，避免同一符号双来源。

module.exports = {
  SERVER_NAME,
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  SESSION_IDLE_TIMEOUT_MS,
  MAX_SESSIONS,
  createLive2dMcpHandler,
  createLive2dMcpServer,
}
