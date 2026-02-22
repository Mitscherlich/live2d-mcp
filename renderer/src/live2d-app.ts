/**
 * Live2D 应用核心 - 基于 pixi-live2d-display
 *
 * 需要 Live2D Cubism Core 已通过 <script> 标签加载
 */

import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'

// pixi-live2d-display 需要访问全局 PIXI
;(window as unknown as Record<string, unknown>).PIXI = PIXI

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

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.app = new PIXI.Application({
      view: canvas,
      width: 600,
      height: 600,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })

    await this.loadModel()
  }

  private async loadModel(): Promise<void> {
    if (!this.app) throw new Error('App not initialized')

    try {
      this.model = await Live2DModel.from(MODEL_PATH, {
        autoInteract: false,  // 关闭自动鼠标交互，由 MCP 控制
      })

      this.model.anchor.set(0.5, 0.5)
      this.model.position.set(this.app.screen.width / 2, this.app.screen.height / 2)

      // 自适应缩放
      const scale = Math.min(
        this.app.screen.width / this.model.width,
        this.app.screen.height / this.model.height
      ) * 0.9
      this.model.scale.set(scale)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.app.stage.addChild(this.model as any)

      // 收集模型信息
      this.modelInfo = this.extractModelInfo()

      console.log('[Live2D] Model loaded:', MODEL_PATH)
      console.log('[Live2D] Model info:', this.modelInfo)
    } catch (e) {
      console.error('[Live2D] Failed to load model:', e)
      document.getElementById('model-load-error')!.style.display = 'block'
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

    // 提取参数列表（从 Cubism Core）
    const parameters: ParameterInfo[] = []
    try {
      const coreModel = (internalModel as unknown as { coreModel: { parameters: { count: number; ids: string[]; minimumValues: number[]; maximumValues: number[]; defaultValues: number[] } } }).coreModel
      const params = coreModel?.parameters
      if (params) {
        for (let i = 0; i < params.count; i++) {
          parameters.push({
            id: params.ids[i],
            name: params.ids[i],
            min: params.minimumValues[i],
            max: params.maximumValues[i],
            defaultValue: params.defaultValues[i],
          })
        }
      }
    } catch (e) {
      console.warn('[Live2D] Could not extract parameters:', e)
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

  isLoaded(): boolean {
    return this.model !== null
  }
}
