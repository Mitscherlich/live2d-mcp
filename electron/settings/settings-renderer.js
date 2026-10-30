'use strict'

/** 完整设置窗（DESIGN.md §3.3）：状态条 + 锚点目录 + 单页长滚动。 */

const api = window.live2dSettings
const shared = window.Live2DSettingsShared
const $ = (selector) => document.querySelector(selector)

document.documentElement.dataset.platform = shared.platform()

const METER_BARS = 48
const LOG_LIMIT = 6

let view = null
let selectedMode = 'automatic'
let formDirty = false
let cliKind = 'codex'
let lastListenerKey = null
const levels = new Array(METER_BARS).fill(0)
const meterBars = []
let pendingLevel = null
let levelTimer = null

// ---------------------------------------------------------------- 工具

function setLed(el, tone) {
  el.className = `led ${tone}`
}

function showMessage(text, kind = '') {
  const message = $('#message')
  message.textContent = text ?? ''
  message.dataset.kind = kind
}

function clock() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function appendLog(tone, text) {
  const line = document.createElement('div')
  const time = document.createElement('span')
  time.className = 't'
  time.textContent = clock()
  const body = document.createElement('span')
  body.className = tone
  body.textContent = ` ${text}`
  line.append(time, body)
  const log = $('#log')
  log.prepend(line)
  while (log.children.length > LOG_LIMIT) log.lastElementChild.remove()
}

async function runAction(payload) {
  const result = await api.action(payload)
  if (!result?.ok) showMessage(result?.error ?? '操作失败', 'error')
  return result
}

// ---------------------------------------------------------------- 渲染

function selectMode(mode) {
  selectedMode = mode
  for (const button of document.querySelectorAll('#modes .mode')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === mode))
  }
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== mode
}

function fillForm(source) {
  selectMode(source?.mode ?? 'automatic')
  $('#process-pattern').value = source?.process_pattern ?? ''
  $('#source-id').value = source?.source_id ?? ''
  $('#source-name').value = source?.source_name ?? ''
  formDirty = false
}

function renderStatus() {
  setLed($('#bridge-led'), view.bridgeListening ? 'ok' : 'err')
  $('#bridge-text').textContent = view.bridgeListening ? '监听中' : '未监听'
  $('#bridge-sub').textContent = `127.0.0.1:${view.port} · loopback`

  const listener = shared.listenerState(view.listener)
  setLed($('#listener-led'), listener.tone)
  $('#listener-text').textContent = listener.text
  const effective = view.effectiveVoiceSource ?? view.voiceSource ?? {}
  const target = effective.mode === 'application' && effective.source_name ? ` → ${effective.source_name}` : ''
  $('#listener-sub').textContent = `${effective.mode ?? '—'}${target}${listener.detail ? ` · ${listener.detail}` : ''}`

  const permission = shared.permissionState(view.permission)
  setLed($('#permission-led'), permission.tone)
  $('#permission-text').textContent = permission.text
  $('#grant').hidden = view.permission !== 'denied'

  // listener 状态变化写入会话日志
  const key = `${view.listener?.mode}/${view.listener?.status}/${view.listener?.detail ?? ''}`
  if (key !== lastListenerKey) {
    lastListenerKey = key
    appendLog(listener.tone === 'ok' ? 'ok' : listener.tone === 'off' ? '' : listener.tone,
      `listener ${view.listener?.mode ?? '—'} / ${view.listener?.status ?? 'unknown'}` +
        (view.listener?.detail ? ` (${view.listener.detail})` : ''))
  }
}

function renderMcp() {
  const commands = { codex: view.codexCommand, claude: view.claudeCommand, url: view.mcpUrl }
  $('#cmd').textContent = commands[cliKind]
  $('#cmd-prefix').textContent = cliKind === 'url' ? '↳' : '$'
  const fromEnv = view.bridgeListening ? '' : '（bridge 未监听，按 LIVE2D_BRIDGE_PORT / 默认值展示）'
  $('#port-text').textContent = `${view.port}${fromEnv}`
  $('#events-url').textContent = `POST http://127.0.0.1:${view.port}/events`
}

function renderAvatar() {
  const avatar = view.avatar ?? {}
  if (document.activeElement !== $('#scale')) {
    const percent = shared.scalePercent(avatar.scale)
    $('#scale').value = String(percent)
    $('#scale-text').textContent = `${percent}%`
  }
  const position = Number.isFinite(avatar.x) && Number.isFinite(avatar.y) ? `x=${avatar.x} y=${avatar.y} · ` : ''
  $('#bounds-text').textContent = `${position}${avatar.width ?? '—'}×${avatar.height ?? '—'}${avatar.visible ? '' : ' · 已隐藏'}`
  $('#avatar-toggle').textContent = avatar.visible ? '隐藏' : '显示'
}

function renderGeneral() {
  const loginItem = view.loginItem ?? { supported: false }
  $('#login-row').hidden = !loginItem.supported
  $('#login-unsupported').hidden = Boolean(loginItem.supported)
  $('#login-item').checked = Boolean(loginItem.openAtLogin)
}

function renderDiag() {
  $('#settings-path').textContent = view.settingsFilePath ?? '—'
  const versions = view.versions ?? {}
  $('#runtime-text').textContent = `Electron ${versions.electron ?? '—'} · Cubism 5 · PixiJS v8`
  $('#versions').textContent = versions.app ? `v${versions.app}` : ''
}

