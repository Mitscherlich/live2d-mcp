'use strict'

/** Full settings window: persistent status strip, anchored navigation and one scrolling page. */

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

// ---------------------------------------------------------------- Utilities

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

// ---------------------------------------------------------------- Rendering

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

  // Keep listener state changes in the session log.
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
  renderLibrary()
  $('#env-notice').hidden = !view.environmentOverridesVoice
  $('#env-flag').hidden = !view.environmentOverridesVoice
  $('#level-mode').textContent = view.voiceSource?.mode ?? '—'
  if (!preserveForm || !formDirty) fillForm(view.voiceSource)
  if (view.message) showMessage(view.message, 'success')
}

// ---------------------------------------------------------------- Anchored navigation

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
  for (const link of tocLinks) {
    link.classList.toggle('on', link === current)
    if (link === current) link.setAttribute('aria-current', 'location')
    else link.removeAttribute('aria-current')
  }
})

// ---------------------------------------------------------------- Voice source

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

// Push levels into a rolling buffer and decay each frame when no level arrives.
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

// ---------------------------------------------------------------- Avatar / general / diagnostics

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

// ---------------------------------------------------------------- Model library / Core

let selectedModelId = null

function formatBytes(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function renderLibrary() {
  const lib = view.library
  $('#core-warning').hidden = lib.readiness.core
  $('#core-text').textContent = lib.core.installed ? `已安装 · ${formatBytes(lib.core.bytes ?? 0)}` : '未安装'
  $('#core-import').textContent = lib.core.installed ? '替换…' : '上传…'
  $('#core-status').classList.toggle('installed', lib.core.installed)
  setLed($('#core-led'), lib.core.installed ? 'ok' : 'off')
  const root = (lib.root ?? '~/.mayuka').replace(/[\\/]+$/, '')
  const separator = root.includes('\\') ? '\\' : '/'
  $('#models-path').textContent = `${root}${separator}models`
  $('#models-path').title = $('#models-path').textContent
  $('#core-path').textContent = lib.core.path ?? `${root}${separator}core${separator}live2dcubismcore.min.js`
  $('#core-path').title = $('#core-path').textContent
  $('#model-count').textContent = `${lib.models.length} 个模型`
  $('#model-empty').hidden = lib.models.length > 0
  const grid = $('#model-grid')
  grid.replaceChildren()
  for (const model of lib.models) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'model-card'
    card.dataset.modelId = model.id
    card.setAttribute('aria-current', String(model.id === lib.activeId))
    card.setAttribute('aria-pressed', String(model.id === selectedModelId))
    const thumb = document.createElement('div')
    thumb.className = 'thumb'
    if (model.thumb) thumb.style.backgroundImage = `url(${model.thumb})`
    else {
      thumb.textContent = thumbFailed.has(model.id) ? '⚠' : '◌'
      thumb.title = thumbFailed.get(model.id) ?? (view.library.readiness.core ? '正在生成预览图…' : '需要先安装 Cubism Core')
    }
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = model.name
    const caption = document.createElement('div')
    caption.className = 'model-caption'
    caption.append(name)
    if (model.id === lib.activeId) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = '当前'
      caption.append(badge)
    }
    card.append(thumb, caption)
    card.addEventListener('click', () => openDrawer(model.id))
    card.addEventListener('dblclick', () => void runAction({ type: 'model-preview', id: model.id }))
    grid.append(card)
  }
  if (selectedModelId && !lib.models.some((m) => m.id === selectedModelId)) closeDrawer()
  else if (selectedModelId) fillDrawer()
  pumpCaptures()
}

function selectedModel() {
  return view?.library.models.find((m) => m.id === selectedModelId) ?? null
}

function fillDrawer() {
  const model = selectedModel()
  if (!model) return
  $('#drawer-name').textContent = model.name
  $('#drawer-preview-open').disabled = !view.library.readiness.core
  $('#drawer-meta').textContent = `${formatBytes(model.bytes)} · ${model.motions.length} 动作 · ${model.expressions.length} 表情 · ${model.parts.length} 部件`
  const active = model.id === view.library.activeId
  $('#drawer-activate').disabled = active || !view.library.readiness.core
  $('#drawer-activate').textContent = active ? '当前模型' : '设为当前'
  $('#drawer-remove').disabled = active
}

// Previews live in their own window (model-preview.html). The settings page only owns a hidden,
// one-at-a-time capture frame that renders a still for cards that have no thumbnail yet.
const PREVIEW_ORIGIN = new URLSearchParams(location.search).get('previewOrigin')
const thumbFailed = new Map() // id -> reason
let capture = null // { id, frame, timer }

function finishCapture(reason) {
  if (!capture) return
  const { id, frame, timer } = capture
  clearTimeout(timer)
  try {
    frame.contentWindow?.postMessage({ type: 'destroy' }, PREVIEW_ORIGIN)
  } catch { /* frame already gone */ }
  frame.remove()
  capture = null
  if (reason) {
    thumbFailed.set(id, reason)
    if (view) renderLibrary()
  }
  pumpCaptures()
}

