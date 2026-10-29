'use strict'

/**
 * Voice listener 编排（ADR 0001 · F6/F7）：voice source 配置解析、
 * native/external listener 生命周期、listener 状态真值摘要。
 *
 * 此前这套逻辑散落在 main.cjs 的模块级变量与四个回调的身份守卫
 * （if (audioListener !== listener) return）里。收进本类后以世代号
 * （generation）吸收陈旧回调：每次 start/stop 递增世代，旧 listener 的
 * 异步回调自然失效。
 *
 * listener 回调产出的是**未规范化** voice 事件草稿，经注入的 onVoiceEvent
 * 交给组合根的权威规范化 + 投递路径（与 bridge /events、测试注入同源）。
 *
 * Electron 依赖（app.isPackaged / process.resourcesPath）由构造注入，
 * node:test 用 fake createAudioListener 即可直测全部路径（NFR-3）。
 */

const { createAudioListener: createDefaultAudioListener } = require('./audio-listener.cjs')
const { buildListenerSummary } = require('./listener-status.cjs')
const {
  DEFAULT_VOICE_SOURCE,
  resolveVoiceSourceConfig,
} = require('./voice-source.cjs')

class VoiceListenerManager {
  /**
   * @param {object} options
   * @param {string} options.platform process.platform
   * @param {boolean} options.isPackaged app.isPackaged
   * @param {string} [options.resourcesPath] process.resourcesPath
   * @param {object} [options.environment] env（默认 process.env）
   * @param {(rawEvent: object) => boolean} options.onVoiceEvent voice 事件投递出口
   * @param {() => void} [options.onStatusChanged] listener 状态变化通知（设置窗热更新用）
   * @param {object} [options.logger] 日志出口（默认 console）
   * @param {Function} [options.createAudioListener] 测试注入用工厂
   * @param {Function} [options.resolveConfig] 测试注入用配置解析
   * @param {object|null} [options.voiceSource] 初始持久化 voice source（默认 automatic）
   */
  constructor({
    platform,
    isPackaged,
    resourcesPath,
    environment = process.env,
    onVoiceEvent,
    onStatusChanged = () => {},
    logger = console,
    createAudioListener = createDefaultAudioListener,
    resolveConfig = resolveVoiceSourceConfig,
    voiceSource = null,
  } = {}) {
    if (typeof onVoiceEvent !== 'function') {
      throw new TypeError('VoiceListenerManager: onVoiceEvent 必填')
    }
    this._platform = platform
    this._isPackaged = isPackaged
    this._resourcesPath = resourcesPath
    this._environment = environment
    this._onVoiceEvent = onVoiceEvent
    this._onStatusChanged = onStatusChanged
    this._logger = logger
    this._createAudioListener = createAudioListener
    this._resolveConfig = resolveConfig

    this._config = this._resolveConfig(environment, voiceSource ?? DEFAULT_VOICE_SOURCE)
    this._listener = null
    this._nativeStatus = null
    this._lastLevel = null
    this._generation = 0
  }

  /** 当前生效的 voice source 配置（source/pattern/warnings/environmentOverridesVoice） */
  get config() {
    return this._config
  }

  /** /health 与 MCP get_status 共用的 listener 真值摘要。 */
  summary() {
    return buildListenerSummary({
      mode: this._config.source.mode,
      platform: this._platform,
      native: this._nativeStatus,
      lastLevel: this._lastLevel,
    })
  }

  /**
   * native listener 契约 → 权威 voice 事件入口。
   * session 开启先进入 active/listening；listening ⇄ speaking 由 renderer 的
   * VoiceStateMachine 从同一条 level 流推导（main 侧不再重复推一遍）。
   * @param {object} [persistedVoiceSource] 提供时先重解析配置（启动/热更新）
   */
  start(persistedVoiceSource) {
    if (persistedVoiceSource !== undefined) {
      this._config = this._resolveConfig(this._environment, persistedVoiceSource)
    }
    for (const warning of this._config.warnings) {
      this._logger.warn(`[live2d] voice source 配置：${warning}`)
    }

    // 世代号：旧 listener 的迟到回调比对世代后自然失效（替代身份守卫）
    const generation = ++this._generation
    const stale = () => generation !== this._generation

    const listener = this._createAudioListener({
      platform: this._platform,
      isPackaged: this._isPackaged,
      resourcesPath: this._resourcesPath,
      environment: this._environment,
      voiceSource: this._config.source,
      processPattern: this._config.pattern,
      onSession: (active) => {
        if (stale()) return
        this._onVoiceEvent({
          type: 'state',
          state: active
            ? { phase: 'active', activity: 'listening' }
            : { phase: 'inactive', activity: 'idle' },
        })
      },
      onLevel: (level) => {
        if (stale()) return
        this._lastLevel = level
        // 调试：仅打印「助手出声」相关的非静音电平（Codex 播放，非用户麦克风）
        if (this._environment.LIVE2D_LISTENER_DEBUG === '1' && level > 0.01) {
          this._logger.log(`[live2d] native assistant level=${level.toFixed(3)}`)
        }
        this._onVoiceEvent({ type: 'audio-level', level })
      },
      onStatus: (status) => {
        if (stale()) return
        this._nativeStatus = status
        const summary = this.summary()
        this._logger.log(
          `[live2d] voice listener: ${summary.mode}/${summary.status}` +
            `${summary.detail ? ` (${summary.detail})` : ''}` +
            `${summary.lastLevel != null ? ` lastLevel=${summary.lastLevel}` : ''}` +
            `${summary.matched != null ? ` matched=${summary.matched}` : ''}`,
        )
        this._onStatusChanged()
      },
      onDebug: (message, detail) => {
        if (this._environment.LIVE2D_LISTENER_DEBUG === '1') {
          this._logger.warn(`[live2d] ${message}: ${String(detail).trim().slice(0, 500)}`)
        }
      },
    })

    this._listener = listener

    if (!listener) {
      const summary = this.summary()
      this._logger.log(
        `[live2d] voice listener: ${summary.mode}/${summary.status}` +
          `${summary.detail ? ` (${summary.detail})` : ''}`,
      )
      return
    }

    void listener.start().catch((error) => {
      if (stale()) return
      this._nativeStatus = {
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
        matched: 0,
        detail: 'startup-failed',
        error: error instanceof Error ? error.message : String(error),
        permissionHint: null,
      }
      this._logger.error(`[live2d] voice listener 启动失败：${this._nativeStatus.error}`)
    })
  }

  stop() {
    this._generation += 1
    const listener = this._listener
    this._listener = null
    listener?.stop()
    this._nativeStatus = null
    this._lastLevel = null
  }

  /** 热更新：停旧 listener → 重解析配置 → 起新 listener */
  applyPersisted(persistedVoiceSource) {
    this.stop()
    this.start(persistedVoiceSource)
  }
}

module.exports = { VoiceListenerManager }
