export interface ModifierState {
  metaKey: boolean
  ctrlKey: boolean
}

export interface Point {
  x: number
  y: number
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface WindowBounds extends Point {
  width: number
  height: number
}

export type ZoomDirection = -1 | 0 | 1

export const MIN_WINDOW_SCALE = 0.5
export const MAX_WINDOW_SCALE = 1.75
export const DEFAULT_WINDOW_SCALE = 1
export const WINDOW_SCALE_STEP = 0.05

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function isModifierPressed(event: ModifierState, platform: string): boolean {
  return platform === 'darwin' ? event.metaKey : event.ctrlKey
}

/** 按钮模式与 S1 修饰键模式可叠加：任一模式开启即可拖动窗口。 */
export function isDragModeEnabled(
  event: ModifierState,
  platform: string,
  buttonDragging: boolean,
): boolean {
  return buttonDragging || isModifierPressed(event, platform)
}

/** 按钮模式与 S1 修饰键模式可叠加：任一模式开启即可缩放。 */
export function isScaleModeEnabled(
  event: ModifierState,
  platform: string,
  buttonScaling: boolean,
): boolean {
  return buttonScaling || isModifierPressed(event, platform)
}

/** 顶部按钮热区内暂停眼神跟随；调试面板开关仍是另一层独立条件。 */
export function shouldProcessMouseFollow(
  mouseFollowEnabled: boolean,
  inButtonHotspot: boolean,
): boolean {
  return mouseFollowEnabled && !inButtonHotspot
}

export function clampWindowScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WINDOW_SCALE
  return Math.round(clamp(value, MIN_WINDOW_SCALE, MAX_WINDOW_SCALE) * 100) / 100
}

export function nextWindowScale(current: number, direction: ZoomDirection): number {
  return clampWindowScale(clampWindowScale(current) + direction * WINDOW_SCALE_STEP)
}

export function zoomDirectionForWheel(deltaY: number): ZoomDirection {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0
  return deltaY < 0 ? 1 : -1
}

export function zoomDirectionForKey(key: string): ZoomDirection {
  if (key === '=' || key === '+') return 1
  if (key === '-' || key === '_') return -1
  return 0
}

export function screenPointToLookDirection(point: Point, bounds: WindowBounds): Point {
  const values = [point.x, point.y, bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    return { x: 0, y: 0 }
  }
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const normalizedX = clamp((point.x - centerX) / (bounds.width / 2), -1, 1)
  const normalizedY = clamp(-((point.y - centerY) / (bounds.height / 2)), -1, 1)
  return {
    x: Object.is(normalizedX, -0) ? 0 : normalizedX,
    y: Object.is(normalizedY, -0) ? 0 : normalizedY,
  }
}

export function clientPointToCanvas(
  point: Point,
  rect: RectLike,
  canvasSize: Pick<RectLike, 'width' | 'height'>,
): Point {
  const values = [
    point.x,
    point.y,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    canvasSize.width,
    canvasSize.height,
  ]
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 }
  }
  return {
    x: (point.x - rect.left) * (canvasSize.width / rect.width),
    y: (point.y - rect.top) * (canvasSize.height / rect.height),
  }
}
