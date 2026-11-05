# Mayuka Design

Design language, interface design, wireframes and user flows for the settings surfaces (tray popover + full settings window). Technical detail lives in [`docs/specs/settings-ui.md`](docs/specs/settings-ui.md).

> Status: finalized. Derived from options B (status console) and D (tray popover) in `.temp/artifacts/settings/`.
> Scope: tray, popover and settings window. The avatar window is out of scope.

## 1. Goals

1. Clicking the tray icon opens a **quick popover** (option D) for frequent actions: check runtime status, switch the voice source, scale the character, show / hide / reset the avatar window, copy the MCP command.
2. "More settings…" in the popover opens the **full settings window** (option B): a persistent status bar on top, an anchored table of contents beside one long scrolling page, and a live level meter next to the voice source.
3. Both windows look and behave as one product surface.

Non-goals:

- No click-through lock toggle yet. The lock lives in the avatar renderer, which has to report it first.
- No picker for running applications. Application mode keeps manual `source_id` / `source_name` entry.

## 2. Design language

### 2.1 Principles

- **Status first.** Good and bad states are distinguished by color and shape, never by prose alone.
- **Frequent actions in the popover, everything else one click away.** Anything the popover cannot finish hands off to the full window at the right section.
- **Quiet chrome.** System fonts, flat surfaces, no decoration beyond status lights and the level meter.

### 2.2 Popover (follows system light / dark)

- System font. On macOS the window uses native popover vibrancy over a translucent background.
- Colors: selection blue `#0a6cff` (dark `#3d8bff`); card white (dark `#323238`); ok `#1f9a48` (dark `#4cd07d`); warn `#b26a00` (dark `#f0a640`).
- Radii: window 12, card 10, segmented control 7.

### 2.3 Full settings window (fixed dark)

- Background `#0d1117`, panel `#121821`, divider `#232c3a`, accent `#7d93ff`, ok `#3fd07f`, warn `#f2b33d`, error `#ff6b6b`.
- Monospace (`ui-monospace, SF Mono, Menlo`) for keys, commands, ports and logs.
- Status light: 8 px dot with a 3 px halo of the same color at 20% opacity.

### 2.4 Status copy

The application UI is in Chinese; the strings below are the shipped copy.

| Listener status | Light | Copy |
|---|---|---|
| running | ok | 正在捕获 |
| idle | ok | 等待声音 (when no target process is found: 未找到目标进程) |
| starting | warn | 启动中 |
| disabled | gray | 仅外部事件 |
| permission-denied | warn | 需要授权 |
| unavailable | error | 不可用 |
| error | error | 出错 |

## 3. Wireframes

### 3.1 Tray popover (340 px wide, height follows content)

```
┌──────────────────────────────────────┐
│ Mayuka            ● bridge  ● listener│
├──────────────────────────────────────┤
│ ⚠ Permission required      [Authorize]│  only when permission is denied
├──────────────────────────────────────┤
│ ┌────────────┐┌────────────┐┌───────┐│
│ │◉ Hide      ││⤢ Reset     ││⧉ Copy ││
│ │  avatar    ││  position  ││  MCP  ││
│ └────────────┘└────────────┘└───────┘│
├──────────────────────────────────────┤
│ Voice source                         │
│ [ Auto | App | Custom | External ]   │
│ ▁▂▃▅▆▇▅▃▂▁  live level               │
├──────────────────────────────────────┤
│ Scale   50% ───────●────── 175%      │
├──────────────────────────────────────┤
│ More settings…                  Quit │
└──────────────────────────────────────┘
```

### 3.2 Full settings window (860×640, min 720×520)

```
┌────────────────────────────────────────────────────────────┐
│ ● bridge 127.0.0.1:47832   ● listener running   ● permission│  persistent status bar
├───────────────┬────────────────────────────────────────────┤
│ Voice source  │ [Auto] [App] [Custom] [External]  mode cards│
│ MCP           │ source fields for the selected mode         │
│ Avatar        │ ▁▂▃▅▆▇▅▃▂▁  level      12:01 running        │
│ General       │                         12:00 starting      │
│ Diagnostics   │                         [Save and apply]    │
│               ├────────────────────────────────────────────┤
│               │ MCP: [Codex | Claude Code | URL]            │
│               │ $ codex mcp add live2d --url …      [Copy]  │
│               ├────────────────────────────────────────────┤
│               │ Avatar: scale ──●── · bounds · Show · Reset │
│               ├────────────────────────────────────────────┤
│               │ General: ☐ Launch at login                  │
│               ├────────────────────────────────────────────┤
│               │ Diagnostics: settings.json path · versions  │
└───────────────┴────────────────────────────────────────────┘
```

## 4. User flows

### 4.1 Opening settings

| Platform | Left click | Right click |
|---|---|---|
| macOS / Windows | Toggle the popover | Context menu (fallback) |
| Linux | Tray icons usually do not emit click; the context menu is the entry point and "Open settings" opens the full window directly | Same |

Context menu items: Show avatar, Hide avatar, Reset window position, Open settings (full window), Quit.

### 4.2 Popover behavior

- Frameless; closes on blur and on Esc.
- Appears next to the tray icon: below it when the tray is in the top half of the screen (macOS menu bar), above it when in the bottom half (Windows taskbar). Always kept inside the display's work area.
- Clicking the tray icon while the popover is open closes it and does not reopen it.

### 4.3 Popover content, top to bottom

1. Header: app name and two status lights (bridge, listener).
2. Permission banner, shown only when the listener reports `permission-denied`, with an "Authorize" button that opens system settings.
3. Three tiles: show / hide avatar, reset position, copy MCP command.
4. Voice source: four-segment control and live level bar.
   - Automatic and External save immediately.
   - Application and Custom switch immediately if their fields were saved before; otherwise they open the full window at the voice section.
5. Scale: 50%–175% slider, committed on release.
6. Links: More settings…, Quit.

### 4.4 Full window

- macOS uses an inset title bar with a draggable custom header; other platforms use the system title bar.
- Status bar (always visible): **bridge** (listening or not, with `127.0.0.1:<port>`), **listener** (status, mode and detail), **permission** (derived from listener status; shows "去开启" when action is needed).
- Sections:
  1. **Voice source**: four mode cards; fields depend on mode (`process_pattern`, or `source_id` / `source_name`); live level graph and readout; last six listener status changes this session; save and apply; a notice when an environment variable overrides the setting.
  2. **MCP connection**: Codex / Claude Code / URL tabs, one command with a copy button, port note.
  3. **Avatar**: scale slider, current bounds, show / hide, reset position.
  4. **General**: launch at login (macOS and Windows only).
  5. **Diagnostics**: `settings.json` path (reveal in file manager), app and Electron versions.
- Can be opened directly at a given section, for example from the popover.

## 5. Later

- Running-application picker for application mode.
- Click-through lock toggle.
- Light theme for the full window.
