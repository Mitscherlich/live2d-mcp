/**
 * Live2D 应用核心 - 基于 pixi-live2d-display
 *
 * 需要 Live2D Cubism Core 已通过 <script> 标签加载。
 * Electron CSP 禁用 unsafe-eval：用 @pixi/unsafe-eval 的 install 补丁，
 * 避免 PIXI ShaderSystem 走 new Function。
 */

import * as PIXI from 'pixi.js'
import { install as installPixiUnsafeEval } from '@pixi/unsafe-eval'
import { Live2DModel } from 'pixi-live2d-display/cubism4'

// 必须在创建 PIXI.Application 之前 install
installPixiUnsafeEval(PIXI)

// pixi-live2d-display 需要访问全局 PIXI，并用同一 Ticker 驱动 autoUpdate
;(window as unknown as Record<string, unknown>).PIXI = PIXI
// 注册 Application 使用的 Ticker 类，避免 shared/app ticker 不一致导致模型不刷新
Live2DModel.registerTicker(PIXI.Ticker)

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
  private model: Live2DModel | null = null
  private modelInfo: ModelInfo | null = null
  private hitAreaGraphics: PIXI.Graphics | null = null

  async init(canvas: HTMLCanvasElement): Promise<void> {
    // Electron 透明窗 + WebGL：需要 alpha 通道与 premultipliedAlpha，
    // 并保留 drawing buffer 便于诊断；backgroundAlpha=0 适配透明窗体。
    this.app = new PIXI.Application({
      view: canvas,
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
      this.model = await Live2DModel.from(MODEL_PATH, {
        autoInteract: false,  // 关闭自动鼠标交互，由 MCP 控制
      })

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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.app.stage.addChild(this.model as any)

      // 强制用 app.ticker 驱动模型更新（与渲染同一条 ticker，避免空白画布）
      this.model.autoUpdate = false
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
        this.model.motion('Idle')
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
      const panel = document.getElementById('model-load-error')
      if (panel) {
        panel.style.display = 'block'
        const detail = panel.querySelector('[data-error-detail]')
        if (detail) {
          detail.textContent = e instanceof Error ? e.message : String(e)
        }
      }
      throw e
    }
  }

  private extractModelInfo(): ModelInfo {
    if (!this.model) return { expressions: [], motionGroups: {}, parameters: [] }

    const internalModel = (this.model as unknown as { internalModel: { settings: { json: Record<string, unknown> } } }).internalModel
    const settings = internalModel?.settings?.json ?? {}

    // Cubism 4 model3.json 将资源路径放在 FileReferences 下
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

    // 提取参数列表：优先 Core parameters 表；否则从 model3 Groups / lipSyncIds 兜底
    // （Cubism Core + Framework 组合下 coreModel.parameters 可能不可枚举）
    const parameters: ParameterInfo[] = []
    const seen = new Set<string>()
    const pushParam = (id: string, min = 0, max = 1, defaultValue = 0) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      parameters.push({ id, name: id, min, max, defaultValue })
    }
    try {
      const coreModel = (
        internalModel as unknown as {
          coreModel?: {
            parameters?: {
              count: number
              ids: ArrayLike<string>
              minimumValues: ArrayLike<number>
              maximumValues: ArrayLike<number>
              defaultValues: ArrayLike<number>
            }
          }
        }
      ).coreModel
      const params = coreModel?.parameters
      if (params && params.count > 0 && params.ids) {
        for (let i = 0; i < params.count; i++) {
          pushParam(
            String(params.ids[i]),
            Number(params.minimumValues?.[i] ?? 0),
            Number(params.maximumValues?.[i] ?? 1),
            Number(params.defaultValues?.[i] ?? 0),
          )
        }
      }
    } catch (e) {
      console.warn('[Live2D] Could not extract parameters from coreModel:', e)
    }
    // Groups（LipSync / EyeBlink 等）
    const groups =
      (settings['Groups'] as Array<{ Name?: string; Ids?: string[] }> | undefined) ?? []
    for (const g of groups) {
      for (const id of g.Ids ?? []) pushParam(id)
    }
    // Framework lipSync / eyeBlink id 列表
    try {
      const im = internalModel as unknown as {
        getLipSyncIds?: () => string[]
        getEyeBlinkIds?: () => string[]
      }
      for (const id of im.getLipSyncIds?.() ?? []) pushParam(id)
      for (const id of im.getEyeBlinkIds?.() ?? []) pushParam(id)
    } catch {
      /* ignore */
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
      // pixi-live2d-display 通过 focus 方法控制眼神
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
    try {
      const internalModel = (this.model as unknown as { internalModel: { coreModel: { setParameterValueById: (id: string, value: number) => void } } }).internalModel
      internalModel?.coreModel?.setParameterValueById(paramId, value)
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.app.stage.removeChild(this.hitAreaGraphics as any)
        this.hitAreaGraphics.destroy()
        this.hitAreaGraphics = null
      }
      return
    }
    if (this.hitAreaGraphics) return
    this.hitAreaGraphics = new PIXI.Graphics()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.stage.addChild(this.hitAreaGraphics as any)
    this.app.ticker.add(this.drawHitAreaOverlay, this)
  }

  private drawHitAreaOverlay(): void {
    const g = this.hitAreaGraphics
    if (!g || !this.model) return
    g.clear()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalModel = (this.model as any).internalModel
    const hitAreas: Array<{ Id?: string; id?: string; Name?: string; name?: string }> =
      internalModel?.settings?.hitAreas ?? []

    // getDrawableVertexPositions 返回 Cubism NDC 坐标（原点在模型中心，Y 轴向上，范围 [-1,1]）
    // worldTransform.apply 期望纹理空间坐标（原点左上角，Y 轴向下，[0, originalWidth] × [0, originalHeight]）
    // 需要先做坐标系转换：texX = (cx + 1) * halfW，texY = (1 - cy) * halfH
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const halfW: number = (internalModel?.originalWidth ?? 0) / 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const halfH: number = (internalModel?.originalHeight ?? 0) / 2

    for (const area of hitAreas) {
      const areaId = area.Id ?? area.id ?? ''

      let vertices: Float32Array | undefined
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const coreModel = internalModel?.coreModel as any
        // 方式 A: drawables 属性数组（pixi-live2d-display 封装）
        if (coreModel?.drawables?.ids) {
          const ids: string[] = Array.from(coreModel.drawables.ids as ArrayLike<string>)
          const idx = ids.indexOf(areaId)
          if (idx >= 0) vertices = coreModel.drawables.vertexPositions?.[idx]
        }
        // 方式 B: getDrawable* 方法（直接 Cubism SDK API）
        if (!vertices && typeof coreModel?.getDrawableIndex === 'function') {
          const idx: number = coreModel.getDrawableIndex(areaId)
          if (idx >= 0) vertices = coreModel.getDrawableVertexPositions?.(idx)
        }
      } catch {
        continue
      }

      if (!vertices || vertices.length < 4 || halfW === 0 || halfH === 0) continue

      // Cubism NDC → 纹理空间坐标，计算 AABB
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < vertices.length; i += 2) {
        const tx = (vertices[i] + 1) * halfW          // cx → texX
        const ty = (1 - vertices[i + 1]) * halfH      // cy → texY（Y 轴翻转）
        if (tx < minX) minX = tx
        if (tx > maxX) maxX = tx
        if (ty < minY) minY = ty
        if (ty > maxY) maxY = ty
      }

      // 纹理空间坐标 → canvas 坐标（通过 worldTransform）
      const wt = (this.model as unknown as { worldTransform: PIXI.Matrix }).worldTransform
      const tl = wt.apply(new PIXI.Point(minX, minY))
      const tr = wt.apply(new PIXI.Point(maxX, minY))
      const br = wt.apply(new PIXI.Point(maxX, maxY))
      const bl = wt.apply(new PIXI.Point(minX, maxY))

      g.lineStyle(1.5, 0x64b4ff, 0.85)
      g.beginFill(0x64b4ff, 0.07)
      g.moveTo(tl.x, tl.y)
      g.lineTo(tr.x, tr.y)
      g.lineTo(br.x, br.y)
      g.lineTo(bl.x, bl.y)
      g.closePath()
      g.endFill()
    }
  }

  // 命中检测，返回点击到的区域名称列表（坐标为 canvas 像素坐标）
  hitTest(x: number, y: number): string[] {
    if (!this.model) return []
    try {
      // pixi-live2d-display 接受 canvas 全局坐标
      return (this.model as unknown as { hitTest: (x: number, y: number) => string[] }).hitTest(x, y)
    } catch {
      return []
    }
  }

  isLoaded(): boolean {
    return this.model !== null
  }
}
