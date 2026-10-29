/**
 * 渲染器入口（组合根）：启动期断言 preload 窄 API → 动态加载渲染核心 →
 * 按「模型缺失不阻断 voice/command 通道」（SPEC §10.3）挂接各控制器。
 * 各控制器自身持有状态与监听；本文件只做接线，顺序即生命周期顺序。
 */

import type { Live2DApp } from './live2d-app.js'
import { initButtonGroup } from './button-group.js'
import { showModelLoadError } from './boot-error.js'
import { StatusBar } from './status-bar.js'
import { WindowControls } from './window-controls.js'
import { MouseFollow } from './mouse-follow.js'
import { ClickInteraction } from './click-interaction.js'
import { VoiceController } from './voice-controller.js'
import { CommandDispatcher } from './command-dispatcher.js'

/**
 * 顶部状态栏 + 底部调试条是否显示：**读 public/ui-chrome-boot.js 的判定结果**
 * （boot 早于本模块执行、写在 documentElement 上以防首屏闪一下），此处不重复判定。
 * 关闭时（默认的陪伴模式）：状态栏/调试面板被 CSS 隐藏，相关 DOM 一律不构建、不写入。
 */
const UI_CHROME = document.documentElement.classList.contains('ui-chrome')

const canvas = document.getElementById('live2d-canvas') as HTMLCanvasElement
const canvasContainer = document.getElementById('canvas-container') as HTMLDivElement

async function main() {
  // Electron 壳：透明底；顶/底工具条默认隐藏（见 index.html electron-mode:not(.ui-chrome)）。
  // ui-chrome 由 boot 脚本判定并写在 documentElement 上，这里只同步到 body。
  document.documentElement.classList.add('electron-mode')
  document.body.classList.add('electron-mode')
  if (UI_CHROME) {
    document.body.classList.add('ui-chrome')
    console.log('[Main] UI chrome 已开启（调试/显式开关）')
  } else {
    console.log('[Main] UI chrome 已隐藏（陪伴模式；调试用 LIVE2D_UI_CHROME=1 或 ?debug=1）')
  }

  // 启动期一次性断言：preload 未暴露窄 API 时窗口交互/voice/命令通道全部无从谈起，
  // 直接进引导并中止（替代此前散在各模块的可选链降级与「preload 未暴露」警告）。
  const api = window.live2d
  if (!api) {
    showModelLoadError()
    throw new Error('preload 未暴露 window.live2d（渲染器须在 Electron 壳内运行）')
  }
  console.log(`[Main] Running inside Electron ${api.versions.electron ?? ''} (${api.platform})`)

  const statusBar = new StatusBar(UI_CHROME)
  const buttonGroup = initButtonGroup()
  new WindowControls(canvasContainer, api, buttonGroup)

  // 动态导入渲染核心：untitled-pixi-live2d-engine/cubism 在缺少 live2dcubismcore.min.js 时于
  // 模块加载期抛错（"Could not find Cubism runtime"）；静态 import 会带走整个入口，
  // 缺模引导（FR-D3）将无从显示。Core 缺失与模型 404 两类失败都必须落入引导 UI。
  let app: Live2DApp | null = null
  try {
    const mod = await import('./live2d-app.js')
    app = new mod.Live2DApp()
  } catch (e) {
    console.error('[Main] Failed to load Live2D runtime（Cubism Core 未加载？）:', e)
    statusBar.setModelStatus(false)
    showModelLoadError()
  }

  if (app) {
    try {
      await app.init(canvas)
      statusBar.setModelStatus(true)
      console.log('[Main] Live2D app initialized')
      // 鼠标跟随 / 点击触发动作是陪伴模式的真实功能；调试面板只在 ui-chrome 下构建
      const mouseFollow = new MouseFollow(app, api, buttonGroup)
      new ClickInteraction(canvas, app, statusBar, buttonGroup, api, UI_CHROME)
      if (UI_CHROME) {
        const { DebugPanel } = await import('./debug-panel.js')
        new DebugPanel(app, statusBar, mouseFollow)
      }
    } catch (e) {
      statusBar.setModelStatus(false)
      showModelLoadError()
      console.error('[Main] Failed to initialize Live2D:', e)
    }
  }

  // voice 事件由 main 经 preload IPC 推送（F3/F4），表情/动作等视觉命令自 F5 起
  // 经 main↔renderer 命令通道执行。模型缺失绝不允许阻断这两条通道的挂接
  // （SPEC §10.3 降级要求）。
  new VoiceController(app, api, statusBar)
  new CommandDispatcher(app, api, statusBar)
}

main().catch(console.error)
