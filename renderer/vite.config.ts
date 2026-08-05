import { defineConfig } from 'vite'

// ADR 0001 · F2：Electron dev（scripts/dev-electron.mjs）注入 LIVE2D_DEV_ELECTRON=1，
// 此时不再自动弹浏览器（窗口由 Electron 承载）；strictPort 保证 dev 脚本等待的端口确定。
// 浏览器遗留路径（dev:renderer / dev:legacy）保持原有 open 行为不变。
export default defineConfig({
  server: {
    // 固定 IPv4 loopback：默认 'localhost' 在本机仅绑定 ::1，
    // dev-electron 脚本与 Electron 均以 127.0.0.1 访问（与 SPEC loopback 边界一致）
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: !process.env.LIVE2D_DEV_ELECTRON,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
    },
  },
})
