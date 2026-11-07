# Mayuka documentation assets

| File | Use | Dimensions | Size |
| --- | --- | --- | --- |
| `mayuka-banner-light.svg` | Warm ivory and jade README header. | 1600 × 720 | SVG |
| `mayuka-banner-dark.svg` | Deep teal and pale jade README header. | 1600 × 720 | SVG |
| `demo-settings.png` | Settings window with the active model library card and green runtime status. | 1960 × 1560 | 221,231 bytes |
| `demo-tray.png` | Tray quick controls, including the active model selector. | 680 × 928 | 68,484 bytes |

Both banners are 1600 × 720 SVGs. The B6 rabbit, Mayuka wordmark, and Chinese slogan “你的 AI，跃然桌面。” are vector paths. README uses `<picture>` and `prefers-color-scheme` to choose the system's light or dark variant, with the light banner as a fallback.

Screenshots were refreshed on 2026-11-07 from the real running Mayuka macOS app (0.1.0, Electron 39.8.10), with live settings IPC, Chinese UI, and light mode. Cubism Core and `DeepSeek.zip` were imported through the first-run wizard; the archive's model, displayed as “大肥鱼”, was active. The bridge was listening, the native listener was waiting for audio, and audio permission was granted.

`demo-settings.png` is an agent-desktop capture of the native settings window at 2× Retina scale. Only the surrounding transparent shadow margin was cropped. `demo-tray.png` uses the permitted CDP `Page.captureScreenshot` fallback at device scale 2: agent-desktop did not expose the transparent tray popover as a captureable native window. Its full 340 × 464 layout is retained, including the model selector; this makes it taller than the previous tray image. Both PNGs were compressed losslessly and visually checked.

Capture used `MAYUKA_HOME=/tmp/mayuka-verify8`, `MAYUKA_NO_LEGACY=1`, isolated Electron user data, Vite port 5178, and bridge port 47838. Light mode was emulated for the captured pages without changing system appearance. No real `~/.mayuka` data was accessed. Visible storage paths refer only to the isolated directory.

Application and tray icon files remain in [`electron/assets/icons/`](../../electron/assets/icons/README.md).
