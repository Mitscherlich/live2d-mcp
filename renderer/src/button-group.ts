export const BUTTON_HOTSPOT_HEIGHT = 48
// 按钮组实际占高 42px（top 8 + padding 4 + 按钮 26 + padding 4），锁定热区多留 2px 余量，
// 否则解锁按钮底部 2px 会成为"点了没反应"的死区（悬浮判定已由全局鼠标流接管）。
export const LOCK_HOTSPOT_HEIGHT = 44
export const BUTTON_GROUP_HIDE_DELAY = 800
export const MOUSE_IGNORE_DEBOUNCE_MS = 100

export interface ButtonGroupSnapshot {
  visible: boolean
  dragging: boolean
  scaling: boolean
  locked: boolean
  inHotspot: boolean
  lockHotspotActive: boolean
}

export interface ButtonGroupController {
  show(): void
  hide(): void
  isVisible(): boolean
  setLocked(locked: boolean): void
  isLocked(): boolean
  setDragging(dragging: boolean): void
  isDragging(): boolean
  setScaling(scaling: boolean): void
  isScaling(): boolean
  setHotspotActive(active: boolean): void
  isHotspotActive(): boolean
  setLockHotspotActive(active: boolean): void
  isLockHotspotActive(): boolean
  onHotspotChange(callback: (active: boolean) => void): () => void
  containsTarget(target: EventTarget | null): boolean
  destroy(): void
}

interface ButtonGroupStateOptions {
  hideDelayMs?: number
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
  mouseIgnoreDebounceMs?: number
  onStateChange?: (snapshot: ButtonGroupSnapshot) => void
  onMouseIgnoreChange?: (ignore: boolean) => void
}

function snapshotOf(state: ButtonGroupSnapshot): ButtonGroupSnapshot {
  return { ...state }
}

/**
 * 纯状态控制器：DOM 适配器与测试都复用这套互斥/延迟隐藏语义。
 * 不依赖 Electron，故按钮逻辑可以在 node:test 中完整覆盖。
 */
