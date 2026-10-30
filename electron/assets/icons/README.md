# B6 应用图标

定稿为 B6「长垂耳 · 玉绿」。本目录是应用正式资源，不依赖 `.temp/`。

- `app.png`：macOS Dock 与非 Windows 窗口图标。
- `app.icns`：macOS 打包图标，包含 16–1024 px。
- `app.ico`：Windows 窗口与打包图标，包含 16–256 px。
- `brand.png`：快捷面板中的 B6 品牌图案，128 px 原画缩略图，由页面显示为 36 px。
- `trayTemplate.png` / `trayTemplate@2x.png`：macOS 18 pt 单色托盘模板，由系统适配深浅菜单栏。
- `tray-color.ico`：Windows 彩色托盘，包含 16–64 px。
- `tray-color.png` / `tray-color@2x.png`：其他平台的 32 / 64 px 彩色托盘。
- `tray-black*` / `tray-white*`：固定黑白版本，保留给其他界面或后续主题选项。

运行时加载路径统一在 `electron/icons.cjs`。正式打包时应保留整个目录，分别使用 `app.icns` / `app.ico` 作为包图标。
