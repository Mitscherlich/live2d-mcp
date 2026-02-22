/**
 * 入口文件 - 根据命令行参数选择运行模式
 *
 * 用法：
 *   node dist/index.js --stdio   # stdio 模式（供 Claude Desktop 使用）
 *   node dist/index.js --http    # HTTP 模式（供自研 AI 程序使用）
 *   node dist/index.js           # 默认 HTTP 模式
 */

import 'dotenv/config'
import { runStdio, runHttp } from './mcp-server.js'

const args = process.argv.slice(2)
const mode = args.includes('--stdio') ? 'stdio' : 'http'

async function main() {
  try {
    if (mode === 'stdio') {
      await runStdio()
    } else {
      await runHttp()
    }
  } catch (err) {
    console.error('[MCP] Fatal error:', err)
    process.exit(1)
  }
}

main()
