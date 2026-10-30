/**
 * 大肥鱼（DeepSeek）专属配置：换模型时改这里，并同步 live2d-app.ts 的 MODEL_PATH。
 *
 * 本模块零依赖、零副作用，渲染侧任何模块（含被 Node type-stripping 直载的
 * command-dispatcher.ts）都可安全 import——因此 import 路径必须写 `.ts` 扩展名。
 */

/**
 * 点击区域 → 动作分组映射。
 * 大肥鱼 model3.json 未声明 HitArea，点击不绑动作。
 */
export const HIT_AREA_MOTIONS: Record<string, string> = {}

/**
 * 动作译名：只用于调试面板的按钮文案。
 * 命令通道 / voice 体态等主路径一律用 motionTag() 的原始 group/index。
 */
export const MOTION_NAMES: Record<string, string> = {
  'Idle:0': '待机',
  '默认手切举手:0': '默认手切举手',
  '举手切默认手:0': '举手切默认手',
  '狗尾草切换出来:0': '狗尾草切换出来',
  '狗尾草切回默认手:0': '狗尾草切回默认手',
  '竖手指切出来动画:0': '竖手指切出来',
  '竖手指切回默认:0': '竖手指切回默认',
  '脱捕:0': '脱捕',
}

/**
 * 物理输入。大肥鱼把 ParamAngleX / ParamBodyAngleX 做成物理输出，
 * 引擎的视线和呼吸写这些输出会被物理覆盖，只剩 ParamEyeBall 在动。
 * 系数对齐 Cubism 默认 focus（±30 / 身体 ±10）和 breath（peak × weight）。
 * 换没有这套输入的模型时把表清空。
 */
export interface PhysicsInputDrive {
  id: string
  x: number
  y: number
  xy: number
  breathAmp: number
  breathCycle: number
}

export const PHYSICS_INPUT_DRIVES: readonly PhysicsInputDrive[] = [
  { id: 'AngleX', x: 30, y: 0, xy: 0, breathAmp: 7.5, breathCycle: 6.5345 },
  { id: 'AngleY', x: 0, y: 30, xy: 0, breathAmp: 4, breathCycle: 3.5345 },
  { id: 'AngleZ', x: 0, y: 0, xy: -30, breathAmp: 5, breathCycle: 5.5345 },
  { id: 'PositionX', x: 10, y: 0, xy: 0, breathAmp: 2, breathCycle: 15.5345 },
]

/** 状态栏用的动作标识：直接用模型原始 group/index，换模型也不退化 */
export function motionTag(group: string, index?: number): string {
  return `${group}[${index ?? 'rand'}]`
}
