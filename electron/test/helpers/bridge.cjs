'use strict'

/**
 * electron/test 共享测试辅助
 *
 * bridge-server 与 mcp-server 的单测都走「真实 HTTP 链路」：进程内起一个临时端口
 * 的 bridge，再用 fetch / 官方 MCP client 打它。起停 bridge 与 JSON POST 这两件事
 * 两个文件此前各写了一份，这里收敛成单一实现。
 */

const assert = require('node:assert/strict')

const { createBridgeServer } = require('../../bridge-server.cjs')

/** 最小 mcpHandler：/mcp 委托契约以外的用例不关心其行为，回 200 空对象即可 */
async function noopMcpHandler(_request, response) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end('{}')
}

/**
 * 起临时端口的 bridge 实例；opts 覆盖默认的 port/onEvent/mcpHandler。
 * @returns {Promise<{ bridge, baseUrl: string, close: () => Promise<void> }>}
 */
async function startBridge(opts = {}) {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => true,
    mcpHandler: noopMcpHandler,
    ...opts,
  })
  const address = await bridge.listen()
  return { bridge, baseUrl: `http://127.0.0.1:${address.port}`, close: () => bridge.close() }
}

/** POST JSON；body 为字符串时原样发送（用于「坏 JSON → 400」这类用例）。 */
async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** MCP 工具结果解析为 JSON，顺带断言它确实是 text content。 */
function resultJson(result) {
  assert.ok(result.content?.[0]?.type === 'text', '工具结果应为 text content')
  return JSON.parse(result.content[0].text)
}

module.exports = { noopMcpHandler, postJson, resultJson, startBridge }
