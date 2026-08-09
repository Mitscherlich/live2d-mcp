/**
 * HiyoriPro 专属配置：换模型时改这里。
 *
 * 本模块零依赖、零副作用，渲染侧任何模块（含被 Node type-stripping 直载的
 * command-dispatcher.ts）都可安全 import——因此 import 路径必须写 `.ts` 扩展名。
 */

/** 点击区域 → 动作分组映射 */
export const HIT_AREA_MOTIONS: Record<string, string> = {
  Body: 'Tap@Body',
}

/**
 * 动作译名：只用于调试面板的按钮文案。
 * 命令通道 / voice 体态等主路径一律用 motionTag() 的原始 group/index。
 */
export const MOTION_NAMES: Record<string, string> = {
  'Idle:0': '待机',
  'Idle:1': '待机 2',
  'Idle:2': '待机 3',
  'Flick:0': '拨动',
  'FlickDown:0': '低头',
  'FlickUp:0': '抬头',
  'Tap:0': '点击',
  'Tap:1': '点击反应',
  'Tap@Body:0': '触摸身体',
  'Flick@Body:0': '挥手 (wave)',
}

/** 状态栏用的动作标识：直接用模型原始 group/index，换模型也不退化 */
export function motionTag(group: string, index?: number): string {
  return `${group}[${index ?? 'rand'}]`
}
