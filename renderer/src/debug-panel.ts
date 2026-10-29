import { MOTION_NAMES, motionTag } from './model-config.ts'
import type { Live2DApp } from './live2d-app.js'
import type { StatusBar } from './status-bar.js'
import type { MouseFollow } from './mouse-follow.js'

/**
 * 底部调试抽屉：**仅 ui-chrome 开启时由 main.ts 动态 import 并构建**。
 * 陪伴模式下这些 DOM 被 CSS 隐藏，按钮/监听全部白做，故整段不进入主 bundle。
 */
export class DebugPanel {
  private readonly debugPanel = document.getElementById('debug-panel') as HTMLDivElement
  private readonly debugHeader = this.debugPanel.querySelector('.debug-header') as HTMLDivElement
  private readonly debugToggleBtn = document.getElementById('debug-toggle-btn') as HTMLButtonElement
  private readonly debugExpressionsEl = document.getElementById('debug-expressions') as HTMLDivElement
  private readonly debugMotionsEl = document.getElementById('debug-motions') as HTMLDivElement
  private readonly lookXInput = document.getElementById('look-x') as HTMLInputElement
  private readonly lookXVal = document.getElementById('look-x-val') as HTMLSpanElement
  private readonly lookYInput = document.getElementById('look-y') as HTMLInputElement
  private readonly lookYVal = document.getElementById('look-y-val') as HTMLSpanElement
  private readonly debugResetBtn = document.getElementById('debug-reset') as HTMLButtonElement
  private readonly hitareaToggle = document.getElementById('hitarea-toggle') as HTMLInputElement
  private readonly mouseFollowCheckbox = document.getElementById('mouse-follow') as HTMLInputElement

  private activeExprBtn: HTMLButtonElement | null = null
  private activeBtn: HTMLButtonElement | null = null

  constructor(
    private readonly app: Live2DApp,
    private readonly statusBar: StatusBar,
    private readonly mouseFollow: MouseFollow,
  ) {
    this.initToggle()
    this.initTabs()
    this.initExpressionButtons()
    this.initMotionButtons()
    this.initLookSliders()
    this.initMouseFollowCheckbox()
    this.initHitAreaToggle()
    this.initReset()
  }

  private motionLabel(group: string, index: number): string {
    return MOTION_NAMES[`${group}:${index}`] ?? motionTag(group, index)
  }

  // 展开/收起：仅 toggle 按钮触发
  private initToggle(): void {
    this.debugToggleBtn.addEventListener('click', () => {
      const expanded = this.debugPanel.classList.toggle('expanded')
      this.debugToggleBtn.textContent = expanded ? '▼ 收起' : '▲ 展开'
    })
  }

  // Tab 切换
  private initTabs(): void {
    const tabs = this.debugHeader.querySelectorAll<HTMLButtonElement>('.debug-tab')
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'))
        tab.classList.add('active')
        const paneId = `pane-${tab.dataset.tab}`
        this.debugPanel.querySelectorAll<HTMLDivElement>('.debug-pane').forEach((p) => {
          p.classList.toggle('active', p.id === paneId)
        })
        // 切换 tab 时若面板未展开则自动展开
        if (!this.debugPanel.classList.contains('expanded')) {
          this.debugPanel.classList.add('expanded')
          this.debugToggleBtn.textContent = '▼ 收起'
        }
      })
    })
  }

  // 动态生成表情按钮
  private initExpressionButtons(): void {
    const info = this.app.getModelInfo()
    if (!info || info.expressions.length === 0) {
      this.debugExpressionsEl.textContent = '无可用表情'
      this.debugExpressionsEl.style.color = '#555'
      this.debugExpressionsEl.style.fontSize = '11px'
      return
    }
    for (const name of info.expressions) {
      const btn = document.createElement('button')
      btn.className = 'motion-btn'
      btn.textContent = name
      btn.addEventListener('click', () => {
        this.app.setExpression(name)
        this.statusBar.noteExpression(name)
        this.activeExprBtn?.classList.remove('active')
        btn.classList.add('active')
        this.activeExprBtn = btn
      })
      this.debugExpressionsEl.appendChild(btn)
    }
  }

  // 动态生成动作按钮
  private initMotionButtons(): void {
    const info = this.app.getModelInfo()
    if (!info) return
    for (const [group, count] of Object.entries(info.motionGroups)) {
      for (let i = 0; i < count; i++) {
        const btn = document.createElement('button')
        btn.className = 'motion-btn'
        btn.textContent = this.motionLabel(group, i)
        btn.dataset.group = group
        btn.dataset.index = String(i)
        btn.addEventListener('click', () => {
          this.app.playMotion(group, i, 3)
          this.statusBar.noteMotion(this.motionLabel(group, i))
          this.activeBtn?.classList.remove('active')
          btn.classList.add('active')
          this.activeBtn = btn
        })
        this.debugMotionsEl.appendChild(btn)
      }
    }
  }

  // 视线控制：鼠标跟随开启时滑块禁用
  private setSliderDisabled(disabled: boolean): void {
    this.lookXInput.disabled = disabled
    this.lookYInput.disabled = disabled
  }

  private applyLookAt(): void {
    const x = parseFloat(this.lookXInput.value)
    const y = parseFloat(this.lookYInput.value)
    this.lookXVal.textContent = x.toFixed(2)
    this.lookYVal.textContent = y.toFixed(2)
    this.app.lookAt(x, y)
  }

  private initLookSliders(): void {
    this.lookXInput.addEventListener('input', () => this.applyLookAt())
    this.lookYInput.addEventListener('input', () => this.applyLookAt())
  }

  private initMouseFollowCheckbox(): void {
    this.mouseFollowCheckbox.checked = this.mouseFollow.enabled
    this.setSliderDisabled(this.mouseFollow.enabled)
    this.mouseFollowCheckbox.addEventListener('change', () => {
      this.mouseFollow.enabled = this.mouseFollowCheckbox.checked
      this.setSliderDisabled(this.mouseFollow.enabled)
      // 关闭时重置视线到滑块当前值
      if (!this.mouseFollow.enabled) {
        this.app.lookAt(parseFloat(this.lookXInput.value), parseFloat(this.lookYInput.value))
      }
    })
  }

  // HitArea 边框 overlay（每帧重绘，仅调试用）
  private initHitAreaToggle(): void {
    this.hitareaToggle.addEventListener('change', () => {
      this.app.showHitAreaOverlay(this.hitareaToggle.checked)
    })
  }

  // 重置
  private initReset(): void {
    this.debugResetBtn.addEventListener('click', () => {
      this.app.reset()
      this.lookXInput.value = '0'
      this.lookYInput.value = '0'
      this.lookXVal.textContent = '0.00'
      this.lookYVal.textContent = '0.00'
      if (!this.mouseFollow.enabled) this.app.lookAt(0, 0)
      this.activeExprBtn?.classList.remove('active')
      this.activeExprBtn = null
      this.activeBtn?.classList.remove('active')
      this.activeBtn = null
      this.statusBar.resetExpressionMotion()
    })
  }
}
