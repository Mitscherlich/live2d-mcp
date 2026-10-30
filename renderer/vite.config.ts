import { defineConfig } from 'vite'

// ADR 0001 · F2：dev server 只服务 Electron 角色窗（scripts/dev-electron.mjs），
// 从不自动弹浏览器；strictPort 保证 dev 脚本等待的端口确定。
export default defineConfig({
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
      input: 'index.html',
    },
  },
})
