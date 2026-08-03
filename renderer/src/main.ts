/**
 * 渲染器入口
 * 1. 初始化 Live2D 应用
 * 2. 建立 WebSocket 连接
 * 3. 绑定命令处理器
 * 4. 更新状态栏 UI
 */

import type { Live2DApp } from './live2d-app.js'
import { WsClient } from './ws-client.js'
import { createCommandHandler } from './command-handler.js'

// ADR 0001 · F2：Electron 壳经 preload 暴露 window.live2d；浏览器（legacy 双进程）无此对象
const isElectron = typeof window.live2d !== 'undefined'

const canvas = document.getElementById('live2d-canvas') as HTMLCanvasElement
const wsDot = document.getElementById('ws-dot') as HTMLDivElement
const wsStatus = document.getElementById('ws-status') as HTMLSpanElement
const modelDot = document.getElementById('model-dot') as HTMLDivElement
const modelStatus = document.getElementById('model-status') as HTMLSpanElement
const currentStateEl = document.getElementById('current-state') as HTMLDivElement
const debugPanel = document.getElementById('debug-panel') as HTMLDivElement
const debugHeader = debugPanel.querySelector('.debug-header') as HTMLDivElement
const debugToggleBtn = document.getElementById('debug-toggle-btn') as HTMLButtonElement
const debugExpressionsEl = document.getElementById('debug-expressions') as HTMLDivElement
const debugMotionsEl = document.getElementById('debug-motions') as HTMLDivElement
const lookXInput = document.getElementById('look-x') as HTMLInputElement
const lookXVal = document.getElementById('look-x-val') as HTMLSpanElement
const lookYInput = document.getElementById('look-y') as HTMLInputElement
const lookYVal = document.getElementById('look-y-val') as HTMLSpanElement
const debugResetBtn = document.getElementById('debug-reset') as HTMLButtonElement
const debugClickLog = document.getElementById('debug-click-log') as HTMLDivElement
const hitareaToggle = document.getElementById('hitarea-toggle') as HTMLInputElement
const mouseFollowCheckbox = document.getElementById('mouse-follow') as HTMLInputElement

let currentExpression = '-'
let currentMotion = '-'

const MOTION_NAMES: Record<string, string> = {
  'Idle:0': '待机',
  'Idle:1': '待机 2',
  'Idle:2': '待机 3',
  'Flick:0': '拨动',
  'FlickDown:0': '低头',
  'FlickUp:0': '抬头',
  'Tap:0': '点击',
  'Tap:1': '点击反应',
  'Tap@Body:0': '触摸身体',
  'Flick@Body:0': '挥手 (wave)',
}

function motionLabel(group: string, index?: number): string {
  const key = `${group}:${index ?? 0}`
  return MOTION_NAMES[key] ?? `${group}[${index ?? 'rand'}]`
}

function updateStateBar() {
  currentStateEl.textContent = `表情: ${currentExpression} | 动作: ${currentMotion}`
}

// 点击区域 → 动作分组映射
const HIT_AREA_MOTIONS: Record<string, string> = {
  Body: 'Tap@Body',
}

function appendClickLog(px: number, py: number, hitAreas: string[], action: string | null) {
  const entry = document.createElement('div')
  entry.className = 'click-log-entry'
  const coord = `(${Math.round(px)}, ${Math.round(py)})`
  if (action) {
    entry.innerHTML =
      `${coord} hit: <span class="log-hit">[${hitAreas.join(', ')}]</span>` +
      ` → <span class="log-action">${action}</span>`
  } else {
    entry.innerHTML =
      `${coord} <span class="log-miss">miss (no hit area)</span>`
  }
  debugClickLog.appendChild(entry)
  // 最多保留 30 条
  while (debugClickLog.children.length > 30) {
    debugClickLog.firstElementChild?.remove()
  }
  // 自动滚到最新
  const logPane = document.getElementById('pane-log')
  if (logPane) logPane.scrollTop = logPane.scrollHeight
}

function initClickInteraction(app: Live2DApp) {
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    // 转换为 canvas 物理像素坐标（考虑 devicePixelRatio 缩放）
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY

    const hitAreas = app.hitTest(x, y)

    if (hitAreas.length === 0) {
      appendClickLog(x, y, [], null)
      return
    }

    let group = 'Tap'
    for (const area of hitAreas) {
      if (HIT_AREA_MOTIONS[area]) {
        group = HIT_AREA_MOTIONS[area]
        break
      }
    }

    app.playMotion(group, undefined, 2)
    currentMotion = group
    updateStateBar()
    appendClickLog(x, y, hitAreas, group)
  })
}

