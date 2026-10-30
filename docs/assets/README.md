# Mayuka documentation assets

| File | Use |
| --- | --- |
| `mayuka-banner-light.svg` | Warm ivory and jade README header. |
| `mayuka-banner-dark.svg` | Deep teal and pale jade README header. |
| `demo-settings.png` | Full settings window, captured at 1960 × 1560 pixels. |
| `demo-tray.png` | Tray quick controls, captured at 680 × 728 pixels. |

Both banners are 1600 × 720 SVGs. The B6 rabbit, Mayuka wordmark, and Chinese slogan “你的 AI，跃然桌面。” are vector paths. README uses `<picture>` and `prefers-color-scheme` to choose the system's light or dark variant, with the light banner as a fallback.

Screenshots were captured from the running macOS application (app 0.1.0, Electron 39.8.10), using the production renderer and live settings IPC. The native audio listener was running, the local bridge was listening, and the model was loaded. An isolated settings directory and a separate bridge port were used for capture. The interface is currently in Chinese.

Application and tray icon files remain in [`electron/assets/icons/`](../../electron/assets/icons/README.md).
