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
  private hitAreaGraphics: PIXI.Graphics | null = null

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

  // ========== TTS + 口型同步功能 ==========
  
  private speakingAudio: HTMLAudioElement | null = null
  private lipSyncInterval: number | null = null
  private lipSyncRaf: number | null = null
  private audioContext: AudioContext | null = null
  private isSpeaking = false

  /**
   * 仅启动口型动画 - 用于配合外部 TTS
   */
  startLipSyncOnly(duration: number, emotion: string): boolean {
    if (!this.model) return false

    try {
      // 停止之前的说话
      this.stopSpeaking()

      // 设置表情
      this.setExpression(emotion)

      // 启动口型动画
      this.isSpeaking = true
      this.startLipSyncAnimationWithDuration(duration)

      console.log('[Live2D] Lip sync only started, duration:', duration, 'ms')
      return true
    } catch (e) {
      console.error('[Live2D] Start lip sync only failed:', e)
      return false
    }
  }

  /**
   * 启动固定时长的口型动画
   */
  private startLipSyncAnimationWithDuration(durationMs: number): void {
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval)
    }

    const startTime = Date.now()
    const frameInterval = 50

    this.lipSyncInterval = window.setInterval(() => {
      const elapsed = Date.now() - startTime

      if (elapsed >= durationMs) {
        this.stopSpeaking()
        return
      }

      // 使用正弦波叠加，模拟自然说话节奏
      const progress = elapsed / durationMs
      const mouthOpen = (
        Math.abs(Math.sin(progress * Math.PI * 8)) * 0.5 +
        Math.abs(Math.sin(progress * Math.PI * 13)) * 0.3 +
        Math.abs(Math.sin(progress * Math.PI * 5)) * 0.2
      ) * 0.8

      this.setParameter('ParamMouthOpenY', mouthOpen)
    }, frameInterval)
  }

  /**
   * 口型同步 - 根据音频播放同步口型
   */
  lipSync(
    audioUrl?: string,
    audioBase64?: string,
    lipSyncData?: Array<{ time: number; value: number }>
  ): boolean {
    if (!this.model) return false

    try {
      // 停止之前的说话
      this.stopSpeaking()

      // 播放音频，口型优先用时间轴，无时间轴则用音量分析
      if (audioUrl || audioBase64) {
        const audio = new Audio(audioBase64 ? `data:audio/mp3;base64,${audioBase64}` : audioUrl)
        audio.crossOrigin = 'anonymous'
        this.speakingAudio = audio

        audio.onplay = () => {
          this.isSpeaking = true
          if (lipSyncData && lipSyncData.length > 0) {
            this.playLipSyncData(lipSyncData)
          } else {
            this.startAudioDrivenLipSync(audio)
          }
        }

        audio.onended = () => {
          this.stopSpeaking()
        }

        audio.play()
        return true
      }

      return false
    } catch (e) {
      console.error('[Live2D] Lip sync failed:', e)
      return false
    }
  }

  /**
   * Web Audio API 实时音量驱动口型
   */
  private startAudioDrivenLipSync(audio: HTMLAudioElement): void {
    // 复用或新建 AudioContext
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
    }
    const ctx = this.audioContext

    const source = ctx.createMediaElementSource(audio)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.85  // 高平滑，让嘴型变化舒缓

    source.connect(analyser)
    analyser.connect(ctx.destination)

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    let currentMouth = 0

    const tick = () => {
      if (!this.isSpeaking) return

      analyser.getByteFrequencyData(dataArray)

      // 取低频段（语音主要能量区）的均值
      const sliceEnd = Math.floor(dataArray.length * 0.25)
      let sum = 0
      for (let i = 0; i < sliceEnd; i++) sum += dataArray[i]
      const avg = sum / sliceEnd  // 0 ~ 255

      const target = Math.min(1, Math.pow(avg / 180, 0.7))

      // 每帧缓动，0.12 约等于 100ms 内跟上目标值的 50%（60fps 下）
      currentMouth += (target - currentMouth) * 0.12

      this.setParameter('ParamMouthOpenY', currentMouth)
      this.lipSyncRaf = requestAnimationFrame(tick)
    }

    this.lipSyncRaf = requestAnimationFrame(tick)
  }

  /**
   * 停止说话
   */
  stopSpeaking(): void {
    // 停止音频
    if (this.speakingAudio) {
      this.speakingAudio.pause()
      this.speakingAudio = null
    }

    // 停止 RAF 口型循环
    if (this.lipSyncRaf !== null) {
      cancelAnimationFrame(this.lipSyncRaf)
      this.lipSyncRaf = null
    }

    // 停止定时器口型循环（startLipSyncOnly 使用）
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval)
      this.lipSyncInterval = null
    }

    this.isSpeaking = false

    // 嘴巴闭合
    this.setParameter('ParamMouthOpenY', 0)

    console.log('[Live2D] Speaking stopped')
  }

  /**
   * 启动口型动画（模拟）
   */
  private startLipSyncAnimation(): void {
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval)
    }

    // 模拟口型动画 - 使用正弦波模拟说话节奏
    let time = 0
    this.lipSyncInterval = window.setInterval(() => {
      if (!this.isSpeaking) {
        this.stopSpeaking()
        return
      }

      time += 0.1
      // 使用多个正弦波叠加，模拟自然说话的节奏
      const mouthOpen = (
        Math.abs(Math.sin(time * 8)) * 0.5 +
        Math.abs(Math.sin(time * 13)) * 0.3 +
        Math.abs(Math.sin(time * 5)) * 0.2
      ) * 0.8

      this.setParameter('ParamMouthOpenY', mouthOpen)
    }, 50) // 每 50ms 更新一次
  }

  /**
   * 播放预计算的口型数据（时间轴插值）
   */
  private playLipSyncData(lipSyncData: Array<{ time: number; value: number }>): void {
    const startTime = Date.now()
    const lastTime = lipSyncData[lipSyncData.length - 1].time

    const updateLip = () => {
      const elapsed = Date.now() - startTime

      // 二分查找当前时间点对应的区间，线性插值
      let value = 0
      for (let i = lipSyncData.length - 1; i >= 0; i--) {
        if (elapsed >= lipSyncData[i].time) {
          if (i < lipSyncData.length - 1) {
            const t0 = lipSyncData[i].time
            const t1 = lipSyncData[i + 1].time
            const alpha = (elapsed - t0) / (t1 - t0)
            value = lipSyncData[i].value + (lipSyncData[i + 1].value - lipSyncData[i].value) * alpha
          } else {
            value = lipSyncData[i].value
          }
          break
        }
      }

      this.setParameter('ParamMouthOpenY', Math.max(0, Math.min(1, value)))

      if (elapsed < lastTime + 100) {
        this.lipSyncRaf = requestAnimationFrame(updateLip)
      } else {
        this.setParameter('ParamMouthOpenY', 0)
        this.lipSyncRaf = null
      }
    }

    this.lipSyncRaf = requestAnimationFrame(updateLip)
  }
}
