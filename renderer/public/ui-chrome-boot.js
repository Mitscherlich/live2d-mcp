/**
 * 工具条启动引导（同步、尽早执行，减少顶/底栏闪一下）。
 * CSP 禁止 inline script，故放 public/ 由 index.html 引用。
 *
 * **ui-chrome 的唯一判定点**：此处写到 documentElement 的 class 即最终结论，
 * renderer/src/main.ts 只读取该结果并同步到 body，不再重复判定。
 * 判定条件：
 *  - preload uiChrome（LIVE2D_UI_CHROME / LIVE2D_DEVTOOLS / --live2d-ui-chrome）
 *  - ?debug=1 / ?ui=1 / #debug
 *  - localStorage live2d.uiChrome=1
 * 另：渲染器只在 Electron 壳内运行（main.ts 无条件加 electron-mode），
 * 故此处也无条件加，浏览器直开调试页时行为一致。
 */
;(function () {
  function wantChrome() {
    try {
      if (window.live2d && window.live2d.uiChrome === true) return true
    } catch (_) {}
    try {
      var q = new URLSearchParams(location.search)
      if (q.get('debug') === '1' || q.get('ui') === '1') return true
    } catch (_) {}
    if (typeof location.hash === 'string' && location.hash.indexOf('debug') !== -1) return true
    try {
      if (localStorage.getItem('live2d.uiChrome') === '1') return true
    } catch (_) {}
    return false
  }

  var showChrome = wantChrome()

  function apply(el) {
    if (!el) return
    el.classList.add('electron-mode')
    if (showChrome) el.classList.add('ui-chrome')
  }

  // 尽早作用到 html，CSS 同时支持 html/body
  apply(document.documentElement)
  if (document.body) apply(document.body)
  else {
    document.addEventListener('DOMContentLoaded', function () {
      apply(document.body)
    })
  }
})()
