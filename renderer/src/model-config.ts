/**
 * Per-model tuning, stored in the model manifest (`overrides`) and delivered by the main
 * process. Empty tables are the safe default for any model.
 */
export interface PhysicsInputDrive {
  id: string
  x: number
  y: number
  xy: number
  breathAmp: number
  breathCycle: number
}

export interface ModelOverrides {
  /** hit area name -> motion group played on click */
  hitAreaMotions: Record<string, string>
  /** "group:index" -> display name, only used for debug panel labels */
  motionNames: Record<string, string>
  /** Gaze/breath written as physics inputs for models whose angles are physics outputs */
  physicsInputDrives: PhysicsInputDrive[]
}

export const EMPTY_OVERRIDES: ModelOverrides = Object.freeze({
  hitAreaMotions: {},
  motionNames: {},
  physicsInputDrives: [],
}) as ModelOverrides

/** Validate untrusted manifest data into ModelOverrides (anything malformed is dropped). */
export function sanitizeOverrides(raw: unknown): ModelOverrides {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const strMap = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
    }
    return out
  }
  const drives: PhysicsInputDrive[] = []
  if (Array.isArray(r.physicsInputDrives)) {
    for (const d of r.physicsInputDrives as Array<Record<string, unknown>>) {
      const nums = [d?.x, d?.y, d?.xy, d?.breathAmp, d?.breathCycle]
      if (typeof d?.id === 'string' && nums.every((n) => typeof n === 'number' && Number.isFinite(n)) && (d.breathCycle as number) > 0) {
        drives.push({ id: d.id, x: d.x as number, y: d.y as number, xy: d.xy as number, breathAmp: d.breathAmp as number, breathCycle: d.breathCycle as number })
      }
    }
  }
  return { hitAreaMotions: strMap(r.hitAreaMotions), motionNames: strMap(r.motionNames), physicsInputDrives: drives }
}

/** 状态栏用的动作标识：直接用模型原始 group/index，换模型也不退化 */
export function motionTag(group: string, index?: number): string {
  return `${group}[${index ?? 'rand'}]`
}
