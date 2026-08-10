'use strict'

/**
 * 托盘纯构建模块（ADR 0001 · F7 · FR-D2）。Electron 依赖由 main 注入，
 * 使菜单动作、window-all-closed 保活、姿势随机切换与帧动画可由 node:test 直接验证。
 *
 * 图标：平面黑白 pictogram 小人（assets/tray），darwin 标记 template image 以适配
 * 菜单栏深色/浅色；运行时用 PNG 帧 + setImage 做简约动画，并在六种姿势间随机切换。
 * GIF/WebM 作为 assets 交付物（预览/文档），不依赖 Electron 原生解码动画。
 */

const fs = require('node:fs')
const path = require('node:path')

/** @typedef {{ id: string, name: string }} TrayPose */

/** 六种姿势（id 对应 assets/tray 下的资源名；name 为中文验收名）。 */
const TRAY_POSES = Object.freeze([
  Object.freeze({ id: 'lie-flat', name: '躺平' }),
  Object.freeze({ id: 'stand-and-wave', name: '站立打招呼' }),
  Object.freeze({ id: 'squat-and-think', name: '蹲下思考' }),
  Object.freeze({ id: 'bored-idle', name: '无聊发呆' }),
  Object.freeze({ id: 'chase-butterfly', name: '追蝴蝶' }),
  Object.freeze({ id: 'peek-from-edge', name: '从边缘伸头查看' }),
])

const DEFAULT_ASSETS_DIR = path.join(__dirname, '..', 'assets', 'tray')
const DEFAULT_ICON_SIZE = 22
const DEFAULT_FRAME_INTERVAL_MS = 120
/** 每个姿势停留最短时间（30s）。 */
const DEFAULT_POSE_HOLD_MIN_MS = 30_000
/** 每个姿势停留最长时间（1min）。 */
const DEFAULT_POSE_HOLD_MAX_MS = 60_000

/**
 * 从当前姿势之外随机选下一个（保证切换，除非只有一个姿势）。
 * @param {string | null | undefined} currentId
 * @param {readonly TrayPose[]} poses
 * @param {() => number} [random]
 */
function pickNextPoseId(currentId, poses = TRAY_POSES, random = Math.random) {
  const list = poses.length ? poses : TRAY_POSES
  if (list.length === 1) return list[0].id
  const candidates = list.filter((p) => p.id !== currentId)
  const pool = candidates.length ? candidates : list
  const idx = Math.floor(random() * pool.length) % pool.length
  return pool[idx].id
}

/**
 * 随机姿势停留时长（闭区间 [minMs, maxMs] 毫秒）。
 * @param {() => number} [random]
 * @param {number} [minMs]
 * @param {number} [maxMs]
 */
function pickPoseHoldMs(
  random = Math.random,
  minMs = DEFAULT_POSE_HOLD_MIN_MS,
  maxMs = DEFAULT_POSE_HOLD_MAX_MS,
) {
  const lo = Math.min(Number(minMs) || 0, Number(maxMs) || 0)
  const hi = Math.max(Number(minMs) || 0, Number(maxMs) || 0)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return Math.max(0, Math.floor(lo) || DEFAULT_POSE_HOLD_MIN_MS)
  }
  const span = hi - lo
  return Math.floor(lo + random() * (span + 1))
}

/**
 * 帧序号前进（循环）。
 * @param {number} current
 * @param {number} frameCount
 */
function advanceFrameIndex(current, frameCount) {
  if (!Number.isFinite(frameCount) || frameCount <= 0) return 0
  const base = Number.isFinite(current) ? current : 0
  return (base + 1) % frameCount
}

/**
 * 列出某姿势目录下的 PNG 帧路径（按文件名排序）。
 * @param {string} assetsDir
 * @param {string} poseId
 * @param {{ readdirSync?: typeof fs.readdirSync, join?: typeof path.join }} [io]
 */
