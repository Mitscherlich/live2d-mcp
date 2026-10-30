'use strict'

/**
 * Bridge 连接端点（零依赖常量/纯函数，ADR 0001 · F4/F5/F7 共有）
 *
 * loopback bridge 的地址常量与 URL 拼装唯一实现点。与 mcp-protocol.cjs 同型：
 * 抽成零依赖模块是为了让 settings-view / main 等不必为拿常量而 require 整个
 * HTTP 层（bridge-server.cjs）或 MCP SDK。
 *
 * 纯函数、无第三方依赖：node:test 直接 require 单测。
 */

const { MCP_PATH } = require('./mcp-protocol.cjs')

const DEFAULT_PORT = 47832
const LOOPBACK_HOST = '127.0.0.1'

/**
 * 解析 LIVE2D_BRIDGE_PORT：合法返回 1-65535 整数，非法/缺失返回 null（调用方回退默认）。
 * @param {unknown} raw env 原值
 */
function resolveBridgePort(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** bridge base URL（仅 loopback；host 不可配，见 bridge-server.cjs 模块边界防线） */
function bridgeHttpUrl(port) {
  return `http://${LOOPBACK_HOST}:${port}`
}

/** Streamable HTTP MCP 端点 URL */
function mcpHttpUrl(port) {
  return `${bridgeHttpUrl(port)}${MCP_PATH}`
}

/** 设置窗与启动日志共用的 codex 接入命令 */
function buildCodexMcpCommand(mcpUrl) {
  return `codex mcp add live2d --url ${mcpUrl}`
}

/** 设置窗展示的 Claude Code 接入命令（Streamable HTTP） */
function buildClaudeMcpCommand(mcpUrl) {
  return `claude mcp add --transport http live2d ${mcpUrl}`
}

module.exports = {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  bridgeHttpUrl,
  buildClaudeMcpCommand,
  buildCodexMcpCommand,
  mcpHttpUrl,
  resolveBridgePort,
}
