'use strict'

/**
 * electron/mcp-server.cjs 单测（ADR 0001 · F5）
 *
 * 策略：真实 HTTP 链路 —— 进程内 bridge（注入真 mcpHandler + stub controller）
 * + 官方 @modelcontextprotocol/sdk client（StreamableHTTPClientTransport）。
 * 覆盖（NFR-3 / goal 验证 2/3/6/8）：
 *  - tools/list 恰好含约定 8 工具；无 speak/lip_sync/TTS 任何痕迹
 *  - instructions 声明「不说话、不播放 agent 音频」
 *  - control_window / set_expression / play_motion / look_at / set_parameter / reset
 *    正常调用抵达 controller 且参数透传
 *  - get_status / get_model_info 只读语义；模型未加载 → isError 清晰降级（不崩）
 *  - 非法参数（枚举外 action、越界 priority/index、非数字 value、空串/控制字符名、
 *    缺参）一律 isError 拒绝，且 controller 零调用
 *  - 无 session 的非 initialize POST → 400 JSON-RPC 错误
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

const { createBridgeServer } = require('../bridge-server.cjs')
const {
  MCP_PATH,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  createLive2dMcpHandler,
} = require('../mcp-server.cjs')

const EXPECTED_TOOLS = [
  'get_status',
  'control_window',
  'get_model_info',
  'set_expression',
  'play_motion',
  'look_at',
  'set_parameter',
  'reset',
]

const MODEL_INFO = {
  expressions: ['normal', 'happy', 'sad'],
  motionGroups: { Idle: 3, Tap: 2 },
  parameters: [
    { id: 'ParamMouthOpenY', name: 'ParamMouthOpenY', min: 0, max: 1, defaultValue: 0 },
  ],
}

/** stub controller：记录全部调用；modelLoaded 控制有/无模型两种降级路径 */
function makeController({ modelLoaded = true } = {}) {
  const calls = []
  let visible = true
  const controller = {
    calls,
    onWindowAction(action) {
      calls.push(['control_window', action])
      if (action === 'show') visible = true
      else if (action === 'hide') visible = false
      else visible = !visible
      return visible
    },
    getStatus() {
      calls.push(['get_status'])
      return {
        windowVisible: visible,
        bridge: { port: 47832, url: 'http://127.0.0.1:47832' },
        voice: { phase: 'active', activity: 'speaking', lastLevel: 0.8 },
        listener: { status: 'not-started', mode: 'external' },
        mcp: { path: '/mcp', implemented: true },
        model: modelLoaded ? { ready: true, expressions: 3 } : { ready: false, error: '模型未加载' },
      }
    },
    async getModelInfo() {
      calls.push(['get_model_info'])
      if (!modelLoaded) return { ok: false, error: 'Live2D 模型未加载' }
      return { ok: true, data: MODEL_INFO }
    },
    async onExpression(expression) {
      calls.push(['set_expression', expression])
      if (!modelLoaded) return { ok: false, error: 'Live2D 模型未加载' }
      if (!MODEL_INFO.expressions.includes(expression)) {
        return { ok: false, error: `表情 "${expression}" 不存在或不可用` }
      }
      return { ok: true }
    },
    async onMotion(params) {
      calls.push(['play_motion', params])
      if (!modelLoaded) return { ok: false, error: 'Live2D 模型未加载' }
      return { ok: true }
    },
    async onLookAt(params) {
      calls.push(['look_at', params])
      return modelLoaded ? { ok: true } : { ok: false, error: 'Live2D 模型未加载' }
    },
    async onParameter(params) {
      calls.push(['set_parameter', params])
      return modelLoaded ? { ok: true } : { ok: false, error: 'Live2D 模型未加载' }
    },
    async onReset() {
      calls.push(['reset'])
      return modelLoaded ? { ok: true } : { ok: false, error: 'Live2D 模型未加载' }
    },
  }
  return controller
}

