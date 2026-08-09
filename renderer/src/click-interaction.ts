import { clientPointToCanvas, isModifierPressed } from './desktop-interactions.js'
import { HIT_AREA_MOTIONS, motionTag } from './model-config.ts'
import type { Live2DApp } from './live2d-app.js'
import type { Live2dApi } from './live2d-bridge.js'
import type { ButtonGroupController } from './button-group.js'
import type { StatusBar } from './status-bar.js'

/**
 * 点击触发动作：陪伴模式真实功能，无条件挂接。
 * 点击日志（appendClickLog）属调试面板 DOM，仅 ui-chrome 下写入。
 */
export class ClickInteraction {
  constructor(
    canvas: HTMLCanvasElement,
    app: Live2DApp,
    statusBar: StatusBar,
    buttonGroup: ButtonGroupController | null,
    api: Live2dApi,
    private readonly uiChrome: boolean,
  ) {
    const platform = api.platform
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || isModifierPressed(e, platform)) return
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
        this.appendClickLog(x, y, [], null)
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
      statusBar.noteMotion(motionTag(group))
      this.appendClickLog(x, y, hitAreas, group)
    })
  }

  private appendClickLog(px: number, py: number, hitAreas: string[], action: string | null): void {
    if (!this.uiChrome) return
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
}
