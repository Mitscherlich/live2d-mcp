/**
 * 渲染器入口
 * 1. 初始化 Live2D 应用
 * 2. 挂接 voice 口型与 main→renderer 命令通道
 * 3. 更新状态栏 UI
 */

import type { Live2DApp } from './live2d-app.js'
import { createVoiceLipSync, type MouthParamTarget } from './lip-sync.js'
import { resolveMouthParamId, type VoiceActivity } from './voice-state.js'
import {
  clientPointToCanvas,
  clampWindowScale,
  isDragModeEnabled,
  isModifierPressed,
  isScaleModeEnabled,
  nextWindowScale,
  screenPointToLookDirection,
  shouldProcessMouseFollow,
  zoomDirectionForKey,
  zoomDirectionForWheel,
  type Point,
  type WindowBounds,
  type ZoomDirection,
} from './desktop-interactions.js'
import { initButtonGroup, type ButtonGroupController } from './button-group.js'

/**
 * 顶部状态栏 + 底部调试条是否显示：**读 public/ui-chrome-boot.js 的判定结果**
 * （boot 早于本模块执行、写在 documentElement 上以防首屏闪一下），此处不重复判定。
 * 关闭时（默认的陪伴模式）：状态栏/调试面板被 CSS 隐藏，相关 DOM 一律不构建、不写入。
 */
const UI_CHROME = document.documentElement.classList.contains('ui-chrome')

const canvas = document.getElementById('live2d-canvas') as HTMLCanvasElement
const canvasContainer = document.getElementById('canvas-container') as HTMLDivElement
const modelDot = document.getElementById('model-dot') as HTMLDivElement
const modelStatus = document.getElementById('model-status') as HTMLSpanElement
const voiceDot = document.getElementById('voice-dot') as HTMLDivElement
const voiceStatus = document.getElementById('voice-status') as HTMLSpanElement
const currentStateEl = document.getElementById('current-state') as HTMLDivElement

let currentExpression = '-'
let currentMotion = '-'

/** 鼠标跟随：陪伴模式的真实功能，默认开启；调试面板的 checkbox 只是它的一个开关 */
let mouseFollowEnabled = true

const PLATFORM = window.live2d?.platform ?? 'web'

/** 状态栏用的动作标识：直接用模型原始 group/index，换模型也不退化 */
function motionTag(group: string, index?: number): string {
  return `${group}[${index ?? 'rand'}]`
}

function updateStateBar() {
  if (!UI_CHROME) return
  currentStateEl.textContent = `表情: ${currentExpression} | 动作: ${currentMotion}`
}

// 点击区域 → 动作分组映射
const HIT_AREA_MOTIONS: Record<string, string> = {
  Body: 'Tap@Body',
}

function appendClickLog(px: number, py: number, hitAreas: string[], action: string | null) {
  if (!UI_CHROME) return
  const debugClickLog = document.getElementById('debug-click-log')
  if (!debugClickLog) return
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

/** 点击触发动作：陪伴模式真实功能，无条件挂接 */
function initClickInteraction(app: Live2DApp, buttonGroup: ButtonGroupController | null) {
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || isModifierPressed(e, PLATFORM)) return
    if (buttonGroup?.isDragging() || buttonGroup?.isLocked()) return
    const rect = canvas.getBoundingClientRect()
    // getBoundingClientRect 已反映 CSS transform；按实际 rect 映射可保持缩放后 hitTest 正确。
    const { x, y } = clientPointToCanvas(
      { x: e.clientX, y: e.clientY },
      rect,
      { width: canvas.width, height: canvas.height },
    )

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
    currentMotion = motionTag(group)
    updateStateBar()
    appendClickLog(x, y, hitAreas, group)
  })
}

/**
 * 鼠标跟随：陪伴模式真实功能，无条件挂接，不依赖任何调试 DOM。
 * main 以约 30fps 推送全局屏幕坐标；renderer 查询当前窗口边界后按窗口中心归一化。
 * 事件只记录目标 + 置脏，实际 lookAt 每帧最多一次。
 */
