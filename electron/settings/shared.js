'use strict'

/**
 * 快捷弹窗与完整设置窗共用的文案与格式化（DESIGN.md §5.3）。
 * 经 <script src> 先于页面脚本加载，挂到 window.Live2DSettingsShared。
 */
;(function () {
  const LISTENER_STATES = {
    running: { tone: 'ok', text: '正在捕获' },
    idle: { tone: 'ok', text: '等待声音' },
    starting: { tone: 'warn', text: '启动中' },
    disabled: { tone: 'off', text: '仅外部事件' },
    'permission-denied': { tone: 'warn', text: '需要授权' },
    unavailable: { tone: 'err', text: '不可用' },
    error: { tone: 'err', text: '出错' },
  }

  const DETAIL_TEXT = {
    'no-matching-process': '未找到目标进程',
    'waiting-for-audio': '已匹配，等待出声',
    'helper-missing': '缺少原生 helper',
    'spawn-failed': 'helper 启动失败',
    'unsupported-os': '系统版本过旧',
    'platform-not-supported': '当前平台不支持',
    'tap-create-failed': '音频 tap 创建失败',
    'helper-exited': 'helper 异常退出',
    'startup-failed': '启动失败',
  }

  const PERMISSION_STATES = {
    granted: { tone: 'ok', text: '已授权' },
    denied: { tone: 'warn', text: '需要授权' },
    'not-required': { tone: 'off', text: '不需要' },
    unknown: { tone: 'off', text: '待检测' },
  }

  const MODES = ['automatic', 'application', 'custom', 'external']

  function listenerState(listener) {
    const base = LISTENER_STATES[listener?.status] ?? { tone: 'off', text: '未知' }
    const detail = listener?.detail ? DETAIL_TEXT[listener.detail] ?? listener.detail : null
    if (listener?.status === 'idle' && listener.detail === 'no-matching-process') {
      return { tone: 'warn', text: '未找到目标进程', detail: null }
    }
    return { ...base, detail }
  }

  function permissionState(permission) {
    return PERMISSION_STATES[permission] ?? PERMISSION_STATES.unknown
  }

  function scalePercent(scale) {
    return Math.round((typeof scale === 'number' ? scale : 1) * 100)
  }

  /** 由模式与表单值拼 voiceSource（只带该模式需要的字段，其余置 null） */
  function buildVoiceSource(mode, fields = {}) {
    return {
      mode,
      process_pattern: mode === 'custom' ? fields.process_pattern ?? '' : null,
      source_id: mode === 'application' ? fields.source_id ?? '' : null,
      source_name: mode === 'application' ? fields.source_name ?? '' : null,
    }
  }

  /** 弹窗切模式时能否直接保存（application/custom 需要已有字段） */
  function canQuickSwitch(mode, persisted) {
    if (mode === 'automatic' || mode === 'external') return true
    if (mode === 'custom') return Boolean(persisted?.process_pattern)
    if (mode === 'application') return Boolean(persisted?.source_id && persisted?.source_name)
    return false
  }

  function platform() {
    return new URLSearchParams(location.search).get('platform') ?? ''
  }

  window.Live2DSettingsShared = {
    MODES,
    buildVoiceSource,
    canQuickSwitch,
    listenerState,
    permissionState,
    platform,
    scalePercent,
  }
})()
