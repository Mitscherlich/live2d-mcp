'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildCodexMcpCommand,
  buildMcpUrl,
  buildSettingsViewModel,
  configuredBridgePort,
} = require('../settings-view.cjs')

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
