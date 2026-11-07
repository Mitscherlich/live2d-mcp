/**
 * 渲染器入口（组合根）：启动期断言 preload 窄 API → 动态加载渲染核心 →
 * 按「模型缺失不阻断 voice/command 通道」（SPEC §10.3）挂接各控制器。
 * 各控制器自身持有状态与监听；本文件只做接线，顺序即生命周期顺序。
 */

import type { Live2DApp } from './live2d-app.js'
import type { ActiveModelResponse } from './live2d-bridge.js'
import { sanitizeOverrides } from './model-config.js'
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

  const emptyState = document.getElementById('empty-state')
  document.getElementById('empty-state-open')?.addEventListener('click', () => {
    void api.openSettings()
  })
  const setEmpty = (visible: boolean) => {
    if (emptyState) emptyState.hidden = !visible
  }

  // Voice and command channels attach up front: a missing model must never block them (SPEC §10.3).
  const voice = new VoiceController(null, api, statusBar)
  const commands = new CommandDispatcher(null, api, statusBar)

  let app: Live2DApp | null = null
  let coreInjected = false
  let bootError: unknown = null

  /** Inject Cubism Core on demand: it ships with the user's library, not with the app. */
  const injectCore = (url: string) =>
    new Promise<void>((resolve, reject) => {
      if (coreInjected) return resolve()
      const script = document.createElement('script')
      script.src = url
      script.onload = () => {
        coreInjected = true
        resolve()
      }
      script.onerror = () => reject(new Error('Cubism Core failed to load'))
      document.head.appendChild(script)
    })

  /** First-time runtime boot: dynamic import (the engine throws at module load without Core) + init + controllers. */
  const ensureApp = async (coreUrl: string): Promise<Live2DApp> => {
    if (app) return app
    await injectCore(coreUrl)
    const mod = await import('./live2d-app.js')
    const created = new mod.Live2DApp()
    await created.init(canvas)
    const mouseFollow = new MouseFollow(created, api, buttonGroup)
    new ClickInteraction(canvas, created, statusBar, buttonGroup, api, UI_CHROME)
    if (UI_CHROME) {
      const { DebugPanel } = await import('./debug-panel.js')
      new DebugPanel(created, statusBar, mouseFollow)
    }
    app = created
    commands.setApp(created)
    voice.setApp(created)
    return created
  }

  let queue: Promise<unknown> = Promise.resolve()
  /** Apply the active model (boot, hot swap, or Core just installed). Serialized. */
  const apply = (active: ActiveModelResponse): Promise<{ ok: boolean; error?: string }> => {
    const run = queue.then(async () => {
      if (active.missing) {
        // Nothing to show yet. If a model is already running keep it; otherwise the guide card.
        if (!app?.isLoaded()) {
          statusBar.setModelStatus(false)
          setEmpty(true)
        }
        return { ok: true }
      }
      try {
        const a = await ensureApp(active.coreUrl)
        await a.loadModel(active.modelUrl, sanitizeOverrides(active.overrides))
        bootError = null
        setEmpty(false)
        document.getElementById('model-load-error')?.style.removeProperty('display')
        statusBar.setModelStatus(true)
        voice.rebindMouth()
        return { ok: true }
      } catch (e) {
        console.error('[Main] Failed to load model:', e)
        bootError = e
        // A failed swap keeps the previous model; only a failed first load shows the error card.
        if (!app?.isLoaded()) {
          statusBar.setModelStatus(false)
          showModelLoadError(e)
        }
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })
    queue = run.catch(() => {})
    return run
  }

  api.onModelChanged(({ requestId, active }) => {
    void apply(active).then((r) => api.reportModelLoad(requestId, r.ok, r.error))
  })
  void bootError

  await apply(await api.getActiveModel())
}

main().catch(console.error)
