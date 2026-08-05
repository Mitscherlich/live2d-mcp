/**
 * Electron 工具条启动引导（同步、尽早执行，减少顶/底栏闪一下）。
 * CSP 禁止 inline script，故放 public/ 由 index.html 引用。
 *
 * 策略与 renderer/src/main.ts shouldShowUiChrome 对齐：
 *  - 非 Electron：不处理，工具条默认可见
 *  - Electron：立刻加 electron-mode（CSS 隐藏工具条）
 *  - 仅当 uiChrome / ?debug=1 / ?ui=1 / #debug / localStorage 时再加 ui-chrome
 */
;(function () {
  var isElectron = typeof window.live2d !== 'undefined'
  if (!isElectron) return

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

  function apply(el) {
    if (!el) return
    el.classList.add('electron-mode')
    if (wantChrome()) el.classList.add('ui-chrome')
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
