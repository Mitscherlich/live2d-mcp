/**
 * 模型状态管理 - 维护当前 Live2D 模型的状态快照
 */

export interface ModelInfo {
  expressions: string[]
  motionGroups: Record<string, number>  // group name -> count
  parameters: ParameterInfo[]
}

export interface ParameterInfo {
  id: string
  name: string
  min: number
  max: number
  defaultValue: number
}

export interface ModelState {
  isRendererConnected: boolean
  currentExpression: string | null
  currentMotion: { group: string; index: number } | null
  lookAt: { x: number; y: number }
  parameters: Record<string, number>
  modelInfo: ModelInfo | null
}

const defaultState: ModelState = {
  isRendererConnected: false,
  currentExpression: null,
  currentMotion: null,
  lookAt: { x: 0, y: 0 },
  parameters: {},
  modelInfo: null,
}

let state: ModelState = { ...defaultState }

export function getState(): Readonly<ModelState> {
  return state
}

export function setRendererConnected(connected: boolean): void {
  state.isRendererConnected = connected
}

export function setExpression(expression: string | null): void {
  state.currentExpression = expression
}

export function setMotion(group: string, index: number): void {
  state.currentMotion = { group, index }
}

export function setLookAt(x: number, y: number): void {
  state.lookAt = { x, y }
}

export function setParameter(paramId: string, value: number): void {
  state.parameters[paramId] = value
}

export function setModelInfo(info: ModelInfo): void {
  state.modelInfo = info
}

export function resetState(): void {
  state = {
    ...defaultState,
    isRendererConnected: state.isRendererConnected,
    modelInfo: state.modelInfo,
  }
}
