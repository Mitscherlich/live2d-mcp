'use strict'

/** First-run wizard: welcome -> Cubism Core -> model -> done. Core and model can each be skipped. */

const api = window.live2dSettings
const $ = (selector) => document.querySelector(selector)

document.documentElement.dataset.platform = new URLSearchParams(location.search).get('platform') ?? ''

let step = 0
let lib = { readiness: { core: false, model: false }, core: { installed: false }, models: [] }
const LAST = 3

function ready() {
  return lib.readiness.core && lib.readiness.model
}

function render() {
  for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = Number(pane.dataset.pane) !== step
  for (const li of document.querySelectorAll('#steps li')) {
    const n = Number(li.dataset.step)
    li.classList.toggle('on', n === step)
    li.classList.toggle('done', (n === 0 && step > 0) || (n === 1 && lib.readiness.core) || (n === 2 && lib.readiness.model))
    li.querySelector('b').textContent = li.classList.contains('done') && n !== step ? '✓' : String(n + 1)
    if (n === step) li.setAttribute('aria-current', 'step')
    else li.removeAttribute('aria-current')
  }
  $('#core-state').textContent = lib.core.installed ? '已安装' : '未安装'
  $('#model-state').textContent = lib.models.length ? `已导入 ${lib.models.length} 个` : '未导入'
  $('#back').hidden = step === 0
  $('#skip').hidden = step === 0 || step === LAST
  if (step === LAST) {
    $('#next').textContent = '完成'
    $('#next').disabled = !ready()
    $('#done-text').textContent = ready()
      ? '一切就绪，角色会出现在桌面上。之后可在设置窗里管理模型。'
      : '还缺少 Cubism Core 或模型，请返回上一步补全；也可以关闭向导稍后再设置。'
  } else {
    $('#next').textContent = '下一步'
    $('#next').disabled = false
  }
}

async function pick(input, importer, msg) {
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  msg.textContent = '正在导入…'
  const result = await importer(file)
  msg.textContent = result?.ok ? '导入完成' : `导入失败：${result?.error ?? '未知错误'}`
}

$('#core-pick').addEventListener('click', () => $('#core-file').click())
$('#core-file').addEventListener('change', (e) => void pick(e.target, (f) => api.importCore(f), $('#core-msg')))
$('#model-pick').addEventListener('click', () => $('#model-file').click())
$('#model-file').addEventListener('change', (e) => void pick(e.target, (f) => api.importModel(f), $('#model-msg')))
api.onModelProgress((p) => {
  $('#model-msg').textContent = `${p?.label ?? '导入中'} (${p?.step ?? '?'}/${p?.total ?? '?'})`
})

$('#back').addEventListener('click', () => { step = Math.max(0, step - 1); render() })
$('#skip').addEventListener('click', () => { step = Math.min(LAST, step + 1); render() })
$('#next').addEventListener('click', () => {
  if (step === LAST) window.close()
  else { step += 1; render() }
})

api.onChanged((view) => { if (view?.library) { lib = view.library; render() } })
api.get().then((view) => { if (view?.library) lib = view.library; render() }).catch(() => render())