function pumpCaptures() {
  if (capture || !PREVIEW_ORIGIN || !view?.library.readiness.core) return
  const next = view.library.models.find((m) => !m.thumb && !thumbFailed.has(m.id))
  if (!next) return
  const frame = document.createElement('iframe')
  frame.className = 'capture-frame'
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.src = `${PREVIEW_ORIGIN}/preview.html`
  document.body.append(frame)
  capture = { id: next.id, frame, timer: setTimeout(() => finishCapture('预览超时'), 30000) }
}

window.addEventListener('message', async (event) => {
  if (!capture || event.source !== capture.frame.contentWindow || event.origin !== PREVIEW_ORIGIN) return
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  const { id } = capture
  if (msg.type === 'ready') {
    capture.frame.contentWindow.postMessage({ type: 'load', id }, PREVIEW_ORIGIN)
  } else if (msg.type === 'loaded' && msg.id === id) {
    // Give the ticker a couple of frames to draw before grabbing it.
    setTimeout(() => capture?.id === id && capture.frame.contentWindow?.postMessage({ type: 'snapshot', id }, PREVIEW_ORIGIN), 500)
  } else if (msg.type === 'snapshot' && msg.id === id) {
    if (msg.ok && msg.png instanceof ArrayBuffer) {
      const result = await api.saveThumbnail(id, msg.png)
      finishCapture(result?.ok ? null : '缩略图保存失败')
    } else {
      finishCapture('截图失败')
    }
  } else if (msg.type === 'error') {
    finishCapture(String(msg.error).slice(0, 60))
  }
})

function openDrawer(id) {
  selectedModelId = id
  $('#model-drawer').hidden = false
  updateModelSelection()
  fillDrawer()
}

function closeDrawer() {
  selectedModelId = null
  $('#model-drawer').hidden = true
  updateModelSelection()
}

function updateModelSelection() {
  for (const card of document.querySelectorAll('#model-grid .model-card')) {
    card.setAttribute('aria-pressed', String(card.dataset.modelId === selectedModelId))
  }
}
window.addEventListener('pagehide', () => finishCapture(null))

$('#drawer-preview-open').addEventListener('click', () => {
  if (selectedModelId) void runAction({ type: 'model-preview', id: selectedModelId })
})
$('#drawer-close').addEventListener('click', closeDrawer)
$('#drawer-activate').addEventListener('click', async () => {
  if (!selectedModelId) return
  $('#drawer-activate').disabled = true
  const result = await runAction({ type: 'model-activate', id: selectedModelId })
  if (result?.ok) $('#import-message').textContent = '已切换角色'
  else $('#drawer-activate').disabled = false
})
$('#drawer-remove').addEventListener('click', async () => {
  const model = selectedModel()
  if (!model || !confirm(`删除「${model.name}」？此操作不可恢复。`)) return
  await runAction({ type: 'model-remove', id: model.id })
})
$('#models-reveal').addEventListener('click', () => void runAction({ type: 'reveal-models-dir' }))
$('#core-reveal').addEventListener('click', () => void runAction({ type: 'reveal-core' }))
$('#core-warning-go').addEventListener('click', () => scrollToSection('general'))

async function importModelFile(file) {
  const progress = $('#import-progress')
  progress.hidden = false
  progress.textContent = '准备导入…'
  $('#import-message').textContent = ''
  const result = await api.importModel(file)
  progress.hidden = true
  $('#import-message').textContent = result?.ok ? '导入完成' : `导入失败：${result?.error ?? '未知错误'}`
}

const dropzone = $('#dropzone')
$('#model-pick').addEventListener('click', () => $('#model-file').click())
dropzone.addEventListener('click', (event) => {
  event.preventDefault()
  $('#model-file').click()
})
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    $('#model-file').click()
  }
})
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault()
  dropzone.classList.add('over')
})
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'))
dropzone.addEventListener('drop', (event) => {
  event.preventDefault()
  dropzone.classList.remove('over')
  const file = event.dataTransfer?.files?.[0]
  if (file) void importModelFile(file)
})
$('#model-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) void importModelFile(file)
})
api.onModelProgress((p) => {
  $('#import-progress').textContent = `${p?.label ?? '导入中'} (${p?.step ?? '?'}/${p?.total ?? '?'})`
})

$('#core-import').addEventListener('click', () => $('#core-file').click())
$('#core-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  $('#core-message').textContent = '正在导入…'
  const result = await api.importCore(file)
  $('#core-message').textContent = result?.ok ? 'Cubism Core 已安装' : `导入失败：${result?.error ?? '未知错误'}`
})

// ---------------------------------------------------------------- Startup

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
