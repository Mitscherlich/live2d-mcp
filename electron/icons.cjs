'use strict'

const path = require('node:path')

// 图标随 Electron 主进程一起分发，开发与生产均不依赖临时设计产物。
const ICONS_DIR = path.join(__dirname, 'assets', 'icons')

function appIconPath(platform = process.platform) {
  return path.join(ICONS_DIR, platform === 'win32' ? 'app.ico' : 'app.png')
}

function trayIconPath(platform = process.platform) {
  const name = platform === 'darwin'
    ? 'trayTemplate.png'
    : platform === 'win32' ? 'tray-color.ico' : 'tray-color.png'
  return path.join(ICONS_DIR, name)
}

module.exports = { appIconPath, trayIconPath }
