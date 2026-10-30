'use strict'

/** 托盘快捷弹窗（DESIGN.md §3.2）。 */

const api = window.live2dSettings
const shared = window.Live2DSettingsShared
const $ = (selector) => document.querySelector(selector)

document.documentElement.dataset.platform = shared.platform()

let view = null
let levelTimer = null

function setTone(dot, tone) {
  dot.className = `dot ${tone}`
}

function showMessage(text, kind = '') {
  const message = $('#message')
  message.textContent = text ?? ''
  message.dataset.kind = kind
}

function render(next) {
  view = next
  setTone($('#bridge-dot'), view.bridgeListening ? 'ok' : 'err')
  $('#bridge-text').textContent = view.bridgeListening ? `bridge ${view.port}` : 'bridge 未监听'
  const listener = shared.listenerState(view.listener)
  setTone($('#listener-dot'), listener.tone)
  $('#listener-text').textContent = listener.text

  $('#permission-bar').hidden = view.permission !== 'denied'

  const visible = Boolean(view.avatar?.visible)
  $('#tile-avatar').classList.toggle('on', visible)
  $('#tile-avatar-text').textContent = visible ? '隐藏角色' : '显示角色'

  const mode = view.voiceSource?.mode ?? 'automatic'
  for (const button of document.querySelectorAll('#mode-seg button')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === mode))
  }
  const sourceName = view.voiceSource?.source_name
  const sourceText = view.environmentOverridesVoice
    ? '环境变量覆盖中'
    : mode === 'application' && sourceName
      ? sourceName
      : listener.detail ?? listener.text
  $('#source-text').textContent = sourceText

  if (document.activeElement !== $('#scale')) {
    const percent = shared.scalePercent(view.avatar?.scale)
    $('#scale').value = String(percent)
    $('#scale-text').textContent = `${percent}%`
  }
}

async function runAction(payload) {
  const result = await api.action(payload)
  if (!result?.ok) showMessage(result?.error ?? '操作失败', 'error')
  return result
}

$('#mode-seg').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-mode]')
  if (!button || !view) return
  const mode = button.dataset.mode
  if (mode === view.voiceSource?.mode) return
  const persisted = view.voiceSource ?? {}
  if (!shared.canQuickSwitch(mode, persisted)) {
    // application/custom 还没填过字段：去完整窗填写
    await runAction({ type: 'open-full', section: 'voice' })
    return
  }
  showMessage('正在应用…')
  const result = await api.save(shared.buildVoiceSource(mode, persisted))
  if (!result?.ok) {
    showMessage(result?.error ?? '保存失败', 'error')
    return
  }
  showMessage('')
  render(result.view)
})

$('#tile-avatar').addEventListener('click', () => {
  void runAction({ type: view?.avatar?.visible ? 'avatar-hide' : 'avatar-show' })
})
$('#tile-reset').addEventListener('click', () => void runAction({ type: 'avatar-reset' }))
$('#tile-copy').addEventListener('click', async () => {
  const copied = await api.copyCommand('codex')
  const label = $('#tile-copy-text')
  label.textContent = copied ? '已复制' : '复制失败'
  setTimeout(() => {
    label.textContent = '复制 MCP'
  }, 1400)
})
$('#tile-copy').title = 'codex mcp add live2d --url …'

$('#scale').addEventListener('input', () => {
  $('#scale-text').textContent = `${$('#scale').value}%`
})
$('#scale').addEventListener('change', () => {
  void runAction({ type: 'set-scale', scale: Number($('#scale').value) / 100 })
})

$('#grant').addEventListener('click', () => void runAction({ type: 'open-permission-settings' }))
$('#open-full').addEventListener('click', () => void runAction({ type: 'open-full' }))
$('#quit').addEventListener('click', () => void runAction({ type: 'quit' }))

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void api.action({ type: 'close-popover' })
  if ((event.metaKey || event.ctrlKey) && event.key === ',') void api.action({ type: 'open-full' })
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'q') void api.action({ type: 'quit' })
})

// 电平：最近一次推送 300ms 后归零（静音时 main 不会再推）
api.onLevel((level) => {
  $('#level').style.width = `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`
  clearTimeout(levelTimer)
  levelTimer = setTimeout(() => {
    $('#level').style.width = '0%'
  }, 300)
})

// 窗口高度跟随内容
let lastHeight = 0
new ResizeObserver(() => {
  const height = Math.ceil($('#pop').getBoundingClientRect().height)
  if (height === lastHeight) return
  lastHeight = height
  void api.action({ type: 'fit-popover', height })
}).observe($('#pop'))

api.onChanged((next) => {
  if (next?.message) showMessage(next.message, 'success')
  render(next)
})
api.get().then(render).catch((error) => {
  showMessage(`设置读取失败：${error?.message ?? error}`, 'error')
})
