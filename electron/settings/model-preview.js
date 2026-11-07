'use strict'

/** Standalone model preview / inspector window. Talks to preview.html (sandboxed iframe) via postMessage. */

const api = window.live2dSettings
const $ = (selector) => document.querySelector(selector)
const params = new URLSearchParams(location.search)
const ORIGIN = params.get('previewOrigin')
const MODEL_ID = params.get('id')

document.documentElement.dataset.platform = params.get('platform') ?? ''

const frame = $('#frame')
let view = null
let loaded = false
let zoom = 1

function send(message) {
  if (ORIGIN) frame.contentWindow?.postMessage(message, ORIGIN)
}

function formatBytes(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function stageMessage(text, isError = false) {
  const el = $('#stage-msg')
  el.hidden = !text
  el.textContent = text ?? ''
  el.classList.toggle('err', isError)
}

function model() {
  return view?.library.models.find((m) => m.id === MODEL_ID) ?? null
}

function renderInfo() {
  const m = model()
  if (!m) {
    stageMessage('模型已被删除', true)
    $('#activate').disabled = true
    $('#remove').disabled = true
    return
  }
  document.title = `Mayuka 模型预览 · ${m.name}`
  $('#title').textContent = m.name
  $('#sub').textContent = '· 预览'
  $('#meta').textContent = `${formatBytes(m.bytes)} · ${m.motions.length} 动作 · ${m.expressions.length} 表情 · ${loaded ? parts.length : m.parts.length} 部件`
  const active = m.id === view.library.activeId
  $('#activate').disabled = active || !view.library.readiness.core
  $('#activate').textContent = active ? '当前模型' : '设为当前'
  $('#remove').disabled = active
}

function chip(label, onClick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', () => onClick(b))
  return b
}

function fillMotions(motions) {
  const box = $('#motions')
  box.replaceChildren()
  $('#motion-count').textContent = `· ${motions.length}`
  let group = null
  for (const m of motions) {
    if (m.group !== group) {
      group = m.group
      const g = document.createElement('div')
      g.className = 'grp'
      g.textContent = group || '(default)'
      box.append(g)
    }
    box.append(
      chip(`▶ ${m.name}`, (b) => {
        for (const el of box.querySelectorAll('button.on')) el.classList.remove('on')
        b.classList.add('on')
        send({ type: 'motion', group: m.group, index: m.index })
      }),
    )
  }
}

function fillExpressions(names) {
  const box = $('#exprs')
  box.replaceChildren()
  $('#expr-count').textContent = `· ${names.length}`
  for (const name of names) {
    box.append(
      chip(name, (b) => {
        for (const el of box.querySelectorAll('button.on')) el.classList.remove('on')
        b.classList.add('on')
        send({ type: 'expression', name })
      }),
    )
  }
}

let parts = []

function renderParts() {
  const filter = $('#part-filter').value.trim().toLowerCase()
  const box = $('#parts')
  box.replaceChildren()
  $('#part-count').textContent = `· ${parts.length}`
  for (const part of parts) {
    if (filter && !part.name.toLowerCase().includes(filter) && !part.id.toLowerCase().includes(filter)) continue
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = part.visible
    input.addEventListener('change', () => {
      part.visible = input.checked
      send({ type: 'part', id: part.id, visible: part.visible })
    })
    label.append(input, document.createTextNode(part.name))
    box.append(label)
  }
}

function setZoomText() {
  $('#zoom-text').textContent = `${Math.round(zoom * 100)}%`
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== ORIGIN) return
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'ready') {
    send({ type: 'load', id: MODEL_ID })
  } else if (msg.type === 'loaded' && msg.id === MODEL_ID) {
    loaded = true
    stageMessage('')
    fillMotions(Array.isArray(msg.motions) ? msg.motions : [])
    fillExpressions(Array.isArray(msg.expressions) ? msg.expressions : [])
    parts = Array.isArray(msg.parts) ? msg.parts : []
    renderParts()
    renderInfo()
    zoom = 1
    setZoomText()
    const m = model()
    if (m && !m.thumb) send({ type: 'snapshot', id: MODEL_ID })
  } else if (msg.type === 'zoom' && typeof msg.value === 'number') {
    zoom = msg.value
    setZoomText()
  } else if (msg.type === 'snapshot' && msg.ok && msg.id === MODEL_ID && msg.png instanceof ArrayBuffer) {
    void api.saveThumbnail(MODEL_ID, msg.png)
  } else if (msg.type === 'error') {
    stageMessage(`预览失败：${String(msg.error).slice(0, 160)}`, true)
  }
})

for (const button of document.querySelectorAll('#bg button')) {
  button.addEventListener('click', () => {
    for (const el of document.querySelectorAll('#bg button')) {
      el.classList.toggle('on', el === button)
      el.setAttribute('aria-pressed', String(el === button))
    }
    $('#stage').dataset.bg = button.dataset.bg
  })
}
$('#zoom-in').addEventListener('click', () => send({ type: 'zoom', value: zoom * 1.2 }))
$('#zoom-out').addEventListener('click', () => send({ type: 'zoom', value: zoom / 1.2 }))
$('#zoom-text').addEventListener('click', () => send({ type: 'zoom', value: 1 }))
$('#expr-reset').addEventListener('click', () => {
  for (const el of document.querySelectorAll('#exprs button.on, #motions button.on')) el.classList.remove('on')
  send({ type: 'reset' })
})
$('#parts-all').addEventListener('click', () => {
  for (const part of parts) {
    part.visible = true
    send({ type: 'part', id: part.id, visible: true })
  }
  renderParts()
})
$('#part-filter').addEventListener('input', renderParts)

$('#activate').addEventListener('click', async () => {
  $('#activate').disabled = true
  const result = await api.action({ type: 'model-activate', id: MODEL_ID })
  if (!result?.ok) {
    stageMessage(result?.error ?? '切换失败', true)
    renderInfo()
  }
})
$('#remove').addEventListener('click', async () => {
  const m = model()
  if (!m || !confirm(`删除「${m.name}」？此操作不可恢复。`)) return
  const result = await api.action({ type: 'model-remove', id: MODEL_ID })
  if (result?.ok) window.close()
})

function destroy() {
  try {
    send({ type: 'destroy' })
  } catch {
    /* frame already gone */
  }
}
window.addEventListener('pagehide', destroy)

api.onChanged((next) => {
  view = next
  renderInfo()
})

async function start() {
  if (!MODEL_ID || !ORIGIN) return stageMessage('无法预览：缺少参数', true)
  view = await api.get()
  renderInfo()
  if (!model()) return
  if (!view.library.readiness.core) return stageMessage('需要先安装 Cubism Core（设置 → 通用）才能预览', true)
  frame.src = `${ORIGIN}/preview.html`
}
void start()
