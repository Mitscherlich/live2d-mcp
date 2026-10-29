/**
 * ADR 0001 · F5：main → renderer 命令通道（MCP 视觉工具执行路径）。
 *
 * main（Electron 一体化 MCP 工具回调）经 preload onCommand 下发白名单命令
 * （getModelInfo / setExpression / playMotion / lookAt / setParameter / reset），
 * 此处映射到 Live2DApp；无模型时返回 ok:false 清晰降级（不崩溃），
 * MCP 工具层转为 isError。调试快照 __live2dCommandDebug 供
 * scripts/f5-mcp-proof.mjs 经 CDP 断言命令真实到达 renderer（字段逐字保持）。
 *
 * 本模块零运行时 import（model-config.ts 为纯常量/纯函数；其余仅 type import），
 * node:test 可经 type-stripping 直载（见 renderer/test/command-dispatcher.test.ts）。
 */

import { motionTag } from './model-config.ts'
import type { Live2DApp } from './live2d-app.js'
import type { Live2dApi, Live2dCommandRequest, Live2dCommandResult } from './live2d-bridge.js'
import type { StatusBar } from './status-bar.js'

const MODEL_MISSING =
  'Live2D 模型未加载（Cubism Core 或模型资源缺失，见窗口内引导）；命令未执行'

/** StatusBar 在本模块用到的写入面（测试可用假对象满足） */
export type CommandStatusSink = Pick<StatusBar, 'noteExpression' | 'noteMotion' | 'resetExpressionMotion'>

export class CommandDispatcher {
  private readonly counts: Record<string, number> = {}
  private lastCommand: string | null = null
  private lastError: string | null = null
  private readonly off: () => void
  // 字段逐个赋值而非参数属性：parameter property 是运行时语法，
  // Node type-stripping 直载不支持。
  private readonly app: Live2DApp | null
  private readonly statusBar: CommandStatusSink

  constructor(app: Live2DApp | null, api: Live2dApi, statusBar: CommandStatusSink) {
    this.app = app
    this.statusBar = statusBar
    this.off = api.onCommand((command) => this.handle(command))

    window.__live2dCommandDebug = {
      snapshot: () => ({
        counts: { ...this.counts },
        lastCommand: this.lastCommand,
        lastError: this.lastError,
        modelLoaded: app?.isLoaded() ?? false,
        channelAttached: Boolean(this.off),
      }),
    }
    console.log('[Command] main→renderer 命令通道已挂接（MCP 视觉工具可执行）')
  }

  dispose(): void {
    this.off()
  }

  private handle({ type, params }: Live2dCommandRequest): Live2dCommandResult {
    this.counts[type] = (this.counts[type] ?? 0) + 1
    this.lastCommand = type

    if (type === 'getModelInfo') {
      if (!this.isModelLoaded()) return this.modelMissing()
      return { ok: true, data: this.app!.getModelInfo() }
    }

    if (!this.isModelLoaded()) return this.modelMissing()
    const live2d = this.app!

    switch (type) {
      case 'setExpression':
        return this.setExpression(live2d, params)
      case 'playMotion':
        return this.playMotion(live2d, params)
      case 'lookAt':
        return this.lookAt(live2d, params)
      case 'setParameter':
        return this.setParameter(live2d, params)
      case 'reset':
        return this.reset(live2d)
      default:
        return { ok: false, error: `未知命令: ${type}` }
    }
  }

  private isModelLoaded(): boolean {
    return Boolean(this.app && this.app.isLoaded())
  }

  private modelMissing(): Live2dCommandResult {
    this.lastError = MODEL_MISSING
    return { ok: false, error: MODEL_MISSING }
  }

  private setExpression(app: Live2DApp, params: Record<string, unknown>): Live2dCommandResult {
    const expression = typeof params.expression === 'string' ? params.expression : ''
    const ok = expression !== '' && app.setExpression(expression)
    if (ok) {
      this.statusBar.noteExpression(expression)
      return { ok: true, data: { expression } }
    }
    this.lastError = `表情 "${expression}" 不存在或不可用`
    return { ok: false, error: `${this.lastError}（用 get_model_info 查询可用表情）` }
  }

  private playMotion(app: Live2DApp, params: Record<string, unknown>): Live2dCommandResult {
    const group = typeof params.group === 'string' ? params.group : ''
    const index = typeof params.index === 'number' ? Math.trunc(params.index) : -1
    const priority = typeof params.priority === 'number' ? Math.trunc(params.priority) : 2
    const ok = group !== '' && app.playMotion(group, index, priority)
    if (ok) {
      this.statusBar.noteMotion(motionTag(group, index >= 0 ? index : undefined))
      return { ok: true, data: { group, index, priority } }
    }
    this.lastError = `动作分组 "${group}" 不存在或不可用`
    return { ok: false, error: `${this.lastError}（用 get_model_info 查询可用分组）` }
  }

  private lookAt(app: Live2DApp, params: Record<string, unknown>): Live2dCommandResult {
    const x = typeof params.x === 'number' ? params.x : 0
    const y = typeof params.y === 'number' ? params.y : 0
    const ok = app.lookAt(x, y)
    return ok ? { ok: true, data: { x, y } } : { ok: false, error: 'lookAt 执行失败' }
  }

  private setParameter(app: Live2DApp, params: Record<string, unknown>): Live2dCommandResult {
    const paramId = typeof params.param_id === 'string' ? params.param_id : ''
    const value = typeof params.value === 'number' ? params.value : Number.NaN
    const ok = paramId !== '' && Number.isFinite(value) && app.setParameter(paramId, value)
    return ok
      ? { ok: true, data: { param_id: paramId, value } }
      : { ok: false, error: `参数 "${paramId}" 写入失败` }
  }

  private reset(app: Live2DApp): Live2dCommandResult {
    const ok = app.reset()
    if (ok) this.statusBar.resetExpressionMotion()
    return ok ? { ok: true } : { ok: false, error: 'reset 执行失败' }
  }
}
