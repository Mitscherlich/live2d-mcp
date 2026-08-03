'use strict'

/**
 * 沙箱 preload（ADR 0001 · F2）
 *
 * 仅暴露最小只读运行环境信息（window.live2d），供 renderer 判定自身
 * 运行在 Electron 壳内（WS 降级、透明背景、窗口拖拽区等适配）。
 * F3 将在此扩展 level/state 事件通道，F4 接入 bridge 推送。
 *
 * 安全边界（NFR-2）：不得暴露任意 Node/fs/IPC 能力。
 */

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('live2d', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
