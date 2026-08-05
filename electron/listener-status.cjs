'use strict'

/**
 * Listener 状态摘要（ADR 0001 · F6 · goal 验证 3/4：清晰、可枚举、不假报 running）
 *
 * /health 与 MCP get_status 的 `listener` 字段同源本模块输出。状态枚举：
 *
 *  - disabled           external 模式：不启动进程音频捕获（仅消费 /events）
 *  - starting           瞬时态：监听器尚未完成首轮状态上报
 *  - idle               native 监听在运行，但当前无捕获（无匹配进程 / 等待目标出声）
 *  - running            已附着 Core Audio process tap，正在产出 level
 *  - permission-denied  系统音频录制权限缺失（helper tap 创建失败且 TCC preflight 未授权）
 *  - unavailable        native 路径不可用（helper 缺失 / 平台不支持 / spawn 失败 / OS 过旧）
 *  - error              运行期错误（helper 异常退出、tap 失败但权限正常等）
 *
 * 摘要仅含枚举/计数/截断错误文本，**不含用户内容**（无进程命令行、无音频内容）。
 * 纯函数、无 Electron 依赖：node:test 直测（NFR-3）。
 */

const LISTENER_STATUSES = Object.freeze([
  'disabled',
  'starting',
  'idle',
  'running',
  'permission-denied',
  'unavailable',
  'error',
])

const PERMISSION_REMEDY =
  '系统音频录制权限未授予：请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中允许本应用后重启；' +
  '或改用 external 模式（LIVE2D_VOICE_SOURCE_MODE=external）经 /events 驱动口型。'

const ERROR_MESSAGE_MAX = 160

function truncateError(value) {
  if (typeof value !== 'string' || !value) return null
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > ERROR_MESSAGE_MAX
    ? `${collapsed.slice(0, ERROR_MESSAGE_MAX)}…`
    : collapsed
}

function roundLevel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000
}

/**
 * 构造 listener 摘要。
 * @param {object} args
 * @param {string} args.mode 已规范化的 voice source mode（四模式之一）
 * @param {string} [args.platform] process.platform（注入便于单测）
 * @param {object|null} [args.native] native 监听器最近一次状态负载
 *   （electron/native-process-audio-listener.cjs 的 onStatus 形状；
 *   null = 尚未上报 → starting 瞬时态）
 * @param {number|null} [args.lastLevel] native 最近电平（仅 running 时附带）
 */
function buildListenerSummary({ mode, platform = process.platform, native = null, lastLevel = null }) {
  if (mode === 'external') {
    return {
      mode: 'external',
      status: 'disabled',
      note: 'external 模式：仅消费 /events 注入，不启动进程音频捕获',
    }
  }
  if (platform !== 'darwin') {
    // linux/win listener 属预留（SPEC 决策 2：macOS 优先）
    return { mode, status: 'unavailable', detail: 'platform-not-supported' }
  }
  if (native == null) {
    return { mode, status: 'starting' }
  }
  if (native.capturing === true) {
    const summary = { mode, status: 'running', source: native.source ?? 'macOS process audio' }
    const level = roundLevel(lastLevel)
    if (level !== null) summary.lastLevel = level
    return summary
  }

  const detail = typeof native.detail === 'string' ? native.detail : null
  const error = truncateError(native.error)

  // 权限分类单一权威点：tap 创建失败 + helper TCC preflight 未授权 → permission-denied
  if (detail === 'tap-create-failed' && native.permissionHint === false) {
    return { mode, status: 'permission-denied', detail, remedy: PERMISSION_REMEDY }
  }
  if (
    detail === 'helper-missing' ||
    detail === 'spawn-failed' ||
    detail === 'unsupported-os' ||
    detail === 'platform-not-supported'
  ) {
    const summary = { mode, status: 'unavailable', detail }
    if (error) summary.error = error
    return summary
  }
  if (detail === 'tap-create-failed' || detail === 'helper-exited' || native.error) {
    const summary = { mode, status: 'error' }
    if (detail) summary.detail = detail
    if (error) summary.error = error
    return summary
  }
  // 监听中、未捕获、无失败：idle（区分「无匹配进程」与「已匹配、等待出声」）
  const summary = { mode, status: 'idle' }
  if (detail === 'no-matching-process' || detail === 'waiting-for-audio') summary.detail = detail
  if (Number.isInteger(native.matched) && native.matched > 0) summary.matched = native.matched
  return summary
}

module.exports = {
  LISTENER_STATUSES,
  PERMISSION_REMEDY,
  buildListenerSummary,
}
