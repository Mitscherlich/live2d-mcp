'use strict'

const api = window.live2dSettings
const form = document.querySelector('#voice-form')
const mode = document.querySelector('#mode')
const customFields = document.querySelector('#custom-fields')
const applicationFields = document.querySelector('#application-fields')
const processPattern = document.querySelector('#process-pattern')
const sourceId = document.querySelector('#source-id')
const sourceName = document.querySelector('#source-name')
const message = document.querySelector('#message')
const environmentNotice = document.querySelector('#environment-notice')

function setText(selector, value) {
  document.querySelector(selector).textContent = value ?? ''
}

function updateModeFields() {
  customFields.hidden = mode.value !== 'custom'
  applicationFields.hidden = mode.value !== 'application'
}

function render(view, { preserveForm = false } = {}) {
  setText('#mcp-url', view.mcpUrl)
  setText('#codex-command', view.codexCommand)
  setText('#bridge-status', view.bridgeListening ? 'bridge 正在监听' : 'bridge 尚未监听')
  const listener = view.listener ?? {}
  setText(
    '#listener-status',
    `${view.effectiveVoiceSource?.mode ?? 'unknown'} / ${listener.status ?? 'unknown'}` +
      (listener.detail ? ` (${listener.detail})` : ''),
  )
  environmentNotice.hidden = !view.environmentOverridesVoice
  if (!preserveForm) {
    const source = view.voiceSource ?? { mode: 'automatic' }
    mode.value = source.mode ?? 'automatic'
    processPattern.value = source.process_pattern ?? ''
    sourceId.value = source.source_id ?? ''
    sourceName.value = source.source_name ?? ''
    updateModeFields()
  }
  if (view.message) {
    message.textContent = view.message
    message.dataset.kind = 'success'
  }
}

mode.addEventListener('change', updateModeFields)

document.querySelector('#copy-command').addEventListener('click', async () => {
  const copied = await api.copyCommand()
  message.textContent = copied ? 'codex 命令已复制。' : '复制失败。'
  message.dataset.kind = copied ? 'success' : 'error'
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  message.textContent = '正在保存…'
  message.dataset.kind = ''
  const voiceSource = {
    mode: mode.value,
    process_pattern: mode.value === 'custom' ? processPattern.value : null,
    source_id: mode.value === 'application' ? sourceId.value : null,
    source_name: mode.value === 'application' ? sourceName.value : null,
  }
  const result = await api.save(voiceSource)
  if (!result.ok) {
    message.textContent = result.error || '保存失败。'
    message.dataset.kind = 'error'
    return
  }
  render(result.view)
})

api.onChanged((view) => render(view, { preserveForm: true }))
api.get().then(render).catch((error) => {
  message.textContent = `设置读取失败：${error?.message ?? error}`
  message.dataset.kind = 'error'
})