function render(next, { preserveForm = false } = {}) {
  if (next?.focusSection) scrollToSection(next.focusSection)
  view = next
  renderStatus()
  renderMcp()
  renderAvatar()
  renderGeneral()
  renderDiag()
  $('#env-notice').hidden = !view.environmentOverridesVoice
  $('#env-flag').hidden = !view.environmentOverridesVoice
  $('#level-mode').textContent = view.voiceSource?.mode ?? '—'
  if (!preserveForm || !formDirty) fillForm(view.voiceSource)
  if (view.message) showMessage(view.message, 'success')
}

// ---------------------------------------------------------------- 目录

const content = $('#content')
const tocLinks = [...document.querySelectorAll('#toc a')]

function scrollToSection(id) {
  const section = document.getElementById(id)
  if (section) section.scrollIntoView({ block: 'start' })
}

for (const link of tocLinks) {
  link.addEventListener('click', (event) => {
    event.preventDefault()
    scrollToSection(link.getAttribute('href').slice(1))
  })
}
content.addEventListener('scroll', () => {
  let current = tocLinks[0]
  for (const link of tocLinks) {
    const section = document.getElementById(link.getAttribute('href').slice(1))
    if (section.offsetTop - content.offsetTop - 40 <= content.scrollTop) current = link
  }
  for (const link of tocLinks) link.classList.toggle('on', link === current)
})

// ---------------------------------------------------------------- 口型来源

$('#modes').addEventListener('click', (event) => {
  const button = event.target.closest('.mode')
  if (!button) return
  selectMode(button.dataset.mode)
  formDirty = true
})
for (const input of document.querySelectorAll('#voice-form input')) {
  input.addEventListener('input', () => {
    formDirty = true
  })
}
$('#revert').addEventListener('click', () => {
  if (view) fillForm(view.voiceSource)
  showMessage('已还原为当前保存的设置')
})
$('#voice-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  showMessage('正在保存…')
  const result = await api.save(
    shared.buildVoiceSource(selectedMode, {
      process_pattern: $('#process-pattern').value,
      source_id: $('#source-id').value,
      source_name: $('#source-name').value,
    }),
  )
  if (!result?.ok) {
    showMessage(result?.error || '保存失败', 'error')
    return
  }
  formDirty = false
  appendLog('ok', `saved mode=${selectedMode} · listener restarted`)
  render(result.view)
})

// 电平图：推送值进滚动缓冲；静音（无推送）时逐帧衰减
const meter = $('#meter')
for (let i = 0; i < METER_BARS; i += 1) meterBars.push(meter.appendChild(document.createElement('i')))

function drawMeter() {
  levels.shift()
  levels.push(pendingLevel ?? levels[levels.length - 1] * 0.6)
  pendingLevel = null
  meterBars.forEach((bar, index) => {
    bar.style.height = `${Math.max(2, Math.round(levels[index] * 100))}%`
  })
  $('#level-value').textContent = levels[levels.length - 1].toFixed(2)
}
api.onLevel((level) => {
  pendingLevel = Math.min(1, Math.max(0, Number(level) || 0))
  if (!levelTimer) {
    levelTimer = setInterval(() => {
      drawMeter()
      if (levels.every((value) => value < 0.005)) {
        clearInterval(levelTimer)
        levelTimer = null
      }
    }, 60)
  }
})

// ---------------------------------------------------------------- MCP

$('#cli-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('button[data-kind]')
  if (!tab) return
  cliKind = tab.dataset.kind
  for (const button of document.querySelectorAll('#cli-tabs button')) {
    button.setAttribute('aria-selected', String(button === tab))
  }
  if (view) renderMcp()
})
$('#copy').addEventListener('click', async () => {
  const copied = await api.copyCommand(cliKind)
  $('#copy').textContent = copied ? '已复制' : '失败'
  setTimeout(() => {
    $('#copy').textContent = '复制'
  }, 1400)
})

// ---------------------------------------------------------------- 角色窗 / 通用 / 诊断

$('#scale').addEventListener('input', () => {
  $('#scale-text').textContent = `${$('#scale').value}%`
})
$('#scale').addEventListener('change', () => {
  void runAction({ type: 'set-scale', scale: Number($('#scale').value) / 100 })
})
$('#avatar-toggle').addEventListener('click', () => {
  void runAction({ type: view?.avatar?.visible ? 'avatar-hide' : 'avatar-show' })
})
$('#avatar-reset').addEventListener('click', () => void runAction({ type: 'avatar-reset' }))
$('#login-item').addEventListener('change', async () => {
  const result = await runAction({ type: 'set-login-item', enabled: $('#login-item').checked })
  if (!result?.ok && view) $('#login-item').checked = Boolean(view.loginItem?.openAtLogin)
})
$('#grant').addEventListener('click', () => void runAction({ type: 'open-permission-settings' }))
$('#reveal').addEventListener('click', () => void runAction({ type: 'reveal-settings-file' }))

// ---------------------------------------------------------------- 启动

api.onChanged((next) => render(next, { preserveForm: true }))
api
  .get()
  .then((initial) => {
    render(initial)
    const section = new URLSearchParams(location.search).get('section')
    if (section) scrollToSection(section)
  })
  .catch((error) => {
    showMessage(`设置读取失败：${error?.message ?? error}`, 'error')
  })
