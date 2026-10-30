'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildMcpUrl,
  buildSettingsViewModel,
  configuredBridgePort,
  derivePermission,
} = require('../settings-view.cjs')
const { buildCodexMcpCommand } = require('../bridge-endpoint.cjs')

test('MCP URL 优先反映 bridge 实际监听端口', () => {
  assert.equal(
    buildMcpUrl({ actualPort: 51234, environment: { LIVE2D_BRIDGE_PORT: '49999' } }),
    'http://127.0.0.1:51234/mcp',
  )
})

test('bridge 尚未监听时 MCP URL 反映合法环境端口，非法值回退 47832', () => {
  assert.equal(configuredBridgePort({ LIVE2D_BRIDGE_PORT: '49001' }), 49001)
  assert.equal(configuredBridgePort({ LIVE2D_BRIDGE_PORT: 'bad' }), 47832)
  assert.equal(
    buildMcpUrl({ actualPort: null, environment: { LIVE2D_BRIDGE_PORT: '49001' } }),
    'http://127.0.0.1:49001/mcp',
  )
})

test('设置视图包含可复制的 codex 命令与实际 voice source', () => {
  const view = buildSettingsViewModel({
    actualPort: 47832,
    environment: {},
    voiceSource: {
      mode: 'custom',
      process_pattern: 'codex',
      source_id: null,
      source_name: null,
    },
    listener: { status: 'running' },
    environmentOverridesVoice: false,
  })

  assert.equal(view.mcpUrl, 'http://127.0.0.1:47832/mcp')
  assert.equal(
    view.codexCommand,
    'codex mcp add live2d --url http://127.0.0.1:47832/mcp',
  )
  assert.equal(buildCodexMcpCommand(view.mcpUrl), view.codexCommand)
  assert.equal(view.voiceSource.mode, 'custom')
  assert.equal(view.listener.status, 'running')
})

test('设置视图同时给出 Claude Code 命令、端口与角色窗/登录项状态', () => {
  const view = buildSettingsViewModel({
    actualPort: 49001,
    environment: {},
    voiceSource: { mode: 'automatic' },
    listener: { status: 'permission-denied' },
    avatar: { visible: true, x: 10, y: 20, width: 600, height: 640, scale: 1.25 },
    loginItem: { supported: true, openAtLogin: true },
    settingsFilePath: '/tmp/settings.json',
    versions: { app: '0.1.0', electron: '39.8.10' },
  })
  assert.equal(view.port, 49001)
  assert.equal(view.claudeCommand, 'claude mcp add --transport http live2d http://127.0.0.1:49001/mcp')
  assert.equal(view.permission, 'denied')
  assert.equal(view.avatar.scale, 1.25)
  assert.deepEqual(view.loginItem, { supported: true, openAtLogin: true })
  assert.equal(view.settingsFilePath, '/tmp/settings.json')
})

test('未提供登录项时视图回退为不支持', () => {
  const view = buildSettingsViewModel({ actualPort: null, environment: {}, voiceSource: {} })
  assert.deepEqual(view.loginItem, { supported: false, openAtLogin: false })
  assert.equal(view.port, 47832)
  assert.equal(view.bridgeListening, false)
})

test('权限推导只信 listener 摘要，拿不准时报 unknown', () => {
  assert.equal(derivePermission({ status: 'permission-denied' }), 'denied')
  assert.equal(derivePermission({ status: 'running' }), 'granted')
  assert.equal(derivePermission({ status: 'idle' }), 'granted')
  assert.equal(derivePermission({ status: 'disabled' }), 'not-required')
  assert.equal(derivePermission({ status: 'starting' }), 'unknown')
  assert.equal(derivePermission({ status: 'error' }), 'unknown')
  assert.equal(derivePermission(null), 'unknown')
})