function listPoseFramePaths(assetsDir, poseId, io = {}) {
  const readdirSync = io.readdirSync || fs.readdirSync
  const join = io.join || path.join
  const dir = join(assetsDir, 'frames', poseId)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => typeof n === 'string' && n.toLowerCase().endsWith('.png'))
    .sort()
    .map((n) => join(dir, n))
}

/**
 * 加载全部姿势的 nativeImage 帧（可注入 nativeImage / 文件系统）。
 * @param {object} opts
 * @param {string} opts.assetsDir
 * @param {{ createFromPath: (p: string) => any }} opts.nativeImage
 * @param {number} [opts.iconSize]
 * @param {readonly TrayPose[]} [opts.poses]
 * @param {{ readdirSync?: typeof fs.readdirSync, join?: typeof path.join }} [opts.io]
 * @param {(img: any) => void} [opts.markTemplate]  — 对每帧标记 template（darwin）
 */
function loadPoseFrameImages(opts) {
  const {
    assetsDir,
    nativeImage,
    iconSize = DEFAULT_ICON_SIZE,
    poses = TRAY_POSES,
    io = {},
    markTemplate,
  } = opts
  /** @type {Map<string, any[]>} */
  const byPose = new Map()
  for (const pose of poses) {
    const paths = listPoseFramePaths(assetsDir, pose.id, io)
    const frames = []
    for (const p of paths) {
      let img = nativeImage.createFromPath(p)
      if (img && typeof img.resize === 'function') {
        img = img.resize({ width: iconSize, height: iconSize })
      }
      if (typeof markTemplate === 'function') markTemplate(img)
      frames.push(img)
    }
    byPose.set(pose.id, frames)
  }
  return byPose
}

