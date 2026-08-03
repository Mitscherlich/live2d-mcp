/**
 * Electron preload（electron/preload.cjs）暴露的最小只读 API 类型声明。
 * 浏览器（legacy 双进程路径）环境下不存在 window.live2d。
 * F3 将在此扩展 level/state 事件订阅。
 */

export {}

declare global {
  interface Window {
    live2d?: {
      isElectron: true
      platform: string
      versions: {
        electron?: string
        chrome?: string
        node?: string
      }
    }
  }
}
