/**
 * Read-only model preview, embedded as a sandboxed iframe in the settings window.
 * No bridge, voice or window control. The parent drives it with postMessage; every message is
 * checked for source (must be the parent window) and shape before it is acted on.
 */

import type { Live2DApp } from './live2d-app.js'

// Installed Core first; the dev-only renderer/public copy second (mirrors the avatar's legacy fallback).
const CORE_URLS = ['/user-core/live2dcubismcore.min.js', '/live2dcubismcore.min.js']
const canvas = document.getElementById('c') as HTMLCanvasElement

let app: Live2DApp | null = null
let currentId: string | null = null
let queue: Promise<unknown> = Promise.resolve()

function post(message: Record<string, unknown>): void {
  window.parent.postMessage(message, '*')
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => { script.remove(); reject(new Error('Cubism Core is not installed')) }
    document.head.appendChild(script)
  })
}

async function injectCore(): Promise<void> {
  let lastError: unknown = new Error('Cubism Core is not installed')
  for (const url of CORE_URLS) {
    try {
      await loadScript(url)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function ensureApp(): Promise<Live2DApp> {
  if (app) return app
  await injectCore()
  const mod = await import('./live2d-app.js')
  const created = new mod.Live2DApp()
  await created.init(canvas)
  app = created
  return created
}

/** Part id -> display name from the model's cdi3 file (best effort). */
async function readPartNames(id: string, entry: string, displayInfo: string | null): Promise<Record<string, string>> {
  if (!displayInfo) return {}
  try {
    const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : ''
    const url = `/user-models/${id}/${(dir + displayInfo).split('/').map(encodeURIComponent).join('/')}`
    const cdi = (await (await fetch(url)).json()) as { Parts?: Array<{ Id?: string; Name?: string }> }
    const names: Record<string, string> = {}
    for (const part of cdi.Parts ?? []) if (part?.Id && part?.Name) names[part.Id] = part.Name
    return names
  } catch {
    return {}
  }
}

let zoom = 1

function setZoom(value: number): void {
  zoom = Math.min(3, Math.max(0.3, value))
  app?.setZoom(zoom)
  post({ type: 'zoom', value: zoom })
}

async function load(id: string): Promise<void> {
  const manifestRes = await fetch(`/user-models/${id}/mayuka-model.json`)
  if (!manifestRes.ok) throw new Error('Model manifest not found')
  const manifest = (await manifestRes.json()) as { entry?: unknown; overrides?: unknown }
  if (typeof manifest.entry !== 'string') throw new Error('Invalid manifest')
  const a = await ensureApp()
  const { sanitizeOverrides } = await import('./model-config.js')
  await a.loadModel(`/user-models/${id}/${encodeURIComponent(manifest.entry)}`, sanitizeOverrides(manifest.overrides))
  currentId = id
  zoom = 1
  const info = a.getModelInfo()
  const names = await readPartNames(id, manifest.entry, a.getDisplayInfoFile())
  post({
    type: 'loaded',
    id,
    motions: a.getMotionFiles(),
    expressions: info?.expressions ?? [],
    parts: a.getPartList().map((p) => ({ id: p.id, name: names[p.id] ?? p.id, visible: p.opacity > 0 })),
  })
}

const THUMB_SIZE = 320

/** Downscaled copy of the current frame; fails (instead of saving a blank image) if nothing was drawn. */
function snapshot(id: string): void {
  if (!app?.renderNow()) return post({ type: 'snapshot', id, ok: false })
  const out = document.createElement('canvas')
  out.width = THUMB_SIZE
  out.height = THUMB_SIZE
  const ctx = out.getContext('2d')!
  ctx.drawImage(canvas, 0, 0, THUMB_SIZE, THUMB_SIZE)
  const pixels = ctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data
  let drawn = false
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 8) { drawn = true; break }
  }
  if (!drawn) return post({ type: 'snapshot', id, ok: false })
  out.toBlob(async (blob) => {
    if (!blob) return post({ type: 'snapshot', id, ok: false })
    post({ type: 'snapshot', id, ok: true, png: await blob.arrayBuffer() })
  }, 'image/png')
}

function destroy(): void {
  app?.destroy()
  app = null
  currentId = null
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9_-]{1,80}$/.test(v)
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const msg = event.data as Record<string, unknown> | null
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
  switch (msg.type) {
    case 'load':
      if (!isId(msg.id)) return
      queue = queue
        .then(() => load(msg.id as string))
        .catch((e) => post({ type: 'error', error: e instanceof Error ? e.message : String(e) }))
      break
    case 'motion':
      if (typeof msg.group === 'string') app?.playMotion(msg.group, typeof msg.index === 'number' ? msg.index : -1, 3)
      break
    case 'expression':
      if (typeof msg.name === 'string') app?.setExpression(msg.name)
      break
    case 'part':
      if (typeof msg.id === 'string' && typeof msg.visible === 'boolean') app?.setPartVisible(msg.id, msg.visible)
      break
    case 'reset':
      app?.reset()
      break
    case 'zoom':
      if (typeof msg.value === 'number') setZoom(msg.value)
      break
    case 'snapshot':
      if (isId(msg.id) && msg.id === currentId) snapshot(msg.id)
      break
    case 'destroy':
      destroy()
      break
  }
})

window.addEventListener('wheel', (event) => {
  event.preventDefault()
  setZoom(zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08))
}, { passive: false })
window.addEventListener('pagehide', destroy)
post({ type: 'ready' })