function initMouseFollow(app: Live2DApp) {
  function setSliderDisabled(disabled: boolean) {
    lookXInput.disabled = disabled
    lookYInput.disabled = disabled
  }

  // 默认开启，禁用手动滑块
  setSliderDisabled(true)

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!mouseFollowCheckbox.checked) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(-1, Math.min(1, (e.clientX - rect.left - rect.width / 2) / (rect.width / 2)))
    const y = Math.max(-1, Math.min(1, -((e.clientY - rect.top - rect.height / 2) / (rect.height / 2))))
    app.lookAt(x, y)
  })

  mouseFollowCheckbox.addEventListener('change', () => {
    const following = mouseFollowCheckbox.checked
    setSliderDisabled(following)
    if (!following) {
      // 关闭时重置视线到滑块当前值
      app.lookAt(parseFloat(lookXInput.value), parseFloat(lookYInput.value))
    }
  })
}

function initDebugPanel(app: Live2DApp) {
  // 展开/收起：仅 toggle 按钮触发
  debugToggleBtn.addEventListener('click', () => {
    const expanded = debugPanel.classList.toggle('expanded')
    debugToggleBtn.textContent = expanded ? '▼ 收起' : '▲ 展开'
  })

  // Tab 切换
  const tabs = debugHeader.querySelectorAll<HTMLButtonElement>('.debug-tab')
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'))
      tab.classList.add('active')
      const paneId = `pane-${tab.dataset.tab}`
      debugPanel.querySelectorAll<HTMLDivElement>('.debug-pane').forEach((p) => {
        p.classList.toggle('active', p.id === paneId)
      })
      // 切换 tab 时若面板未展开则自动展开
      if (!debugPanel.classList.contains('expanded')) {
        debugPanel.classList.add('expanded')
        debugToggleBtn.textContent = '▼ 收起'
      }
    })
  })

  const info = app.getModelInfo()
  let activeExprBtn: HTMLButtonElement | null = null
  let activeBtn: HTMLButtonElement | null = null

  // 动态生成表情按钮
  if (info && info.expressions.length > 0) {
    for (const name of info.expressions) {
      const btn = document.createElement('button')
      btn.className = 'motion-btn'
      btn.textContent = name
      btn.addEventListener('click', () => {
        app.setExpression(name)
        currentExpression = name
        updateStateBar()
        activeExprBtn?.classList.remove('active')
        btn.classList.add('active')
        activeExprBtn = btn
      })
      debugExpressionsEl.appendChild(btn)
    }
  } else {
    debugExpressionsEl.textContent = '无可用表情'
    debugExpressionsEl.style.color = '#555'
    debugExpressionsEl.style.fontSize = '11px'
  }

  // 动态生成动作按钮
  if (info) {
    for (const [group, count] of Object.entries(info.motionGroups)) {
      for (let i = 0; i < count; i++) {
        const btn = document.createElement('button')
        btn.className = 'motion-btn'
        btn.textContent = motionLabel(group, i)
        btn.dataset.group = group
        btn.dataset.index = String(i)
        btn.addEventListener('click', () => {
          app.playMotion(group, i, 3)
          currentMotion = motionLabel(group, i)
          updateStateBar()
          activeBtn?.classList.remove('active')
          btn.classList.add('active')
          activeBtn = btn
        })
        debugMotionsEl.appendChild(btn)
      }
    }
  }

  // 视线控制
  function applyLookAt() {
    const x = parseFloat(lookXInput.value)
    const y = parseFloat(lookYInput.value)
    lookXVal.textContent = x.toFixed(2)
    lookYVal.textContent = y.toFixed(2)
    app.lookAt(x, y)
  }
  lookXInput.addEventListener('input', applyLookAt)
  lookYInput.addEventListener('input', applyLookAt)

  // 重置
  debugResetBtn.addEventListener('click', () => {
    app.reset()
    lookXInput.value = '0'
    lookYInput.value = '0'
    lookXVal.textContent = '0.00'
    lookYVal.textContent = '0.00'
    if (!mouseFollowCheckbox.checked) app.lookAt(0, 0)
    activeExprBtn?.classList.remove('active')
    activeExprBtn = null
    activeBtn?.classList.remove('active')
    activeBtn = null
    currentExpression = '-'
    currentMotion = '-'
    updateStateBar()
  })
}