export function createButtonGroupState(
  options: ButtonGroupStateOptions = {},
): ButtonGroupController {
  const hideDelayMs = options.hideDelayMs ?? BUTTON_GROUP_HIDE_DELAY
  const mouseIgnoreDebounceMs = options.mouseIgnoreDebounceMs ?? MOUSE_IGNORE_DEBOUNCE_MS
  const schedule = options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
  const cancel = options.cancel ?? ((handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  })

  const state: ButtonGroupSnapshot = {
    visible: false,
    dragging: false,
    scaling: false,
    locked: false,
    inHotspot: false,
    lockHotspotActive: false,
  }
  const hotspotListeners = new Set<(active: boolean) => void>()
  let hideTimer: unknown = null
  let mouseIgnoreTimer: unknown = null
  let mouseIgnored = false
  // 锁定瞬间鼠标通常仍停在热区（刚点完锁定按钮）：抑制悬浮唤出，
  // 直到全局鼠标流上报一次"离开热区"，避免点锁定后工具条立刻弹回。
  let lockHoverSuppressed = false

  const clearHideTimer = () => {
    if (hideTimer === null) return
    cancel(hideTimer)
    hideTimer = null
  }

  const clearMouseIgnoreTimer = () => {
    if (mouseIgnoreTimer === null) return
    cancel(mouseIgnoreTimer)
    mouseIgnoreTimer = null
  }

  const applyMouseIgnore = (ignore: boolean) => {
    clearMouseIgnoreTimer()
    if (mouseIgnored === ignore) return
    mouseIgnored = ignore
    options.onMouseIgnoreChange?.(ignore)
  }

  const scheduleMouseIgnore = (ignore: boolean) => {
    clearMouseIgnoreTimer()
    if (mouseIgnored === ignore) return
    if (mouseIgnoreDebounceMs <= 0) {
      applyMouseIgnore(ignore)
      return
    }
    mouseIgnoreTimer = schedule(() => {
      mouseIgnoreTimer = null
      applyMouseIgnore(ignore)
    }, mouseIgnoreDebounceMs)
  }

  // 锁定状态不算"激活"，因为锁定时需要隐藏 toolbar（只有 hover 热区才显示）
  const isActive = () => state.dragging || state.scaling

  const notify = () => {
    options.onStateChange?.(snapshotOf(state))
  }

  const show = () => {
    clearHideTimer()
    if (state.visible) return
    state.visible = true
    notify()
  }

  const hide = () => {
    clearHideTimer()
    // 锁定时允许隐藏（只有 hover 热区时才显示）
    if (state.locked) {
      if (state.lockHotspotActive) return // hover 热区时不隐藏
      if (!state.visible) return
      state.visible = false
      notify()
      return
    }
    // 非锁定时，激活状态或热区内不隐藏
    if (isActive() || state.inHotspot) return
    if (!state.visible) return
    state.visible = false
    notify()
  }

  const scheduleHide = () => {
    clearHideTimer()
    // 锁定时，只有不在热区才调度隐藏
    if (state.locked) {
      if (state.lockHotspotActive || !state.visible) return
      hideTimer = schedule(() => {
        hideTimer = null
        hide()
      }, hideDelayMs)
      return
    }
    // 非锁定时，激活状态或热区内不调度隐藏
    if (isActive() || state.inHotspot || !state.visible) return
    hideTimer = schedule(() => {
      hideTimer = null
      hide()
    }, hideDelayMs)
  }

  const setHotspotActive = (active: boolean) => {
    // 锁定态按钮热区无意义：可见性由锁定热区（全局鼠标流驱动）独占。
    // 穿透态残留的窗口 mousemove 不得唤出工具条，也不得滞留 inHotspot=true
    // （光标快速离开窗口时 mouseleave 静默丢失，滞留会永久暂停眼神跟随）。
    if (state.locked) return
    if (state.inHotspot === active) {
      if (active) show()
      return
    }
    state.inHotspot = active
    for (const listener of hotspotListeners) listener(active)
    if (active) show()
    else scheduleHide()
    notify()
  }

  const setLocked = (locked: boolean) => {
    if (state.locked === locked) {
      if (locked && state.lockHotspotActive) show()
      return
    }
    state.locked = locked
    state.lockHotspotActive = false
    lockHoverSuppressed = locked
    if (locked) {
      state.dragging = false
      state.scaling = false
      // 穿透后窗口鼠标事件不可靠，按钮热区状态可能滞留为 true，
      // 导致眼神跟随被永久暂停；锁定时强制退出并广播一次。
      if (state.inHotspot) {
        state.inHotspot = false
        for (const listener of hotspotListeners) listener(false)
      }
    }
    // 锁定/解锁都走 800ms 延迟隐藏：给状态切换一个视觉确认再淡出；
    // lockHotspotActive 由全局鼠标流保证真实，定时器一定生效。
    scheduleHide()
    // 锁定/解锁是明确的用户动作，立即切换；只有热区 hover 才走防抖路径。
    applyMouseIgnore(locked)
    notify()
  }

  const setLockHotspotActive = (active: boolean) => {
    // 抑制期（锁定瞬间鼠标已在热区）：忽略"进入"信号，直到一次"离开"解除。
    if (state.locked && lockHoverSuppressed) {
      if (active) return
      lockHoverSuppressed = false
    }
    if (state.lockHotspotActive === active) return
    state.lockHotspotActive = active
    if (state.locked) {
      if (active) {
        scheduleMouseIgnore(false)
        show()
      } else {
        // 离开锁定热区后必须调度延迟隐藏，否则锁定态下悬浮一次工具条就常驻。
        // 先排隐藏（800ms）再排穿透防抖（100ms），穿透先生效，淡出期间窗口即恢复穿透。
        scheduleHide()
        scheduleMouseIgnore(true)
      }
    }
    notify()
  }

  const setDragging = (dragging: boolean) => {
    if (dragging && state.locked) return
    if (state.dragging === dragging && (!dragging || !state.scaling)) {
      if (dragging) show()
      return
    }
    state.dragging = dragging
    if (dragging) {
      state.scaling = false
      show()
    } else {
      scheduleHide()
    }
    notify()
  }

  const setScaling = (scaling: boolean) => {
    if (scaling && state.locked) return
    if (state.scaling === scaling && (!scaling || !state.dragging)) {
      if (scaling) show()
      return
    }
    state.scaling = scaling
    if (scaling) {
      state.dragging = false
      show()
    } else {
      scheduleHide()
    }
    notify()
  }

  return {
    show,
    hide,
    isVisible: () => state.visible,
    setLocked,
    isLocked: () => state.locked,
    setDragging,
    isDragging: () => state.dragging,
    setScaling,
    isScaling: () => state.scaling,
    setHotspotActive,
    isHotspotActive: () => state.inHotspot,
    setLockHotspotActive,
    isLockHotspotActive: () => state.lockHotspotActive,
    onHotspotChange(callback) {
      hotspotListeners.add(callback)
      return () => hotspotListeners.delete(callback)
    },
    containsTarget: () => false,
    destroy() {
      clearHideTimer()
      clearMouseIgnoreTimer()
      hotspotListeners.clear()
    },
  }
}

