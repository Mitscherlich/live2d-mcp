'use strict'

/** 设置窗展示模型（ADR 0001 · F7 · FR-S2），无 Electron 依赖。 */

const {
  DEFAULT_PORT,
  buildCodexMcpCommand,
  mcpHttpUrl,
  resolveBridgePort,
} = require('./bridge-endpoint.cjs')

function configuredBridgePort(environment = process.env) {
  return resolveBridgePort(environment?.LIVE2D_BRIDGE_PORT) ?? DEFAULT_PORT
}

function buildMcpUrl({ actualPort, environment = process.env } = {}) {
  const port = Number.isInteger(actualPort) && actualPort > 0
    ? actualPort
    : configuredBridgePort(environment)
  return mcpHttpUrl(port)
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
  buildMcpUrl,
  buildSettingsViewModel,
  configuredBridgePort,
}
