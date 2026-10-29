import {
  clampWindowScale,
  isDragModeEnabled,
  isScaleModeEnabled,
  nextWindowScale,
  zoomDirectionForKey,
  zoomDirectionForWheel,
  type Point,
  type ZoomDirection,
} from './desktop-interactions.js'
import type { Live2dApi } from './live2d-bridge.js'
import type { ButtonGroupController } from './button-group.js'

/**
 * 桌面窗口手势：Command/Ctrl + 指针拖动窗口；Command/Ctrl + 滚轮或 +/- 缩放模型。
 *
 * 缩放写回走单一通道：本地 applyScale 立即生效，setWindowScale 的权威值由
 * main 经 SET_SCALE_EVENT 推回（onSetScale 已挂 applyScale），不再 .then 双应用。
 * 初始值保留「推（onSetScale 注册即可能收到）+ 拉（getWindowScale）」双通道幂等防御。
 */
export class WindowControls {
  private currentScale = 1
  private dragPointerId: number | null = null
  private lastScreenPoint: Point | null = null
  private readonly platform: string
  private readonly offSetScale: () => void

  constructor(
    private readonly canvasContainer: HTMLDivElement,
    private readonly api: Live2dApi,
    private readonly buttonGroup: ButtonGroupController | null,
  ) {
    this.platform = api.platform

    this.offSetScale = api.onSetScale((scale) => this.applyScale(scale))
    void api.getWindowScale().then((scale) => this.applyScale(scale)).catch((error: unknown) => {
      console.warn('[WindowControls] 读取初始缩放失败:', error)
    })

    window.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    window.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('keydown', this.onKeyDown)
  }

  dispose(): void {
    this.offSetScale()
    window.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('keydown', this.onKeyDown)
  }

  private applyScale(rawScale: number): void {
    this.currentScale = clampWindowScale(rawScale)
    this.canvasContainer.style.transform = `scale(${this.currentScale})`
  }

  private requestScale(direction: ZoomDirection): void {
    if (direction === 0) return
    const nextScale = nextWindowScale(this.currentScale, direction)
    if (nextScale === this.currentScale) return
    this.applyScale(nextScale)
    void this.api.setWindowScale(nextScale).catch((error: unknown) => {
      console.warn('[WindowControls] 设置缩放失败:', error)
    })
  }

  private stopDragging(): void {
    this.dragPointerId = null
    this.lastScreenPoint = null
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (
      event.button !== 0 ||
      !isDragModeEnabled(event, this.platform, this.buttonGroup?.isDragging() ?? false) ||
      this.buttonGroup?.containsTarget(event.target)
    ) return
    event.preventDefault()
    this.dragPointerId = event.pointerId
    this.lastScreenPoint = { x: event.screenX, y: event.screenY }
    const target = event.target
    if (target instanceof Element && 'setPointerCapture' in target) {
      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        // 某些透明区域不支持 capture；window 级监听仍可继续拖动。
      }
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointerId || !this.lastScreenPoint) return
    if (
      (event.buttons & 1) === 0 ||
      !isDragModeEnabled(event, this.platform, this.buttonGroup?.isDragging() ?? false)
    ) {
      this.stopDragging()
      return
    }
    event.preventDefault()
    const deltaX = event.screenX - this.lastScreenPoint.x
    const deltaY = event.screenY - this.lastScreenPoint.y
    this.lastScreenPoint = { x: event.screenX, y: event.screenY }
    if (deltaX === 0 && deltaY === 0) return
    void this.api.moveWindow(deltaX, deltaY).catch((error: unknown) => {
      console.warn('[WindowControls] 移动窗口失败:', error)
      this.stopDragging()
    })
  }

  private readonly onPointerUp = (): void => {
    this.stopDragging()
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!isScaleModeEnabled(event, this.platform, this.buttonGroup?.isScaling() ?? false)) return
    const direction = zoomDirectionForWheel(event.deltaY)
    if (direction === 0) return
    event.preventDefault()
    this.requestScale(direction)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!isScaleModeEnabled(event, this.platform, this.buttonGroup?.isScaling() ?? false)) return
    const direction = zoomDirectionForKey(event.key)
    if (direction === 0) return
    event.preventDefault()
    this.requestScale(direction)
  }
}