function initMouseFollow(app: Live2DApp, buttonGroup: ButtonGroupController | null) {
  let targetX = 0
  let targetY = 0
  let dirty = false
  let inButtonHotspot = buttonGroup?.isHotspotActive() ?? false
  let queuedPoint: Point | null = null
  let boundsRequestActive = false
  let boundsWarningShown = false
  const getWindowBounds = window.live2d?.getWindowBounds

  const resolveQueuedPoint = () => {
    if (boundsRequestActive || !queuedPoint || !getWindowBounds) return
    const requestedPoint = queuedPoint
    queuedPoint = null
    boundsRequestActive = true
    void getWindowBounds()
      .then((bounds: WindowBounds) => {
        if (!shouldProcessMouseFollow(mouseFollowEnabled, inButtonHotspot)) return
        const point = queuedPoint ?? requestedPoint
        queuedPoint = null
        const direction = screenPointToLookDirection(point, bounds)
        targetX = direction.x
        targetY = direction.y
        dirty = true
      })
      .catch((error: unknown) => {
        if (boundsWarningShown) return
        boundsWarningShown = true
        console.warn('[MouseFollow] 获取窗口边界失败，全局眼神跟随暂停:', error)
      })
      .finally(() => {
        boundsRequestActive = false
        if (queuedPoint) resolveQueuedPoint()
      })
  }

  const offHotspot = buttonGroup?.onHotspotChange((active) => {
    inButtonHotspot = active
    if (active) {
      queuedPoint = null
      dirty = false
    }
  })

  const off = window.live2d?.onGlobalMouseMove?.((x, y) => {
    if (!shouldProcessMouseFollow(mouseFollowEnabled, inButtonHotspot)) return
    queuedPoint = { x, y }
    resolveQueuedPoint()
  })
  if (!off || !getWindowBounds) {
    console.warn('[MouseFollow] preload 未暴露全局鼠标/窗口边界 API，眼神跟随不可用')
  }

  app.addTicker(() => {
    if (!shouldProcessMouseFollow(mouseFollowEnabled, inButtonHotspot) || !dirty) return
    dirty = false
    app.lookAt(targetX, targetY)
  })

  // 保持订阅引用存活；按钮组生命周期通常与页面一致，销毁时由其自身移除监听。
  void offHotspot
}

/** Command/Ctrl + 指针拖动窗口；Command/Ctrl + 滚轮或 +/- 缩放模型。 */
function initDesktopWindowControls(buttonGroup: ButtonGroupController | null) {
  const api = window.live2d
  if (!api) return

  let currentScale = 1
  const applyScale = (rawScale: number) => {
    currentScale = clampWindowScale(rawScale)
    canvasContainer.style.transform = `scale(${currentScale})`
  }
  api.onSetScale?.(applyScale)
  void api.getWindowScale?.().then(applyScale).catch((error: unknown) => {
    console.warn('[WindowControls] 读取初始缩放失败:', error)
  })

  const requestScale = (direction: ZoomDirection) => {
    if (direction === 0 || !api.setWindowScale) return
    const nextScale = nextWindowScale(currentScale, direction)
    if (nextScale === currentScale) return
    applyScale(nextScale)
    void api.setWindowScale(nextScale).then(applyScale).catch((error: unknown) => {
      console.warn('[WindowControls] 设置缩放失败:', error)
    })
  }

  let dragPointerId: number | null = null
  let lastScreenPoint: Point | null = null

  const stopDragging = () => {
    dragPointerId = null
    lastScreenPoint = null
  }

  window.addEventListener('pointerdown', (event: PointerEvent) => {
    if (
      event.button !== 0 ||
      !isDragModeEnabled(event, PLATFORM, buttonGroup?.isDragging() ?? false) ||
      !api.moveWindow ||
      buttonGroup?.containsTarget(event.target)
    ) return
    event.preventDefault()
    dragPointerId = event.pointerId
    lastScreenPoint = { x: event.screenX, y: event.screenY }
    const target = event.target
    if (target instanceof Element && 'setPointerCapture' in target) {
      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        // 某些透明区域不支持 capture；window 级监听仍可继续拖动。
      }
    }
  })

  window.addEventListener('pointermove', (event: PointerEvent) => {
    if (event.pointerId !== dragPointerId || !lastScreenPoint) return
    if (
      (event.buttons & 1) === 0 ||
      !isDragModeEnabled(event, PLATFORM, buttonGroup?.isDragging() ?? false)
    ) {
      stopDragging()
      return
    }
    event.preventDefault()
    const deltaX = event.screenX - lastScreenPoint.x
    const deltaY = event.screenY - lastScreenPoint.y
    lastScreenPoint = { x: event.screenX, y: event.screenY }
    if (deltaX === 0 && deltaY === 0) return
    void api.moveWindow!(deltaX, deltaY).catch((error: unknown) => {
      console.warn('[WindowControls] 移动窗口失败:', error)
      stopDragging()
    })
  })
  window.addEventListener('pointerup', stopDragging)
  window.addEventListener('pointercancel', stopDragging)

  window.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      if (!isScaleModeEnabled(event, PLATFORM, buttonGroup?.isScaling() ?? false)) return
      const direction = zoomDirectionForWheel(event.deltaY)
      if (direction === 0) return
      event.preventDefault()
      requestScale(direction)
    },
    { passive: false },
  )

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!isScaleModeEnabled(event, PLATFORM, buttonGroup?.isScaling() ?? false)) return
    const direction = zoomDirectionForKey(event.key)
    if (direction === 0) return
    event.preventDefault()
    requestScale(direction)
  })
}

