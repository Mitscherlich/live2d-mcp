'use strict'

/** 设置窗展示模型（ADR 0001 · F7 · FR-S2），无 Electron 依赖。 */

const {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  resolveBridgePort,
} = require('./bridge-server.cjs')
const { MCP_PATH } = require('./mcp-protocol.cjs')

function configuredBridgePort(environment = process.env) {
  return resolveBridgePort(environment?.LIVE2D_BRIDGE_PORT) ?? DEFAULT_PORT
}

function buildMcpUrl({ actualPort, environment = process.env } = {}) {
  const port = Number.isInteger(actualPort) && actualPort > 0
    ? actualPort
    : configuredBridgePort(environment)
  return `http://${LOOPBACK_HOST}:${port}${MCP_PATH}`
}

function buildCodexMcpCommand(mcpUrl) {
  return `codex mcp add live2d --url ${mcpUrl}`
}

function buildSettingsViewModel({
  actualPort,
  environment = process.env,
  voiceSource,
  listener,
  environmentOverridesVoice = false,
} = {}) {
  const mcpUrl = buildMcpUrl({ actualPort, environment })
  return {
    mcpUrl,
    codexCommand: buildCodexMcpCommand(mcpUrl),
    voiceSource: { ...voiceSource },
    listener: listener ? { ...listener } : null,
    environmentOverridesVoice: Boolean(environmentOverridesVoice),
    bridgeListening: Number.isInteger(actualPort) && actualPort > 0,
  }
}

module.exports = {
  buildCodexMcpCommand,
  buildMcpUrl,
  buildSettingsViewModel,
  configuredBridgePort,
}