/** 起 bridge + 真 mcpHandler + 官方 client；返回 { client, controller, baseUrl, close } */
async function startMcp(opts) {
  const controller = makeController(opts)
  const mcpHandler = createLive2dMcpHandler(controller)
  const bridge = createBridgeServer({ port: 0, onEvent: () => true, mcpHandler })
  const address = await bridge.listen()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const client = new Client({ name: 'mcp-test', version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}${MCP_PATH}`)))
  return {
    client,
    controller,
    baseUrl,
    close: async () => {
      await client.close()
      await mcpHandler.close()
      await bridge.close()
    },
  }
}

function resultJson(result) {
  assert.ok(result.content?.[0]?.type === 'text', '工具结果应为 text content')
  return JSON.parse(result.content[0].text)
}

test('tools/list 恰好含约定 8 工具，无 speak/lip_sync/TTS 痕迹', async () => {
  const { client, close } = await startMcp()
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...EXPECTED_TOOLS].sort(),
    )
    for (const tool of tools) {
      const haystack = `${tool.name} ${tool.description ?? ''}`
      assert.ok(!/speak|lip_?sync|tts/i.test(haystack), `禁止语音工具痕迹: ${tool.name}`)
    }
    // 只读标注：get_status / get_model_info
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    assert.equal(byName.get_status.annotations.readOnlyHint, true)
    assert.equal(byName.get_model_info.annotations.readOnlyHint, true)
    assert.equal(byName.control_window.annotations.readOnlyHint, false)
  } finally {
    await close()
  }
})

test('server instructions 声明不说话、不播放 agent 音频（SPEC §6.4）', async () => {
  const { client, close } = await startMcp()
  try {
    const instructions = client.getInstructions()
    assert.equal(instructions, SERVER_INSTRUCTIONS)
    assert.match(instructions, /不说话/)
    assert.match(instructions, /不播放 agent 音频/)
    assert.match(instructions, /视觉/)
  } finally {
    await close()
  }
})

test('get_status 返回窗口/bridge/voice/listener/mcp/model 聚合（只读，无用户内容）', async () => {
  const { client, controller, close } = await startMcp()
  try {
    const result = await client.callTool({ name: 'get_status', arguments: {} })
    assert.notEqual(result.isError, true)
    const status = resultJson(result)
    assert.equal(status.windowVisible, true)
    assert.equal(status.bridge.port, 47832)
    assert.equal(status.voice.activity, 'speaking')
    assert.equal(status.listener.status, 'not-started')
    assert.equal(status.mcp.implemented, true)
    assert.equal(status.model.ready, true)
    assert.deepEqual(controller.calls, [['get_status']])
  } finally {
    await close()
  }
})

test('control_window：show/hide/toggle 真实作用于（stub）窗口并回传可见性', async () => {
  const { client, controller, close } = await startMcp()
  try {
    const hide = await client.callTool({ name: 'control_window', arguments: { action: 'hide' } })
    assert.deepEqual(resultJson(hide), { success: true, action: 'hide', windowVisible: false })
    const toggle = await client.callTool({ name: 'control_window', arguments: { action: 'toggle' } })
    assert.deepEqual(resultJson(toggle), { success: true, action: 'toggle', windowVisible: true })
    assert.deepEqual(controller.calls, [
      ['control_window', 'hide'],
      ['control_window', 'toggle'],
    ])
  } finally {
    await close()
  }
})

test('get_model_info 有模型时返回表情/动作组/参数列表', async () => {
  const { client, close } = await startMcp()
  try {
    const result = await client.callTool({ name: 'get_model_info', arguments: {} })
    assert.notEqual(result.isError, true)
    const payload = resultJson(result)
    assert.equal(payload.success, true)
    assert.deepEqual(payload.modelInfo, MODEL_INFO)
  } finally {
    await close()
  }
})

test('set_expression / play_motion / look_at / set_parameter / reset 参数透传到 controller', async () => {
  const { client, controller, close } = await startMcp()
  try {
    const expr = await client.callTool({ name: 'set_expression', arguments: { expression: 'happy' } })
    assert.deepEqual(resultJson(expr), { success: true, expression: 'happy' })

    const motion = await client.callTool({
      name: 'play_motion',
      arguments: { group: 'Tap', index: 1, priority: 3 },
    })
    assert.deepEqual(resultJson(motion), { success: true, group: 'Tap', index: 1, priority: 3 })

    // index/priority 省略 → index:-1（随机）/ priority:2（普通）
    const motionDefault = await client.callTool({ name: 'play_motion', arguments: { group: 'Idle' } })
    assert.deepEqual(resultJson(motionDefault), { success: true, group: 'Idle', index: -1, priority: 2 })

    const look = await client.callTool({ name: 'look_at', arguments: { x: 0.5, y: -0.5 } })
    assert.deepEqual(resultJson(look), { success: true, x: 0.5, y: -0.5 })

    const param = await client.callTool({
      name: 'set_parameter',
      arguments: { param_id: 'ParamMouthOpenY', value: 0.7 },
    })
    assert.deepEqual(resultJson(param), { success: true, param_id: 'ParamMouthOpenY', value: 0.7 })

    const reset = await client.callTool({ name: 'reset', arguments: {} })
    assert.deepEqual(resultJson(reset), { success: true })

    assert.deepEqual(controller.calls, [
      ['set_expression', 'happy'],
      ['play_motion', { group: 'Tap', index: 1, priority: 3 }],
      ['play_motion', { group: 'Idle', index: -1, priority: 2 }],
      ['look_at', { x: 0.5, y: -0.5 }],
      ['set_parameter', { paramId: 'ParamMouthOpenY', value: 0.7 }],
      ['reset'],
    ])
  } finally {
    await close()
  }
})

test('无模型时写工具与 get_model_info 清晰 isError 降级，不崩溃', async () => {
  const { client, controller, close } = await startMcp({ modelLoaded: false })
  try {
    const expr = await client.callTool({ name: 'set_expression', arguments: { expression: 'happy' } })
    assert.equal(expr.isError, true)
    assert.equal(resultJson(expr).success, false)
    assert.match(resultJson(expr).error, /模型未加载/)

    const info = await client.callTool({ name: 'get_model_info', arguments: {} })
    assert.equal(info.isError, true)
    assert.match(resultJson(info).error, /模型未加载/)

    // 窗口控制与 get_status 不依赖模型，仍可用
    const status = await client.callTool({ name: 'get_status', arguments: {} })
    assert.equal(resultJson(status).model.ready, false)
    const win = await client.callTool({ name: 'control_window', arguments: { action: 'hide' } })
    assert.equal(resultJson(win).success, true)
    assert.ok(controller.calls.length === 4)
  } finally {
    await close()
  }
})

test('模型侧业务失败（如不存在） → isError + 清晰错误文本', async () => {
  const { client, close } = await startMcp()
  try {
    const result = await client.callTool({
      name: 'set_expression',
      arguments: { expression: 'nonexistent' },
    })
    assert.equal(result.isError, true)
    const payload = resultJson(result)
    assert.equal(payload.success, false)
    assert.match(payload.error, /nonexistent/)
  } finally {
    await close()
  }
})

test('非法参数一律 isError 拒绝且 controller 零调用（NFR-3）', async () => {
  const { client, controller, close } = await startMcp()
  try {
    const cases = [
      ['control_window', { action: 'explode' }, /action/],
      ['control_window', {}, /action/],
      ['set_expression', { expression: '' }, /expression/],
      ['set_expression', { expression: 42 }, /expression/],
      ['set_expression', {}, /expression/],
      ['play_motion', { group: 'Idle', priority: 0 }, /priority/],
      ['play_motion', { group: 'Idle', priority: 4 }, /priority/],
      ['play_motion', { group: 'Idle', priority: 'high' }, /priority/],
      ['play_motion', { group: 'Idle', index: -1 }, /index/],
      ['play_motion', { group: 'Idle', index: 1.5 }, /index/],
      ['play_motion', { priority: 2 }, /group/],
      ['look_at', { x: 2, y: 0 }, /x/],
      ['look_at', { x: 0, y: 'up' }, /y/],
      ['set_parameter', { param_id: 'Param Mouth', value: 1 }, /param_id/],
      ['set_parameter', { param_id: 'ParamMouthOpenY', value: 'loud' }, /value/],
      ['set_parameter', { param_id: 'ParamMouthOpenY' }, /value/],
    ]
    for (const [name, args, pattern] of cases) {
      const result = await client.callTool({ name, arguments: args })
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} 应被拒绝`)
      assert.match(result.content[0].text, pattern, `${name} 错误文本应指出非法字段`)
    }
    assert.deepEqual(controller.calls, [], '非法调用不得抵达 controller')
  } finally {
    await close()
  }
})

test('未知工具名 → isError 拒绝（不伪装成功；speak 不存在）', async () => {
  const { client, controller, close } = await startMcp()
  try {
    const result = await client.callTool({ name: 'speak', arguments: { text: 'hi' } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /Tool speak not found/)
    assert.deepEqual(controller.calls, [], '未知工具不得抵达 controller')
  } finally {
    await close()
  }
})

test('HTTP 边界：无 session 的非 initialize POST → 400 JSON-RPC 错误；烂 session → 404', async () => {
  const { baseUrl, close } = await startMcp()
  try {
    const noSession = await fetch(`${baseUrl}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.equal(noSession.status, 400)
    const noSessionBody = await noSession.json()
    assert.equal(noSessionBody.jsonrpc, '2.0')
    assert.equal(noSessionBody.error.code, -32000)

    const stale = await fetch(`${baseUrl}${MCP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.equal(stale.status, 404)
    assert.equal((await stale.json()).error.code, -32000)
  } finally {
    await close()
  }
})

test('server 元信息：live2d 系名字', () => {
  assert.equal(SERVER_NAME, 'live2d-companion')
})
