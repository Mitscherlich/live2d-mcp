'use strict'

/**
 * 音频活动门（ADR 0001 · F6 · ARCHITECTURE §4.1 listener 契约的 onActivity）
 *
 * 把 listener 的原始电平流转换为 activity 转移（listening ⇄ speaking）：
 *  - level 超过 speechThreshold（默认 0.018）→ speaking
 *  - speaking 期间无声，speechReleaseMs（默认 900ms，SPEC §5.4 短静音保持）后
 *    回落 listening（会话仍在）并补发 level 0
 *  - 所有输出先 clamp 到 [0,1]
 *
 * renderer（F3 voice-state.ts）自身也能从纯电平推导 activity（G2 证据口径）；
 * main 侧 gate 提供契约等价的显式 activity 事件，两条推导互不冲突
 * （同阈值同释放时长，序列上幂等）。思路对齐 persona audio-activity-gate（MIT）。
 *
 * 纯逻辑、无 Electron 依赖：node:test 直测（NFR-3）。
 */

const DEFAULT_SPEECH_RELEASE_MS = 900
const DEFAULT_SPEECH_THRESHOLD = 0.018

class AudioActivityGate {
  constructor({
    onActivity = () => {},
    onLevel = () => {},
    shouldReturnToListening = () => true,
    speechReleaseMs = DEFAULT_SPEECH_RELEASE_MS,
    speechThreshold = DEFAULT_SPEECH_THRESHOLD,
  } = {}) {
    this.onActivity = onActivity
    this.onLevel = onLevel
    this.shouldReturnToListening = shouldReturnToListening
    this.speechReleaseMs = speechReleaseMs
    this.speechThreshold = speechThreshold
    this.silenceTimer = null
    this.speaking = false
  }

  handleLevel(level) {
    const normalized = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0
    this.onLevel(normalized)
    if (normalized > this.speechThreshold) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
      if (!this.speaking) {
        this.speaking = true
        this.onActivity('speaking')
      }
      return
    }
    if (this.speaking && this.silenceTimer == null) {
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null
        this.speaking = false
        this.onLevel(0)
        if (this.shouldReturnToListening()) this.onActivity('listening')
      }, this.speechReleaseMs)
      this.silenceTimer.unref?.()
    }
  }

  reset({ emitLevel = true } = {}) {
    clearTimeout(this.silenceTimer)
    this.silenceTimer = null
    this.speaking = false
    if (emitLevel) this.onLevel(0)
  }
}

module.exports = {
  AudioActivityGate,
  DEFAULT_SPEECH_RELEASE_MS,
  DEFAULT_SPEECH_THRESHOLD,
}
