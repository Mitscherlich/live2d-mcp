'use strict'

/**
 * MCP 协议常量与传输前错误响应（ADR 0001 · F5）
 *
 * 本模块**零第三方依赖**（不引 @modelcontextprotocol/sdk、不引 zod），只放
 * 挂载路径与 JSON-RPC 错误帧这类协议层事实。这样：
 *  - bridge-server.cjs 名副其实保持纯 node:http（此前为了 sendJsonRpcError
 *    require mcp-server.cjs，把整个 SDK 拉进了 HTTP 层的模块图）；
 *  - settings-view.cjs 只为拼一个 MCP URL 而需要 MCP_PATH，不必加载 SDK
 *    （其纯函数单测因此不再付 SDK 加载成本）。
 *
 * MCP_PATH / sendJsonRpcError 以本模块为**唯一出口**：mcp-server.cjs 只消费、
 * 不再转出，避免同一符号双来源。
 */

/** bridge 上 Streamable HTTP MCP 的挂载路径 */
const MCP_PATH = '/mcp'

// JSON-RPC 2.0 错误码：前两个为规范保留码，SERVER_ERROR 为实现自定义区间
// （-32000..-32099），本仓用于 body 超限与 session 缺失/失效。
const JSON_RPC_PARSE_ERROR = -32700
const JSON_RPC_INTERNAL_ERROR = -32603
const JSON_RPC_SERVER_ERROR = -32000

/**
 * 写出一帧 JSON-RPC 错误响应。
 * 用于 transport 接管之前就已失败的请求（body 解析失败、session 缺失、
 * handler 抛异常），使 MCP 客户端仍能按协议解析到错误而不是拿到裸 HTTP 文本。
 * @param {import('node:http').ServerResponse} response
 * @param {number} status HTTP 状态码
 * @param {number} code JSON-RPC 错误码
 * @param {string} message 错误描述（不含用户内容）
 */
function sendJsonRpcError(response, status, code, message) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

module.exports = {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_ERROR,
  MCP_PATH,
  sendJsonRpcError,
}
