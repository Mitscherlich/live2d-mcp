import { createReadStream, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vite'

const require = createRequire(import.meta.url)

/**
 * Dev-only: serve /user-models/* and /user-core/* from the Mayuka home directory
 * (MAYUKA_HOME or ~/.mayuka). Prod serves the same URLs from the live2d-app:// scheme handler.
 * Both go through electron/user-assets.cjs so the containment rules are identical.
 */
function mayukaUserAssets(): Plugin {
  return {
    name: 'mayuka-user-assets',
    configureServer(server) {
      const { isUserAssetPath, resolveUserAsset } = require('../electron/user-assets.cjs')
      const { mayukaHome } = require('../electron/mayuka-paths.cjs')
      const { mimeFor } = require('../electron/renderer-protocol.cjs')
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        if (!isUserAssetPath(pathname)) return next()
        const file = resolveUserAsset(mayukaHome(), pathname)
        let ok = false
        try {
          ok = Boolean(file) && statSync(file).isFile()
        } catch {
          ok = false
        }
        if (!ok) {
          res.statusCode = 404
          res.end('Not found')
          return
        }
        res.setHeader('Content-Type', mimeFor(file))
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
  }
}

// ADR 0001 · F2：dev server 只服务 Electron 角色窗（scripts/dev-electron.mjs），
// 从不自动弹浏览器；strictPort 保证 dev 脚本等待的端口确定。
export default defineConfig({
  plugins: [mayukaUserAssets()],
  resolve: {
    // renderer/node_modules 仍有 pixi-live2d-display 带入的 Pixi 6。
    // 不钉死时，Vite 预构建会把裸导入 pixi.js 解析成 6.5.10，
    // Application.init 不存在，加载失败又被显示成「未找到模型」。
    dedupe: ['pixi.js'],
  },
  server: {
    // 固定 IPv4 loopback：默认 'localhost' 在本机仅绑定 ::1，
    // dev-electron 脚本与 Electron 均以 127.0.0.1 访问（与 SPEC loopback 边界一致）
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: false,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { main: 'index.html', preview: 'preview.html' },
    },
  },
})
