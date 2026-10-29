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
import { showModelLoadError } from './boot-error.js'

// 模块加载期副作用（main.ts 动态 import 本模块时执行一次）：
// Cubism Core 缺失时引擎在 import 期抛错（"Could not find Cubism runtime"），
// main.ts 捕获后落入缺模引导（FR-D3）。
// Live2D render pipe 必须在创建 PIXI.Application 之前注册。
PIXI.extensions.add(Live2DPlugin)
// 注册 Application 使用的 Ticker 类，避免 shared/app ticker 不一致导致模型不刷新
Live2DModel.registerTicker(PIXI.Ticker)

type CubismLive2DModel = Live2DModel<CubismInternalModel>

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

const MODEL_PATH = '/model/HiyoriPro/hiyori_pro_t11.model3.json'

export class Live2DApp {
  private app: PIXI.Application | null = null
  private model: CubismLive2DModel | null = null
  private modelInfo: ModelInfo | null = null
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

    await this.loadModel()
  }

  private async loadModel(): Promise<void> {
    if (!this.app) throw new Error('App not initialized')

    try {
      // 先按页面地址解析成绝对 URL：根相对路径交给 PIXI v8 Assets 补全时，
      // 自定义 scheme（prod 的 live2d-app://root/）会丢 host，贴图请求变成 live2d-app://model/...
      const modelUrl = new URL(MODEL_PATH, window.location.href).href
      this.model = (await Live2DModel.from(modelUrl, {
        // 关闭自动鼠标交互（命中检测 / 视线跟随），由 MCP 控制
        autoHitTest: false,
        autoFocus: false,
        // 由 app.ticker 显式驱动模型更新（与渲染同一条 ticker，避免空白画布）
        autoUpdate: false,
      })) as CubismLive2DModel

      // 等待至少一帧，确保 mesh/bounds 就绪（部分 Core/显卡组合首次 width/height 为 0）
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })
      this.model.update(0)

      const rawW = this.model.width || this.model.getBounds?.(true)?.width || 0
      const rawH = this.model.height || this.model.getBounds?.(true)?.height || 0
      // 部分环境下 getBounds 更可靠；若仍为 0，用合理默认防止 scale=Infinity/0
      const modelW = rawW > 1 ? rawW : 1000
      const modelH = rawH > 1 ? rawH : 1500

      this.model.anchor.set(0.5, 0.5)
      this.model.position.set(this.app.screen.width / 2, this.app.screen.height / 2)

      // 自适应缩放
      const scale =
        Math.min(this.app.screen.width / modelW, this.app.screen.height / modelH) * 0.9
      this.model.scale.set(scale)

      this.app.stage.addChild(this.model)

      this.app.ticker.add(() => {
        if (!this.model) return
        try {
          this.model.update(this.app!.ticker.deltaMS)
        } catch (err) {
          // 单帧失败不炸掉 ticker；打一次日志
          if (!(this as unknown as { _updateErrLogged?: boolean })._updateErrLogged) {
            ;(this as unknown as { _updateErrLogged?: boolean })._updateErrLogged = true
            console.error('[Live2D] model.update failed:', err)
          }
        }
      })

      // 播放默认 Idle，避免 T 姿势/静止不可见
      try {
        void this.model.motion('Idle').catch(() => {})
      } catch {
        /* Idle 不存在时忽略 */
      }

      // 收集模型信息
      this.modelInfo = this.extractModelInfo()

      const bounds = this.model.getBounds(true)
      console.log('[Live2D] Model loaded:', MODEL_PATH, {
        screen: { w: this.app.screen.width, h: this.app.screen.height },
        modelSize: { rawW, rawH, modelW, modelH },
        scale,
        pos: { x: this.model.position.x, y: this.model.position.y },
        bounds: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
        paramCount: this.modelInfo?.parameters?.length ?? 0,
        motions: this.modelInfo?.motionGroups,
      })
      console.log('[Live2D] Model info:', this.modelInfo)
    } catch (e) {
      console.error('[Live2D] Failed to load model:', e)
      showModelLoadError(e)
      throw e
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