function buildTrayMenuTemplate({ showAvatar, hideAvatar, resetAvatar = () => {}, openSettings, quitApp }) {
  return [
    { label: '显示角色窗', click: showAvatar },
    { label: '隐藏角色窗', click: hideAvatar },
    { type: 'separator' },
    { label: '重置窗口位置', click: resetAvatar },
    { type: 'separator' },
    { label: '打开设置', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]
}

/**
 * @param {object} deps
 * @param {typeof import('electron').Tray} deps.Tray
 * @param {typeof import('electron').Menu} deps.Menu
 * @param {typeof import('electron').nativeImage} deps.nativeImage
 * @param {string} deps.platform
 * @param {object} deps.actions
 * @param {string} [deps.assetsDir]
 * @param {readonly TrayPose[]} [deps.poses]
 * @param {number} [deps.iconSize]
 * @param {number} [deps.frameIntervalMs]
 * @param {number} [deps.poseHoldMinMs] 姿势停留下限，默认 30s
 * @param {number} [deps.poseHoldMaxMs] 姿势停留上限，默认 60s
 * @param {() => number} [deps.random]
 * @param {typeof setInterval} [deps.setInterval]
 * @param {typeof clearInterval} [deps.clearInterval]
 * @param {typeof setTimeout} [deps.setTimeout]
 * @param {typeof clearTimeout} [deps.clearTimeout]
 * @param {{ readdirSync?: typeof fs.readdirSync, join?: typeof path.join }} [deps.io]
 * @param {string} [deps.initialPoseId]
 */
function createTrayController({
  Tray,
  Menu,
  nativeImage,
  platform,
  actions,
  assetsDir = DEFAULT_ASSETS_DIR,
  poses = TRAY_POSES,
  iconSize = DEFAULT_ICON_SIZE,
  frameIntervalMs = DEFAULT_FRAME_INTERVAL_MS,
  poseHoldMinMs = DEFAULT_POSE_HOLD_MIN_MS,
  poseHoldMaxMs = DEFAULT_POSE_HOLD_MAX_MS,
  random = Math.random,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
  io = {},
  initialPoseId,
}) {
  const useTemplate = platform === 'darwin'
  const markTemplate = (img) => {
    if (useTemplate && img && typeof img.setTemplateImage === 'function') {
      img.setTemplateImage(true)
    }
  }

  const frameMap = loadPoseFrameImages({
    assetsDir,
    nativeImage,
    iconSize,
    poses,
    io,
    markTemplate,
  })

  // 若磁盘无帧，退化为 1×1 透明占位，避免构造崩溃（测试可注入路径）
  const ensureFrames = (poseId) => {
    const existing = frameMap.get(poseId)
    if (existing && existing.length) return existing
    let fallback = nativeImage.createEmpty
      ? nativeImage.createEmpty()
      : nativeImage.createFromDataURL(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        )
    if (fallback && typeof fallback.resize === 'function') {
      fallback = fallback.resize({ width: iconSize, height: iconSize })
    }
    markTemplate(fallback)
    const frames = [fallback]
    frameMap.set(poseId, frames)
    return frames
  }

  let poseId =
    initialPoseId && poses.some((p) => p.id === initialPoseId)
      ? initialPoseId
      : poses[0] ? poses[0].id : TRAY_POSES[0].id
  let frameIndex = 0
  let frames = ensureFrames(poseId)
  let currentIcon = frames[0]

  const tray = new Tray(currentIcon)
  tray.setToolTip('Live2D Companion')
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(actions)))
  tray.on('click', actions.showAvatar)

  /** @type {string[]} */
  const poseHistory = [poseId]
  /** @type {number[]} */
  const poseHoldHistory = []
  /** @type {number} */
  let setImageCount = 0
  let stopped = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let poseTimer = null

  const applyFrame = () => {
    frames = ensureFrames(poseId)
    if (!frames.length) return
    if (frameIndex >= frames.length) frameIndex = 0
    currentIcon = frames[frameIndex]
    if (typeof tray.setImage === 'function') {
      tray.setImage(currentIcon)
      setImageCount += 1
    }
  }

  const tickFrame = () => {
    frames = ensureFrames(poseId)
    frameIndex = advanceFrameIndex(frameIndex, frames.length)
    applyFrame()
  }

  const tickPose = () => {
    const next = pickNextPoseId(poseId, poses, random)
    poseId = next
    poseHistory.push(poseId)
    frameIndex = 0
    applyFrame()
  }

  const schedulePoseSwitch = () => {
    if (stopped) return
    const delay = pickPoseHoldMs(random, poseHoldMinMs, poseHoldMaxMs)
    poseHoldHistory.push(delay)
    poseTimer = setTimeoutFn(() => {
      if (stopped) return
      tickPose()
      schedulePoseSwitch()
    }, delay)
  }

  const frameTimer = setIntervalFn(tickFrame, frameIntervalMs)
  schedulePoseSwitch()

  const stopAnimation = () => {
    stopped = true
    clearIntervalFn(frameTimer)
    if (poseTimer != null) clearTimeoutFn(poseTimer)
    poseTimer = null
  }

  // 供 main 在 quit 时销毁托盘前停表；并暴露可测状态
  tray.stopAnimation = stopAnimation
  tray.getTrayAnimationState = () => ({
    poseId,
    frameIndex,
    poseHistory: poseHistory.slice(),
    poseHoldHistory: poseHoldHistory.slice(),
    poseHoldMinMs,
    poseHoldMaxMs,
    setImageCount,
    useTemplate,
    poseNames: poses.map((p) => p.name),
    poseIds: poses.map((p) => p.id),
  })

  const originalDestroy = typeof tray.destroy === 'function' ? tray.destroy.bind(tray) : null
  tray.destroy = () => {
    stopAnimation()
    if (originalDestroy) originalDestroy()
  }

  return tray
}

function shouldQuitAfterAllWindowsClosed(tray) {
  return !tray || tray.isDestroyed()
}

module.exports = {
  TRAY_POSES,
  DEFAULT_ASSETS_DIR,
  DEFAULT_ICON_SIZE,
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_POSE_HOLD_MIN_MS,
  DEFAULT_POSE_HOLD_MAX_MS,
  pickNextPoseId,
  pickPoseHoldMs,
  advanceFrameIndex,
  listPoseFramePaths,
  loadPoseFrameImages,
  buildTrayMenuTemplate,
  createTrayController,
  shouldQuitAfterAllWindowsClosed,
}