interface ButtonGroupInitOptions {
  document?: Document
  window?: Window
  hideDelayMs?: number
  mouseIgnoreDebounceMs?: number
}

function isTopHotspot(event: { clientY: number }, height: number): boolean {
  return Number.isFinite(event.clientY) && event.clientY >= 0 && event.clientY <= height
}

export function isUnlockShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'key'>,
  platform: string,
): boolean {
  const modifier = platform === 'darwin' ? event.metaKey : event.ctrlKey
  return modifier && event.shiftKey && event.key.toLowerCase() === 'l'
}

/** 初始化 DOM、hover 热区、四个按钮与 Electron 窄 API。 */
export function initButtonGroup(options: ButtonGroupInitOptions = {}): ButtonGroupController | null {
  const documentRef = options.document ?? (typeof document === 'undefined' ? null : document)
  const windowRef = options.window ?? (typeof window === 'undefined' ? null : window)
  if (!documentRef || !windowRef) return null

  const group = documentRef.getElementById('button-group')
  if (!group) {
    console.warn('[ButtonGroup] 未找到 #button-group，按钮组不可用')
    return null
  }

  const dragButton = group.querySelector<HTMLButtonElement>('[data-action="drag"]')
  const scaleButton = group.querySelector<HTMLButtonElement>('[data-action="scale"]')
  const lockButton = group.querySelector<HTMLButtonElement>('[data-action="lock"]')
  const settingsButton = group.querySelector<HTMLButtonElement>('[data-action="settings"]')
  if (!dragButton || !scaleButton || !lockButton || !settingsButton) {
    console.warn('[ButtonGroup] 按钮组缺少必要按钮，按钮组不可用')
    return null
  }
  const lockStatus = group.querySelector<HTMLElement>('[data-lock-status]')
  const lockHotspot = documentRef.getElementById('lock-hotspot')
  const api = windowRef.live2d

  const invokeMouseIgnore = (ignore: boolean) => {
    if (!api?.setMouseIgnore) {
      console.warn('[ButtonGroup] preload 未暴露 setMouseIgnore')
      return
    }
    void Promise.resolve(api.setMouseIgnore(ignore)).catch((error: unknown) => {
      console.warn('[ButtonGroup] 设置窗口穿透失败:', error)
    })
  }

  const controller = createButtonGroupState({
    hideDelayMs: options.hideDelayMs,
    mouseIgnoreDebounceMs: options.mouseIgnoreDebounceMs,
    onMouseIgnoreChange: invokeMouseIgnore,
    onStateChange(snapshot) {
      group.classList.toggle('visible', snapshot.visible)
      group.classList.toggle('locked', snapshot.locked)
      lockHotspot?.classList.toggle('locked', snapshot.locked)
      group.setAttribute('aria-hidden', String(!snapshot.visible))
      dragButton.classList.toggle('active', snapshot.dragging)
      scaleButton.classList.toggle('active', snapshot.scaling)
      lockButton.classList.toggle('active', snapshot.locked)
      dragButton.setAttribute('aria-pressed', String(snapshot.dragging))
      scaleButton.setAttribute('aria-pressed', String(snapshot.scaling))
      lockButton.setAttribute('aria-pressed', String(snapshot.locked))
      if (lockStatus) lockStatus.hidden = !snapshot.locked
    },
  })

  // 两种模式的热区判定统一由全局鼠标流驱动：窗口鼠标事件在穿透态、以及
  // macOS 非焦点窗口快速移出时都会静默丢失，曾导致锁定/解锁态工具条双双常驻。
  // main 每帧顺带推送窗口 bounds，屏幕坐标直接换算，无需额外 IPC。
  // setHotspotActive 在锁定态被控制器忽略；setLockHotspotActive 仅在锁定态生效。
  const offGlobalMouse =
    api?.onGlobalMouseMove?.((x, y, bounds) => {
      if (!bounds) return
      const overWindowX = x >= bounds.x && x < bounds.x + bounds.width
      const relY = y - bounds.y
      controller.setHotspotActive(overWindowX && relY >= 0 && relY <= BUTTON_HOTSPOT_HEIGHT)
      controller.setLockHotspotActive(overWindowX && relY >= 0 && relY <= LOCK_HOTSPOT_HEIGHT)
    }) ?? null

  const onPointerMove = (event: MouseEvent) => {
    controller.setHotspotActive(isTopHotspot(event, BUTTON_HOTSPOT_HEIGHT))
  }
  const onPointerLeave = () => {
    controller.setHotspotActive(false)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isUnlockShortcut(event, api?.platform ?? 'web') || !controller.isLocked()) return
    event.preventDefault()
    controller.setLocked(false)
  }

  if (!offGlobalMouse) {
    // 无全局流（web 预览/旧 preload）：退回窗口事件驱动按钮热区；
    // 锁定悬浮恢复在此降级路径下不可用，仍可用快捷键解锁。
    console.warn('[ButtonGroup] preload 未暴露 onGlobalMouseMove，热区退回窗口事件驱动')
    windowRef.addEventListener('pointermove', onPointerMove)
    windowRef.addEventListener('pointerleave', onPointerLeave)
    windowRef.addEventListener('mouseleave', onPointerLeave)
  }
  windowRef.addEventListener('keydown', onKeyDown)

  dragButton.addEventListener('click', () => controller.setDragging(!controller.isDragging()))
  scaleButton.addEventListener('click', () => controller.setScaling(!controller.isScaling()))
  lockButton.addEventListener('click', () => controller.setLocked(!controller.isLocked()))
  settingsButton.addEventListener('click', () => {
    if (!api?.openSettings) {
      console.warn('[ButtonGroup] preload 未暴露 openSettings')
      return
    }
    void Promise.resolve(api.openSettings()).catch((error: unknown) => {
      console.warn('[ButtonGroup] 打开设置窗失败:', error)
    })
  })

  const originalDestroy = controller.destroy
  controller.destroy = () => {
    offGlobalMouse?.()
    windowRef.removeEventListener('pointermove', onPointerMove)
    windowRef.removeEventListener('pointerleave', onPointerLeave)
    windowRef.removeEventListener('mouseleave', onPointerLeave)
    windowRef.removeEventListener('keydown', onKeyDown)
    originalDestroy()
  }
  controller.containsTarget = (target) =>
    target !== null && typeof group.contains === 'function' && group.contains(target as Node)

  // 初始隐藏状态也要同步到 DOM。
  group.classList.remove('visible', 'locked')
  group.setAttribute('aria-hidden', 'true')
  lockHotspot?.classList.remove('locked')
  lockStatus?.setAttribute('hidden', '')
  return controller
}
