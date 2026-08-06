export const BUTTON_HOTSPOT_HEIGHT = 48
export const BUTTON_GROUP_HIDE_DELAY = 800

export interface ButtonGroupSnapshot {
  visible: boolean
  dragging: boolean
  scaling: boolean
  locked: boolean
  inHotspot: boolean
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
  onHotspotChange(callback: (active: boolean) => void): () => void
  containsTarget(target: EventTarget | null): boolean
  destroy(): void
}

interface ButtonGroupStateOptions {
  hideDelayMs?: number
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
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
  }
  const hotspotListeners = new Set<(active: boolean) => void>()
  let hideTimer: unknown = null

  const clearHideTimer = () => {
    if (hideTimer === null) return
    cancel(hideTimer)
    hideTimer = null
  }

  const isActive = () => state.dragging || state.scaling || state.locked

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
    if (isActive() || state.inHotspot) return
    if (!state.visible) return
    state.visible = false
    notify()
  }

  const scheduleHide = () => {
    clearHideTimer()
    if (isActive() || state.inHotspot || !state.visible) return
    hideTimer = schedule(() => {
      hideTimer = null
      hide()
    }, hideDelayMs)
  }

  const setHotspotActive = (active: boolean) => {
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
      if (locked) show()
      return
    }
    state.locked = locked
    if (locked) {
      state.dragging = false
      state.scaling = false
      show()
    } else {
      scheduleHide()
    }
    options.onMouseIgnoreChange?.(locked)
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
    onHotspotChange(callback) {
      hotspotListeners.add(callback)
      return () => hotspotListeners.delete(callback)
    },
    containsTarget: () => false,
    destroy() {
      clearHideTimer()
      hotspotListeners.clear()
    },
  }
}

interface ButtonGroupInitOptions {
  document?: Document
  window?: Window
  hideDelayMs?: number
}

function isTopHotspot(event: { clientY: number }, height: number): boolean {
  return Number.isFinite(event.clientY) && event.clientY >= 0 && event.clientY <= height
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
    onMouseIgnoreChange: invokeMouseIgnore,
    onStateChange(snapshot) {
      group.classList.toggle('visible', snapshot.visible)
      group.classList.toggle('locked', snapshot.locked)
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

  const onPointerMove = (event: PointerEvent) => {
    controller.setHotspotActive(isTopHotspot(event, BUTTON_HOTSPOT_HEIGHT))
  }
  const onPointerLeave = () => controller.setHotspotActive(false)
  const onKeyDown = (event: KeyboardEvent) => {
    const modifier = api?.platform === 'darwin' ? event.metaKey : event.ctrlKey
    if (!modifier || !event.shiftKey || event.key.toLowerCase() !== 'l') return
    if (!controller.isLocked()) return
    event.preventDefault()
    controller.setLocked(false)
  }

  windowRef.addEventListener('pointermove', onPointerMove)
  windowRef.addEventListener('pointerleave', onPointerLeave)
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
    windowRef.removeEventListener('pointermove', onPointerMove)
    windowRef.removeEventListener('pointerleave', onPointerLeave)
    windowRef.removeEventListener('keydown', onKeyDown)
    originalDestroy()
  }
  controller.containsTarget = (target) =>
    target !== null && typeof group.contains === 'function' && group.contains(target as Node)

  // 初始隐藏状态也要同步到 DOM。
  group.classList.remove('visible', 'locked')
  group.setAttribute('aria-hidden', 'true')
  lockStatus?.setAttribute('hidden', '')
  return controller
}
