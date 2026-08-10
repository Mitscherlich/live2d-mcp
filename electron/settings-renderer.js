'use strict'

const api = window.live2dSettings
const form = document.querySelector('#voice-form')
const mode = document.querySelector('#mode')
const customFields = document.querySelector('#custom-fields')
const applicationFields = document.querySelector('#application-fields')
const processPattern = document.querySelector('#process-pattern')
const sourcePicker = document.querySelector('#source-picker')
const refreshSourcesBtn = document.querySelector('#refresh-sources')
const sourcesNote = document.querySelector('#sources-note')
const sourceId = document.querySelector('#source-id')
const sourceName = document.querySelector('#source-name')
const message = document.querySelector('#message')
const environmentNotice = document.querySelector('#environment-notice')

/** @type {{ source_id: string, source_name: string, pidCount?: number }[]} */
let cachedSources = []
let sourcesLoading = false

function setText(selector, value) {
  document.querySelector(selector).textContent = value ?? ''
}

function updateModeFields() {
  customFields.hidden = mode.value !== 'custom'
  applicationFields.hidden = mode.value !== 'application'
  if (mode.value === 'application') {
    void refreshSources()
  }
}

function setSourcesNote(text) {
  if (sourcesNote) sourcesNote.textContent = text
}

function renderSourcePicker(selectedId) {
  const previous = selectedId ?? sourceId.value ?? ''
  sourcePicker.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent =
    cachedSources.length === 0 ? '— 无可用应用（可手填或刷新）—' : '— 请选择运行中的应用 —'
  sourcePicker.appendChild(placeholder)

  for (const item of cachedSources) {
    const option = document.createElement('option')
    option.value = item.source_id
    const count = Number(item.pidCount) > 1 ? ` (${item.pidCount})` : ''
    option.textContent = `${item.source_name}${count}`
    option.dataset.sourceName = item.source_name
    sourcePicker.appendChild(option)
  }

  if (previous && cachedSources.some((item) => item.source_id === previous)) {
    sourcePicker.value = previous
  } else {
    sourcePicker.value = ''
  }
}

async function refreshSources() {
  if (sourcesLoading || typeof api.listSources !== 'function') {
    if (typeof api.listSources !== 'function') {
      setSourcesNote('当前构建未提供应用列表 API，请手填 source_id / source_name。')
    }
    return
  }
  sourcesLoading = true
  refreshSourcesBtn.disabled = true
  setSourcesNote('正在枚举运行中的应用…')
  try {
    const result = await api.listSources()
    const sources = Array.isArray(result?.sources) ? result.sources : []
    cachedSources = sources.filter(
      (item) =>
        item &&
        typeof item.source_id === 'string' &&
        typeof item.source_name === 'string' &&
        item.source_id &&
        item.source_name,
    )
    renderSourcePicker(sourceId.value)
    if (result?.ok === false) {
      setSourcesNote(result.error || result.note || '进程发现失败；可手填兜底。')
    } else if (result?.note) {
      setSourcesNote(result.note)
    } else if (cachedSources.length === 0) {
      setSourcesNote('未发现可选项；可手填 source_id / source_name，或稍后刷新。')
    } else {
      setSourcesNote(
        `已加载 ${cachedSources.length} 个应用。选择后自动填入下方字段；也可手填作为兜底。`,
      )
    }
  } catch (error) {
    cachedSources = []
    renderSourcePicker()
    setSourcesNote(`枚举失败：${error?.message ?? error}；可手填兜底。`)
  } finally {
    sourcesLoading = false
    refreshSourcesBtn.disabled = false
  }
}

function applyPickerSelection() {
  const selected = sourcePicker.value
  if (!selected) return
  const item = cachedSources.find((entry) => entry.source_id === selected)
  if (!item) return
  sourceId.value = item.source_id
  sourceName.value = item.source_name
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
    if (mode.value === 'application') {
      renderSourcePicker(sourceId.value)
    }
  }
  if (view.message) {
    message.textContent = view.message
    message.dataset.kind = 'success'
  }
}

mode.addEventListener('change', updateModeFields)
sourcePicker.addEventListener('change', applyPickerSelection)
refreshSourcesBtn.addEventListener('click', () => {
  void refreshSources()
})

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
