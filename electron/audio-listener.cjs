'use strict'

/**
 * Audio listener 工厂与计划（ADR 0001 · F6 · SPEC §6.2 FR-V4：external 不启 native）
 *
 * resolveListenerPlan（纯函数，先于任何 spawn 决策）：
 *  - external            → { kind:'external' }     不创建任何监听器/进程
 *  - 非 darwin           → { kind:'unsupported-platform' }（linux/win 预留，决策 2）
 *  - automatic/application/custom + darwin → { kind:'native' }
 *
 * createAudioListener：仅在 plan 为 native 时返回 NativeProcessAudioListener 实例，
 * 其余返回 null。main 据此维护 listener 摘要（listener-status.cjs）。
 */

const { NativeProcessAudioListener } = require('./native-process-audio-listener.cjs')
const { normalizeVoiceSource } = require('./voice-source.cjs')

function resolveListenerPlan({ voiceSource, platform = process.platform } = {}) {
  const mode = normalizeVoiceSource(voiceSource).mode
  if (mode === 'external') return { kind: 'external', mode }
  if (platform !== 'darwin') return { kind: 'unsupported-platform', mode, platform }
  return { kind: 'native', mode, platform }
}

/**
 * @returns {NativeProcessAudioListener|null}
 *   external / 不支持平台 → null（不启任何捕获进程）；darwin 非 external → native 监听器
 */
function createAudioListener({ platform = process.platform, voiceSource, ...options } = {}) {
  const plan = resolveListenerPlan({ voiceSource, platform })
  if (plan.kind !== 'native') return null
  return new NativeProcessAudioListener({ platform, voiceSource, ...options })
}

module.exports = { createAudioListener, resolveListenerPlan }