/**
 * 底部调试抽屉：**仅 ui-chrome 开启时构建**。
 * 陪伴模式下这些 DOM 被 CSS 隐藏，按钮/监听全部白做，故整段不执行。
 */
function initDebugPanel(app: Live2DApp) {
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
  const hitareaToggle = document.getElementById('hitarea-toggle') as HTMLInputElement
  const mouseFollowCheckbox = document.getElementById('mouse-follow') as HTMLInputElement

  /**
   * 动作译名：HiyoriPro 专属，只用于调试面板的按钮文案。
   * 命令通道 / voice 体态等主路径一律用 motionTag() 的原始 group/index。
   */
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
  const motionLabel = (group: string, index: number): string =>
    MOTION_NAMES[`${group}:${index}`] ?? motionTag(group, index)

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

  // 视线控制：鼠标跟随开启时滑块禁用
  function setSliderDisabled(disabled: boolean) {
    lookXInput.disabled = disabled
    lookYInput.disabled = disabled
  }
  function applyLookAt() {
    const x = parseFloat(lookXInput.value)
    const y = parseFloat(lookYInput.value)
    lookXVal.textContent = x.toFixed(2)
    lookYVal.textContent = y.toFixed(2)
    app.lookAt(x, y)
  }
  lookXInput.addEventListener('input', applyLookAt)
  lookYInput.addEventListener('input', applyLookAt)

  mouseFollowCheckbox.checked = mouseFollowEnabled
  setSliderDisabled(mouseFollowEnabled)
  mouseFollowCheckbox.addEventListener('change', () => {
    mouseFollowEnabled = mouseFollowCheckbox.checked
    setSliderDisabled(mouseFollowEnabled)
    // 关闭时重置视线到滑块当前值
    if (!mouseFollowEnabled) app.lookAt(parseFloat(lookXInput.value), parseFloat(lookYInput.value))
  })

  // HitArea 边框 overlay（每帧重绘，仅调试用）
  hitareaToggle.addEventListener('change', () => {
    app.showHitAreaOverlay(hitareaToggle.checked)
  })

  // 重置
  debugResetBtn.addEventListener('click', () => {
    app.reset()
    lookXInput.value = '0'
    lookYInput.value = '0'
    lookXVal.textContent = '0.00'
    lookYVal.textContent = '0.00'
    if (!mouseFollowEnabled) app.lookAt(0, 0)
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

/**
 * ADR 0001 · F3：voice 状态机 + 口型驱动（Electron 一体化路径）。
 *
 * - 事件源：preload `window.live2d.onVoiceEvent`（main 推送的规范化 state/audio-level；
 *   F4 bridge /events 与本片测试注入 injectVoice 共用该通道）。
 * - 嘴参：模型参数表解析 ParamMouthOpenY 或等效别名；模型缺失/无该参时写入 no-op
 *   （状态机与平滑照常推进，调试快照可见 smoothed 值变化）。
 * - 帧驱动：有模型走 PIXI ticker（LOW 优先级，motion 之后写嘴参）；
 *   无模型走 rAF（注入链路在无模型环境仍可证明嘴参目标值变化）。
 */
function initVoiceLipSync(app: Live2DApp | null) {
  let mouthParam: MouthParamTarget | null = null
  const info = app?.getModelInfo() ?? null
  if (info) {
    const mouthId = resolveMouthParamId(info.parameters.map((p) => p.id))
    if (mouthId) {
      const p = info.parameters.find((param) => param.id === mouthId)!
      mouthParam = { id: p.id, min: p.min, max: p.max }
    } else {
      console.warn('[Voice] 模型参数表无 ParamMouthOpenY 或等效嘴参，口型写入 no-op（仅一次）')
    }
  }

  const lip = createVoiceLipSync({
    mouthParam,
    writeMouth: (paramId, value) => {
      if (paramId && app) app.setParameter(paramId, value)
      // 无嘴参/无模型：no-op（快照仍记录 lastMouthWrite，证明目标值被驱动）
    },
  })

  /**
   * 助手（Codex）出声时的肢体表现：对齐 persona 的 Listening/Speaking 槽位思想。
   * Hiyori 无独立 Speaking 组时用 Idle 循环；speaking 时用略高优先级保证口型期间有体态。
   * 注意：这是 **agent 播放音频** 的视觉反应，不是用户麦克风说话。
   */
  function applyVoiceBodyMotion(activity: VoiceActivity) {
    if (!app?.isLoaded()) return
    if (activity === 'speaking') {
      // priority 2：体态；口型仍由 LOW ticker 在 motion 之后写 ParamMouthOpenY
      app.playMotion('Idle', -1, 2)
      currentMotion = motionTag('Idle')
      updateStateBar()
      return
    }
    if (activity === 'listening' || activity === 'idle') {
      app.playMotion('Idle', -1, 1)
      currentMotion = motionTag('Idle')
      updateStateBar()
    }
  }

  let shownActivity: VoiceActivity | '' = ''
  let lastShownLevel = -1
  /**
   * 每帧 + 每条事件调用。activity 变化可能由 tick 触发（900ms 静音保持到期回落），
   * 不只由事件触发，所以体态检测必须留在每帧；DOM 写入则只在 ui-chrome 下做。
   * 用标量访问器比较，避免每帧构造快照对象。
   */
  function syncVoice(force = false) {
    const activity = lip.getActivity()
    const activityChanged = activity !== shownActivity
    if (activityChanged) {
      shownActivity = activity
      applyVoiceBodyMotion(activity)
      console.log(`[Voice] activity → ${activity} (level=${lip.getLevel().toFixed(3)})`)
    }
    if (!UI_CHROME) return
    if (activityChanged) {
      voiceDot.classList.toggle('listening', activity === 'listening')
      voiceDot.classList.toggle('speaking', activity === 'speaking')
    }
    // 状态栏展示电平，便于确认「Codex 出声」是否被采到（非用户麦克风）
    const level = lip.getLevel()
    const levelBucket = Math.round(level * 20) / 20
    if (force || activityChanged || levelBucket !== lastShownLevel) {
      lastShownLevel = levelBucket
      const levelStr = level > 0.005 ? ` · L${level.toFixed(2)}` : ''
      voiceStatus.textContent = `助手语音 ${activity}${levelStr}`
    }
  }
  syncVoice(true)

  const offVoice = window.live2d?.onVoiceEvent?.((event) => {
    lip.handleEvent(event)
    // 立即刷 UI（不等下一帧），便于 live-voice 出声瞬间看到 speaking
    syncVoice()
  })
  if (!offVoice) console.warn('[Voice] preload 未暴露 onVoiceEvent，voice 通道不可用')

  if (app) {
    app.addTicker((dt) => {
      lip.tick(dt)
      syncVoice()
    })
  } else {
    let prev = performance.now()
    const frame = (t: number) => {
      const dt = t - prev
      prev = t
      lip.tick(dt)
      syncVoice()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  // 调试快照：scripts/f3-lipsync-proof.mjs 经 CDP 读取，证明注入改变了嘴参目标
  window.__live2dVoiceDebug = {
    snapshot: () => ({
      ...lip.snapshot(),
      modelLoaded: app?.isLoaded() ?? false,
      injectEnabled: typeof window.live2d?.injectVoice === 'function',
    }),
  }
  console.log(`[Voice] 口型驱动已挂接（嘴参: ${mouthParam?.id ?? '未解析（no-op）'}，注入: ${
    typeof window.live2d?.injectVoice === 'function' ? '开' : '关'
  }）`)
}

/**
 * ADR 0001 · F5：main → renderer 命令通道（MCP 视觉工具执行路径）。
 *
 * main（Electron 一体化 MCP 工具回调）经 preload `window.live2d.onCommand` 下发
 * 白名单命令（getModelInfo / setExpression / playMotion / lookAt / setParameter /
 * reset），此处映射到 Live2DApp；无模型时返回 ok:false 清晰降级（不崩溃），
 * MCP 工具层转为 isError。调试快照 __live2dCommandDebug 供 scripts/f5-mcp-proof.mjs
 * 经 CDP 断言命令真实到达 renderer。
 */
function initCommandChannel(app: Live2DApp | null) {
  const counts: Record<string, number> = {}
  let lastCommand: string | null = null
  let lastError: string | null = null
  const MODEL_MISSING =
    'Live2D 模型未加载（Cubism Core 或模型资源缺失，见窗口内引导）；命令未执行'

  const off = window.live2d?.onCommand?.(({ type, params }) => {
    counts[type] = (counts[type] ?? 0) + 1
    lastCommand = type
    const loaded = Boolean(app && app.isLoaded())

    if (type === 'getModelInfo') {
      if (!loaded) {
        lastError = MODEL_MISSING
        return { ok: false, error: MODEL_MISSING }
      }
      return { ok: true, data: app!.getModelInfo() }
    }

    if (!loaded) {
      lastError = MODEL_MISSING
      return { ok: false, error: MODEL_MISSING }
    }
    const live2d = app!

    switch (type) {
      case 'setExpression': {
        const expression = typeof params.expression === 'string' ? params.expression : ''
        const ok = expression !== '' && live2d.setExpression(expression)
        if (ok) {
          currentExpression = expression
          updateStateBar()
          return { ok: true, data: { expression } }
        }
        lastError = `表情 "${expression}" 不存在或不可用`
        return { ok: false, error: `${lastError}（用 get_model_info 查询可用表情）` }
      }
      case 'playMotion': {
        const group = typeof params.group === 'string' ? params.group : ''
        const index = typeof params.index === 'number' ? Math.trunc(params.index) : -1
        const priority = typeof params.priority === 'number' ? Math.trunc(params.priority) : 2
        const ok = group !== '' && live2d.playMotion(group, index, priority)
        if (ok) {
          currentMotion = motionTag(group, index >= 0 ? index : undefined)
          updateStateBar()
          return { ok: true, data: { group, index, priority } }
        }
        lastError = `动作分组 "${group}" 不存在或不可用`
        return { ok: false, error: `${lastError}（用 get_model_info 查询可用分组）` }
      }
      case 'lookAt': {
        const x = typeof params.x === 'number' ? params.x : 0
        const y = typeof params.y === 'number' ? params.y : 0
        const ok = live2d.lookAt(x, y)
        return ok ? { ok: true, data: { x, y } } : { ok: false, error: 'lookAt 执行失败' }
      }
      case 'setParameter': {
        const paramId = typeof params.param_id === 'string' ? params.param_id : ''
        const value = typeof params.value === 'number' ? params.value : Number.NaN
        const ok = paramId !== '' && Number.isFinite(value) && live2d.setParameter(paramId, value)
        return ok
          ? { ok: true, data: { param_id: paramId, value } }
          : { ok: false, error: `参数 "${paramId}" 写入失败` }
      }
      case 'reset': {
        const ok = live2d.reset()
        if (ok) {
          currentExpression = '-'
          currentMotion = '-'
          updateStateBar()
        }
        return ok ? { ok: true } : { ok: false, error: 'reset 执行失败' }
      }
      default:
        return { ok: false, error: `未知命令: ${type}` }
    }
  })

  window.__live2dCommandDebug = {
    snapshot: () => ({
      counts: { ...counts },
      lastCommand,
      lastError,
      modelLoaded: app?.isLoaded() ?? false,
      channelAttached: Boolean(off),
    }),
  }
  if (off) {
    console.log('[Command] main→renderer 命令通道已挂接（MCP 视觉工具可执行）')
  } else {
    console.warn('[Command] preload 未暴露 onCommand，命令通道不可用')
  }
}

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
  console.log(
    `[Main] Running inside Electron ${window.live2d?.versions.electron ?? ''} (${window.live2d?.platform ?? 'unknown'})`,
  )
  const buttonGroup = initButtonGroup()
  initDesktopWindowControls(buttonGroup)

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
      // 鼠标跟随 / 点击触发动作是陪伴模式的真实功能；调试面板只在 ui-chrome 下构建
      initMouseFollow(live2d, buttonGroup)
      initClickInteraction(live2d, buttonGroup)
      if (UI_CHROME) initDebugPanel(live2d)
    } catch (e) {
      modelStatus.textContent = '模型加载失败'
      showModelLoadError()
      console.error('[Main] Failed to initialize Live2D:', e)
    }
  }

  // voice 事件由 main 经 preload IPC 推送（F3/F4），表情/动作等视觉命令自 F5 起
  // 经 main↔renderer 命令通道执行。模型缺失绝不允许阻断这两条通道的挂接
  // （SPEC §10.3 降级要求）。
  initVoiceLipSync(app)
  initCommandChannel(app)
}

main().catch(console.error)
