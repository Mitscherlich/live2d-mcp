/**
 * Live2D 应用核心 - 基于 untitled-pixi-live2d-engine（PixiJS v8 + Cubism 5 Framework）
 *
 * 需要 Live2D Cubism Core（Cubism 5 SDK for Web 附带版本）已通过 <script> 标签加载。
 * Electron CSP 禁用 unsafe-eval：引入 pixi.js/unsafe-eval，
 * 避免 PIXI v8 的 shader/uniform 同步走 new Function。
 */

import 'pixi.js/unsafe-eval'
import * as PIXI from 'pixi.js'
import { Live2DModel, Live2DPlugin, type CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism'
import { EMPTY_OVERRIDES, type ModelOverrides } from './model-config.ts'

// 模块加载期副作用（main.ts 动态 import 本模块时执行一次）：
// Cubism Core 缺失时引擎在 import 期抛错（"Could not find Cubism runtime"），
// main.ts 捕获后落入缺模引导（FR-D3）。
// Live2D render pipe 必须在创建 PIXI.Application 之前注册。
PIXI.extensions.add(Live2DPlugin)
// 注册 Application 使用的 Ticker 类，避免 shared/app ticker 不一致导致模型不刷新
Live2DModel.registerTicker(PIXI.Ticker)

type CubismLive2DModel = Live2DModel<CubismInternalModel>

// PixiJS v8 DestroyOptions; the engine's d.ts still declares the narrower v7 shape, hence the cast.
const FULL_DESTROY = { children: true, texture: true, textureSource: true } as unknown as Parameters<CubismLive2DModel['destroy']>[0]

export interface ModelInfo {
  expressions: string[]
  motionGroups: Record<string, number>
  parameters: ParameterInfo[]
}

export interface ParameterInfo {
  id: string
  name: string
  min: number
  max: number
  defaultValue: number
}

export class Live2DApp {
  private app: PIXI.Application | null = null
  private model: CubismLive2DModel | null = null
  private modelInfo: ModelInfo | null = null
  /** Per-model tuning delivered with the active model (hit areas, physics drives, labels) */
  private overrides: ModelOverrides = EMPTY_OVERRIDES
  /** True while a swap is in flight; commands should answer "busy" instead of touching a half-built model */
  private swapping = false
  /** Fit-to-window scale chosen at load; zoom multiplies it */
  private baseScale = 1
  private physicsHandler: (() => void) | null = null
  private hitAreaGraphics: PIXI.Graphics | null = null
  /** hitArea id → drawable 下标：overlay 开启时建一次，关闭时丢弃（每帧全量查 ids 太贵） */
  private hitAreaDrawables: Map<string, number> | null = null
  /** 参数 id → 下标：Cubism 5 Framework 的 *ById 需 CubismIdHandle，按下标写更直接 */
  private parameterIndices = new Map<string, number>()
  /** overlay 每帧复用的 bounds 对象 */
  private readonly overlayBounds = { x: 0, y: 0, width: 0, height: 0 }
  /** overlay 每帧复用的点，避免每区域 new PIXI.Point ×4 */
  private readonly overlayIn = new PIXI.Point()
  private readonly overlayOut = [
    new PIXI.Point(),
    new PIXI.Point(),
    new PIXI.Point(),
    new PIXI.Point(),
  ]

  async init(canvas: HTMLCanvasElement): Promise<void> {
    // Electron 透明窗 + WebGL：需要 alpha 通道与 premultipliedAlpha，
    // 并保留 drawing buffer 便于诊断；backgroundAlpha=0 适配透明窗体。
    this.app = new PIXI.Application()
    await this.app.init({
      canvas,
      // Live2D render pipe 仅实现了 WebGL
      preference: 'webgl',
      width: 600,
      height: 600,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      // 透明窗口下默认 clear 可能与合成器叠加异常；强制 RGBA clear
      clearBeforeRender: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })

    // 暴露诊断句柄（仅开发/排障）
    ;(canvas as unknown as { __PIXI_APP?: PIXI.Application }).__PIXI_APP = this.app

    // Single per-frame model update; follows whatever model is current across hot swaps.
    this.app.ticker.add(() => {
      if (!this.model) return
      try {
        this.model.update(this.app!.ticker.deltaMS)
      } catch (err) {
        if (!(this as unknown as { _updateErrLogged?: boolean })._updateErrLogged) {
          ;(this as unknown as { _updateErrLogged?: boolean })._updateErrLogged = true
          console.error('[Live2D] model.update failed:', err)
        }
      }
    })
  }

  /** Draw the current stage synchronously so the canvas can be read back right away (snapshots). */
  renderNow(): boolean {
    if (!this.app || !this.model) return false
    try {
      this.model.update(0)
      this.app.renderer.render(this.app.stage)
      return true
    } catch (e) {
      console.warn('[Live2D] renderNow failed:', e)
      return false
    }
  }

  /** Tear everything down (preview page): model, ticker and the WebGL context. */
  destroy(): void {
    this.unloadModel()
    if (this.app) {
      try {
        this.app.destroy(false, { children: true, texture: true, textureSource: true } as never)
      } catch (e) {
        console.warn('[Live2D] app destroy failed:', e)
      }
      this.app = null
    }
  }

  isBusy(): boolean {
    return this.swapping
  }

  getOverrides(): ModelOverrides {
    return this.overrides
  }

  /** Release the current model and every per-model resource (idempotent). */
  unloadModel(): void {
    if (!this.app) return
    this.showHitAreaOverlay(false)
    const old = this.model
    this.model = null
    this.modelInfo = null
    this.parameterIndices.clear()
    if (old) {
      if (this.physicsHandler) {
        try { old.internalModel.off('beforeMotionUpdate', this.physicsHandler) } catch { /* already detached */ }
      }
      this.app.stage.removeChild(old)
      try {
        old.destroy(FULL_DESTROY)
      } catch (e) {
        console.warn('[Live2D] model destroy failed:', e)
      }
    }
    this.physicsHandler = null
    this.overrides = EMPTY_OVERRIDES
  }

  /**
   * Load a model and hot-swap it in. The new model is fully built first; only on success is
   * the old one destroyed, so a failure leaves the current model running untouched.
   */
  async loadModel(modelPath: string, overrides: ModelOverrides = EMPTY_OVERRIDES): Promise<void> {
    if (!this.app) throw new Error('App not initialized')
    if (this.swapping) throw new Error('A model swap is already in progress')
    this.swapping = true
    let next: CubismLive2DModel | null = null
    try {
      // Resolve to an absolute URL first: root-relative paths handed to PIXI v8 Assets lose the
      // host under the custom prod scheme (live2d-app://root/), breaking texture requests.
      const modelUrl = new URL(modelPath, window.location.href).href
      next = (await Live2DModel.from(modelUrl, {
        // Mouse hit-test/focus are driven by MCP and our own handlers
        autoHitTest: false,
        autoFocus: false,
        // The app ticker drives updates explicitly
        autoUpdate: false,
      })) as CubismLive2DModel

      // Wait one frame so mesh/bounds are ready (some Core/GPU combos report 0 size at first)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      next.update(0)

      const rawW = next.width || next.getBounds?.(true)?.width || 0
      const rawH = next.height || next.getBounds?.(true)?.height || 0
      const modelW = rawW > 1 ? rawW : 1000
      const modelH = rawH > 1 ? rawH : 1500
      next.anchor.set(0.5, 0.5)
      next.position.set(this.app.screen.width / 2, this.app.screen.height / 2)
      this.baseScale = Math.min(this.app.screen.width / modelW, this.app.screen.height / modelH) * 0.9
      next.scale.set(this.baseScale)

      // Success: now (and only now) retire the old model.
      this.unloadModel()
      this.model = next
      this.overrides = overrides
      this.app.stage.addChild(next)
      try {
        void next.motion('Idle').catch(() => {})
      } catch {
        /* no Idle group */
      }
      this.modelInfo = this.extractModelInfo()
      this.bindPhysicsInputs()
      console.log('[Live2D] Model loaded:', modelUrl, {
        paramCount: this.modelInfo?.parameters?.length ?? 0,
        motions: this.modelInfo?.motionGroups,
      })
    } catch (e) {
      if (next && next !== this.model) {
        try { next.destroy(FULL_DESTROY) } catch { /* ignore */ }
      }
      console.error('[Live2D] Failed to load model:', e)
      throw e
    } finally {
      this.swapping = false
    }
  }

  private extractModelInfo(): ModelInfo {
    if (!this.model) return { expressions: [], motionGroups: {}, parameters: [] }

    const internalModel = this.model.internalModel
    const settings = internalModel.settings.json as Record<string, unknown>

    // model3.json 将资源路径放在 FileReferences 下
    const fileRefs = (settings['FileReferences'] as Record<string, unknown> | undefined) ?? settings

    // 提取表情列表
    const expressionsRaw = (fileRefs['Expressions'] as Array<{ Name: string }> | undefined) ?? []
    const expressions = expressionsRaw.map((e) => e.Name)

    // 提取动作分组
    const motionsRaw = (fileRefs['Motions'] as Record<string, unknown[]> | undefined) ?? {}
    const motionGroups: Record<string, number> = {}
    for (const [group, motions] of Object.entries(motionsRaw)) {
      motionGroups[group] = Array.isArray(motions) ? motions.length : 0
    }

    // 提取参数列表：Core 模型的 parameters 表（Cubism 5 Framework 经 getModel() 暴露）；
    // 同时建 id → 下标索引供 setParameter 使用
    const parameters: ParameterInfo[] = []
    this.parameterIndices.clear()
    try {
      const params = internalModel.coreModel.getModel().parameters
      for (let i = 0; i < params.count; i++) {
        const id = String(params.ids[i])
        this.parameterIndices.set(id, i)
        parameters.push({
          id,
          name: id,
          min: params.minimumValues[i],
          max: params.maximumValues[i],
          defaultValue: params.defaultValues[i],
        })
      }
    } catch (e) {
      console.warn('[Live2D] Could not extract parameters from coreModel:', e)
    }

    return { expressions, motionGroups, parameters }
  }

  getModelInfo(): ModelInfo | null {
    return this.modelInfo
  }

  /** Multiply the fit-to-window scale (preview inspector zoom). */
  setZoom(zoom: number): boolean {
    if (!this.model || !Number.isFinite(zoom)) return false
    this.model.scale.set(this.baseScale * Math.min(3, Math.max(0.3, zoom)))
    return true
  }

  /** Part ids with their current opacity (preview inspector). */
  getPartList(): Array<{ id: string; opacity: number }> {
    if (!this.model) return []
    try {
      const parts = this.model.internalModel.coreModel.getModel().parts
      const list: Array<{ id: string; opacity: number }> = []
      for (let i = 0; i < parts.count; i++) list.push({ id: String(parts.ids[i]), opacity: parts.opacities?.[i] ?? 1 })
      return list
    } catch {
      return []
    }
  }

  setPartVisible(partId: string, visible: boolean): boolean {
    if (!this.model) return false
    try {
      const core = this.model.internalModel.coreModel
      const parts = core.getModel().parts
      for (let i = 0; i < parts.count; i++) {
        if (String(parts.ids[i]) === partId) {
          core.setPartOpacityByIndex(i, visible ? 1 : 0)
          return true
        }
      }
    } catch (e) {
      console.error('[Live2D] setPartVisible failed:', e)
    }
    return false
  }

  /** Individual motion files per group, for the preview inspector. */
  getMotionFiles(): Array<{ group: string; index: number; name: string }> {
    if (!this.model) return []
    const settings = this.model.internalModel.settings.json as Record<string, unknown>
    const refs = (settings['FileReferences'] as Record<string, unknown> | undefined) ?? settings
    const motions = (refs['Motions'] as Record<string, Array<{ File?: string }>> | undefined) ?? {}
    const out: Array<{ group: string; index: number; name: string }> = []
    for (const [group, list] of Object.entries(motions)) {
      if (!Array.isArray(list)) continue
      list.forEach((m, index) => {
        const base = String(m?.File ?? `${group}_${index}`).split('/').pop() ?? ''
        out.push({ group, index, name: base.replace(/\.motion3\.json$/i, '') })
      })
    }
    return out
  }

  /** DisplayInfo (cdi3) file path relative to the model entry, if declared. */
  getDisplayInfoFile(): string | null {
    if (!this.model) return null
    const settings = this.model.internalModel.settings.json as Record<string, unknown>
    const refs = (settings['FileReferences'] as Record<string, unknown> | undefined) ?? settings
    return typeof refs['DisplayInfo'] === 'string' ? (refs['DisplayInfo'] as string) : null
  }

  // 切换表情
  setExpression(expressionName: string): boolean {
    if (!this.model) return false
    try {
      this.model.expression(expressionName)
      return true
    } catch (e) {
      console.error('[Live2D] setExpression failed:', e)
      return false
    }
  }

  // 播放动作
  playMotion(group: string, index: number = -1, priority: number = 2): boolean {
    if (!this.model) return false
    try {
      if (index < 0) {
        // 随机选择
        this.model.motion(group, undefined, priority)
      } else {
        this.model.motion(group, index, priority)
      }
      return true
    } catch (e) {
      console.error('[Live2D] playMotion failed:', e)
      return false
    }
  }

  // 设置眼神方向（-1 到 1）
  lookAt(x: number, y: number): boolean {
    if (!this.model) return false
    try {
      // 引擎通过 focus 方法控制眼神（stage 全局坐标）
      this.model.focus(
        this.app!.screen.width / 2 + x * this.app!.screen.width / 2,
        this.app!.screen.height / 2 - y * this.app!.screen.height / 2
      )
      return true
    } catch (e) {
      console.error('[Live2D] lookAt failed:', e)
      return false
    }
  }

  // 设置参数
  setParameter(paramId: string, value: number): boolean {
    if (!this.model) return false
    const index = this.parameterIndices.get(paramId)
    if (index === undefined) return false
    try {
      this.model.internalModel.coreModel.setParameterValueByIndex(index, value)
      return true
    } catch (e) {
      console.error('[Live2D] setParameter failed:', e)
      return false
    }
  }

  /**
   * 写在 beforeMotionUpdate：focus 已平滑，动作尚未改参，紧接着的 saveParameters
   * 会把输入存下来，物理本帧就能读到。缺参的模型 setParameter 直接跳过。
   */
  private bindPhysicsInputs(): void {
    const internal = this.model?.internalModel
    const drives = this.overrides.physicsInputDrives
    if (!internal || drives.length === 0) return
    this.physicsHandler = () => {
      const { x, y } = internal.focusController
      const timeSec = performance.now() / 1000
      for (const drive of drives) {
        const breath = Math.sin((timeSec * Math.PI * 2) / drive.breathCycle) * drive.breathAmp
        this.setParameter(drive.id, drive.x * x + drive.y * y + drive.xy * x * y + breath)
      }
    }
    internal.on('beforeMotionUpdate', this.physicsHandler)
  }

  /**
   * 注册每帧回调（ADR 0001 · F3 口型驱动）。
   * UPDATE_PRIORITY.LOW：保证在 Live2D 模型自身的 update（motion 求解，NORMAL
   * 优先级）之后执行——口型写入的 ParamMouthOpenY 不被本帧 motion 覆盖，
   * 且在当帧渲染生效。deltaMS 为真实帧间隔毫秒（PIXI ticker.deltaMS）。
   */
  addTicker(fn: (deltaMS: number) => void): void {
    if (!this.app) return
    this.app.ticker.add(() => fn(this.app!.ticker.deltaMS), null, PIXI.UPDATE_PRIORITY.LOW)
  }

  // 重置
  reset(): boolean {
    if (!this.model) return false
    try {
      // 重置表情为 normal 或第一个表情
      const expressions = this.modelInfo?.expressions ?? []
      if (expressions.length > 0) {
        const normalExpr = expressions.find((e) => e.toLowerCase().includes('normal')) ?? expressions[0]
        this.model.expression(normalExpr)
      }
      // 停止当前动作，回到 idle
      const idleGroup = Object.keys(this.modelInfo?.motionGroups ?? {}).find((g) =>
        g.toLowerCase().includes('idle')
      )
      if (idleGroup) {
        this.model.motion(idleGroup, undefined, 1)
      }
      // 重置眼神
      this.lookAt(0, 0)
      return true
    } catch (e) {
      console.error('[Live2D] reset failed:', e)
      return false
    }
  }

  // HitArea 边框 overlay
  showHitAreaOverlay(show: boolean): void {
    if (!this.app) return
    if (!show) {
      if (this.hitAreaGraphics) {
        this.app.ticker.remove(this.drawHitAreaOverlay, this)
        this.app.stage.removeChild(this.hitAreaGraphics)
        this.hitAreaGraphics.destroy()
        this.hitAreaGraphics = null
      }
      this.hitAreaDrawables = null
      return
    }
    if (this.hitAreaGraphics) return
    this.hitAreaDrawables = this.buildHitAreaDrawables()
    this.hitAreaGraphics = new PIXI.Graphics()
    this.app.stage.addChild(this.hitAreaGraphics)
    this.app.ticker.add(this.drawHitAreaOverlay, this)
  }

  /** hitArea id → drawable 下标：引擎加载时已解析（internalModel.hitAreas），此处只取快照 */
  private buildHitAreaDrawables(): Map<string, number> {
    const map = new Map<string, number>()
    for (const area of Object.values(this.model?.internalModel.hitAreas ?? {})) {
      if (area.index >= 0) map.set(area.id, area.index)
    }
    if (map.size === 0) console.warn('[Live2D] HitArea overlay：未解析到任何可绘制区域')
    return map
  }

  private drawHitAreaOverlay(): void {
    const g = this.hitAreaGraphics
    if (!g || !this.model || !this.hitAreaDrawables) return
    g.clear()

    // getDrawableBounds 返回模型画布坐标（原点左上角，Y 轴向下，[0, originalWidth] × [0, originalHeight]）；
    // 画布坐标 → stage 坐标：先 internalModel.localTransform，再 model.worldTransform
    // （即 toModelPosition 的逆变换）
    const internalModel = this.model.internalModel
    const lt = internalModel.localTransform
    const wt = this.model.worldTransform
    const b = this.overlayBounds
    const corners = this.overlayOut

    for (const idx of this.hitAreaDrawables.values()) {
      try {
        // d.ts 把参数类型解析成了 PIXI.Bounds；运行时只写 x/y/width/height
        internalModel.getDrawableBounds(idx, b as unknown as PIXI.Bounds)
      } catch {
        continue
      }

      // 点实例复用，零分配
      corners[0].set(b.x, b.y)
      corners[1].set(b.x + b.width, b.y)
      corners[2].set(b.x + b.width, b.y + b.height)
      corners[3].set(b.x, b.y + b.height)
      for (const p of corners) {
        lt.apply(p, this.overlayIn)
        wt.apply(this.overlayIn, p)
      }

      g.poly(corners.flatMap((p) => [p.x, p.y]))
        .fill({ color: 0x64b4ff, alpha: 0.07 })
        .stroke({ width: 1.5, color: 0x64b4ff, alpha: 0.85 })
    }
  }

  // 命中检测，返回点击到的区域名称列表（坐标为 canvas 像素坐标）
  hitTest(x: number, y: number): string[] {
    if (!this.model) return []
    try {
      // 引擎接受 stage 全局坐标，返回命中的 HitArea 名称
      return this.model.hitTest(x, y)
    } catch {
      return []
    }
  }

  isLoaded(): boolean {
    return this.model !== null
  }
}
