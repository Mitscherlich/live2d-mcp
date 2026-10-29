import { screenPointToLookDirection, shouldProcessMouseFollow } from './desktop-interactions.js'
import type { Live2DApp } from './live2d-app.js'
import type { Live2dApi } from './live2d-bridge.js'
import type { ButtonGroupController } from './button-group.js'

/**
 * 鼠标跟随：陪伴模式真实功能，默认开启；调试面板的 checkbox 只是它的一个开关。
 *
 * main 以约 30fps 推送全局屏幕坐标，同帧附带窗口 bounds（preload 第三参），
 * renderer 直接按窗口中心归一化——不再需要 getWindowBounds 往返与串行队列簿记。
 * 事件只记录目标 + 置脏，实际 lookAt 每帧最多一次。
 */
export class MouseFollow {
  /** 调试面板 checkbox 直读写；默认开启 */
  enabled = true

  private targetX = 0
  private targetY = 0
  private dirty = false
  private inButtonHotspot: boolean
  private readonly offGlobalMouse: () => void
  private readonly offHotspot: (() => void) | undefined

  constructor(app: Live2DApp, api: Live2dApi, buttonGroup: ButtonGroupController | null) {
    this.inButtonHotspot = buttonGroup?.isHotspotActive() ?? false

    this.offHotspot = buttonGroup?.onHotspotChange((active) => {
      this.inButtonHotspot = active
      if (active) this.dirty = false
    })

    this.offGlobalMouse = api.onGlobalMouseMove((x, y, bounds) => {
      if (!bounds) return
      if (!shouldProcessMouseFollow(this.enabled, this.inButtonHotspot)) return
      const direction = screenPointToLookDirection({ x, y }, bounds)
      this.targetX = direction.x
      this.targetY = direction.y
      this.dirty = true
    })

    app.addTicker(() => {
      if (!shouldProcessMouseFollow(this.enabled, this.inButtonHotspot) || !this.dirty) return
      this.dirty = false
      app.lookAt(this.targetX, this.targetY)
    })
  }

  dispose(): void {
    this.offGlobalMouse()
    this.offHotspot?.()
  }
}
