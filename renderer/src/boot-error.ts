/**
 * FR-D3：缺模型 / Cubism Core 时的引导展示（单一实现点，幂等）。
 * main.ts 的运行时/初始化失败路径与 live2d-app.ts 的 loadModel 失败路径共用；
 * detail 仅在已知具体错误时传入（loadModel 路径）。
 */
export function showModelLoadError(detail?: unknown): void {
  const panel = document.getElementById('model-load-error')
  if (!panel) return
  panel.style.display = 'block'
  if (detail === undefined) return
  const detailEl = panel.querySelector('[data-error-detail]')
  if (detailEl) {
    detailEl.textContent = detail instanceof Error ? detail.message : String(detail)
  }
}
