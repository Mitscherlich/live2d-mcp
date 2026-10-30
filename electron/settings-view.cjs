'use strict'

/** 设置窗展示模型（ADR 0001 · F7 · FR-S2；DESIGN.md §4.3），无 Electron 依赖。 */

const {
  DEFAULT_PORT,
  buildClaudeMcpCommand,
  buildCodexMcpCommand,
  mcpHttpUrl,
  resolveBridgePort,
} = require('./bridge-endpoint.cjs')

function configuredBridgePort(environment = process.env) {
  return resolveBridgePort(environment?.LIVE2D_BRIDGE_PORT) ?? DEFAULT_PORT
}

function displayedPort({ actualPort, environment = process.env } = {}) {
  return Number.isInteger(actualPort) && actualPort > 0
    ? actualPort
    : configuredBridgePort(environment)
}

function buildMcpUrl({ actualPort, environment = process.env } = {}) {
  return mcpHttpUrl(displayedPort({ actualPort, environment }))
}

/**
 * 录屏权限推导（DESIGN.md §5.3）：主进程没有独立的 TCC 查询，
 * 以 listener 摘要为唯一来源——拿不准时如实报 unknown，不假报 granted。
 * @param {{ status?: string } | null | undefined} listener
 * @returns {'granted'|'denied'|'not-required'|'unknown'}
 */
function derivePermission(listener) {
  switch (listener?.status) {
    case 'permission-denied':
      return 'denied'
    case 'running':
    case 'idle':
      return 'granted'
    case 'disabled':
      return 'not-required'
    default:
      return 'unknown'
  }
}

function buildSettingsViewModel({
  actualPort,
  environment = process.env,
  voiceSource,
  listener,
  environmentOverridesVoice = false,
  avatar = null,
  loginItem = null,
  settingsFilePath = null,
  versions = null,
} = {}) {
  const port = displayedPort({ actualPort, environment })
  const mcpUrl = mcpHttpUrl(port)
  return {
    mcpUrl,
    port,
    codexCommand: buildCodexMcpCommand(mcpUrl),
    claudeCommand: buildClaudeMcpCommand(mcpUrl),
    voiceSource: { ...voiceSource },
    listener: listener ? { ...listener } : null,
    permission: derivePermission(listener),
    environmentOverridesVoice: Boolean(environmentOverridesVoice),
    bridgeListening: Number.isInteger(actualPort) && actualPort > 0,
    avatar: avatar ? { ...avatar } : null,
    loginItem: loginItem ? { ...loginItem } : { supported: false, openAtLogin: false },
    settingsFilePath,
    versions: versions ? { ...versions } : null,
  }
}

module.exports = {
  buildMcpUrl,
  buildSettingsViewModel,
  configuredBridgePort,
  derivePermission,
}