// FR-D3：缺模型 / Cubism Core 时展示引导（live2d-app.ts 的 loadModel 亦会触发，幂等）
function showModelLoadError() {
  const el = document.getElementById('model-load-error')
  if (el) el.style.display = 'block'
}

async function main() {
  if (isElectron) {
    // Electron 壳适配：透明窗体下去掉页面底色、状态栏变为窗口拖拽区（样式见 index.html）
    document.body.classList.add('electron-mode')
    console.log(
      `[Main] Running inside Electron ${window.live2d?.versions.electron ?? ''} (${window.live2d?.platform ?? 'unknown'})`
    )
  }

  // 动态导入渲染核心：pixi-live2d-display/cubism4 在缺少 live2dcubismcore.min.js 时于
  // 模块加载期抛错（"Could not find Cubism 4 runtime"）；静态 import 会带走整个入口，
  // 缺模引导（FR-D3）将无从显示。Core 缺失与模型 404 两类失败都必须落入引导 UI。
  let app: Live2DApp | null = null
  try {
    const mod = await import('./live2d-app.js')
    app = new mod.Live2DApp()
  } catch (e) {
    console.error('[Main] Failed to load Live2D runtime（Cubism Core 未加载？）:', e)
    modelStatus.textContent = '模型加载失败'
    showModelLoadError()
  }

  if (app) {
    const live2d = app
    try {
      await live2d.init(canvas)
      modelDot.classList.add('connected')
      modelStatus.textContent = '模型已加载'
      console.log('[Main] Live2D app initialized')
      initDebugPanel(live2d)
      initMouseFollow(live2d)
      initClickInteraction(live2d)

      hitareaToggle.addEventListener('change', () => {
        live2d.showHitAreaOverlay(hitareaToggle.checked)
      })
    } catch (e) {
      modelStatus.textContent = '模型加载失败'
      showModelLoadError()
      console.error('[Main] Failed to initialize Live2D:', e)
      // 即使模型加载失败，legacy 路径仍尝试连接 WS（方便调试）
    }
  }

  if (isElectron) {
    // Electron 一体化默认路径：F4 起由主进程经 preload IPC 推送控制事件，
    // 本片不连接遗留 WS；WS 缺席绝不允许阻断模型渲染（SPEC §10.3 降级要求）。
    wsDot.classList.add('electron')
    wsStatus.textContent = 'Electron 模式（控制通道待 F4 接入）'
    return
  }

  // 以下为 legacy 浏览器路径：连接独立 mcp-server 的 WS bridge（dev:legacy）
  if (!app) {
    // 渲染核心缺失（Cubism Core 未加载）：命令处理无从附着，不再连接 WS
    wsStatus.textContent = '渲染核心未加载，未连接 WS'
    return
  }
  const live2dApp = app

  // 初始化 WebSocket 客户端
  const wsClient = new WsClient()

  // 绑定命令处理器（包装一层，同时更新 UI）
  const rawHandler = createCommandHandler(live2dApp)
  wsClient.setCommandHandler(async (command) => {
    const response = await rawHandler(command)

    // 更新状态栏
    if (response.success) {
      if (command.type === 'setExpression') {
        currentExpression = command.params.expression as string
      } else if (command.type === 'playMotion') {
        currentMotion = motionLabel(command.params.group as string, command.params.index as number | undefined)
      } else if (command.type === 'reset') {
        currentExpression = '-'
        currentMotion = '-'
      }
      updateStateBar()
    }

    return response
  })

  wsClient.onConnect(() => {
    wsDot.classList.add('connected')
    wsStatus.textContent = 'WebSocket 已连接'

    // 发送就绪通知，携带模型信息
    const modelInfo = live2dApp.getModelInfo()
    if (modelInfo) {
      wsClient.sendReady(modelInfo)
    }
  })

  wsClient.onDisconnect(() => {
    wsDot.classList.remove('connected')
    wsStatus.textContent = 'WebSocket 未连接（重连中...）'
  })

  wsClient.connect()
}

main().catch(console.error)
