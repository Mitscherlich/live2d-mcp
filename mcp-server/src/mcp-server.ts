/**
 * MCP Server 核心 - 注册所有工具并配置传输方式
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import { startWebSocketServer } from './ws-bridge.js'
import { registerExpressionTools } from './tools/expression.js'
import { registerMotionTools } from './tools/motion.js'
import { registerParameterTools } from './tools/parameter.js'
import { registerQueryTools } from './tools/query.js'

const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? '3000', 10)

function createServer(): McpServer {
  const server = new McpServer({
    name: 'live2d-controller',
    version: '0.1.0',
  })

  // 注册所有工具
  registerExpressionTools(server)
  registerMotionTools(server)
  registerParameterTools(server)
  registerQueryTools(server)

  return server
}

export async function runStdio(): Promise<void> {
  console.error('[MCP] Starting in stdio mode...')
  startWebSocketServer()

  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[MCP] Server running on stdio')
}

export async function runHttp(): Promise<void> {
  console.error(`[MCP] Starting in HTTP mode on port ${HTTP_PORT}...`)
  startWebSocketServer()

  const app = express()
  app.use(express.json())

  // 每个连接创建独立的 MCP Server 实例
  app.all('/mcp', async (req, res) => {
    const server = createServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // stateless
    })
    res.on('close', () => {
      transport.close().catch(console.error)
      server.close().catch(console.error)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'http', wsPort: process.env.WS_PORT ?? '8765' })
  })

  app.listen(HTTP_PORT, () => {
    console.error(`[MCP] HTTP server listening on http://localhost:${HTTP_PORT}/mcp`)
    console.error(`[MCP] Health check: http://localhost:${HTTP_PORT}/health`)
  })
}
