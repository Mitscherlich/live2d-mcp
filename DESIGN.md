# Mayuka Design

Design language, interface design, wireframes and user flows for the settings surfaces (full settings, first-run wizard, model preview and tray popover). Technical detail lives in [`docs/specs/settings-ui.md`](docs/specs/settings-ui.md).

> Status: finalized. Approved references: `.temp/design3/01-model-light.png` through `05-preview-light.png` and `.temp/design3/demo/`, using magpie's visual language.
> Scope: tray popover, full settings, first-run wizard and model preview. The avatar window is out of scope.

## 1. Goals

1. Clicking the tray icon opens a **quick popover** for frequent actions: check runtime status, switch the voice source, scale the character, show / hide / reset the avatar window, copy the MCP command.
2. "More settings…" in the popover opens the **full settings window**: a persistent status bar on top, an anchored table of contents beside one long scrolling page, and a live level meter next to the voice source.
3. All four settings windows use the same palette, grouped rows, controls and light / dark appearance.

Non-goals:

- No click-through lock toggle yet. The lock lives in the avatar renderer, which has to report it first.
- No picker for running applications. Application mode keeps manual `source_id` / `source_name` entry.

## 2. Design language

### 2.1 Principles

- **Status first.** Good and bad states are distinguished by color and shape, never by prose alone.
- **Frequent actions in the popover, everything else one click away.** Anything the popover cannot finish hands off to the full window at the right section.
- **Quiet chrome.** System fonts, flat surfaces, no decoration beyond status lights and the level meter.

### 2.2 Shared palette and controls

All four windows follow the system light / dark appearance. Use system UI fonts, with monospace only for commands, paths and runtime values.

| Token | Light | Dark |
|---|---|---|
| Canvas | `#f4f4f6` | `#1a1a1e` |
| Grouped card | `#ffffff` | `#232327` |
| Secondary surface | `#f9f9fb` | `#1f1f23` |
| Control / hover | `#f1f1f4` / `#e9e9ee` | `#2d2d33` / `#36363d` |
| Divider / inner divider | `#e3e3e8` / `#ececf0` | `#333339` / `#2c2c32` |
| Text / secondary text | `#1c1c21` / `#4b4b53` | `#ededf1` / `#b9b9c1` |
| Muted text | `#85858d` | `#8b8b94` |
| Accent / soft accent | `#4f46e5` / `#eeedfd` | `#a5b4fc` / `#2b2c47` |
| Sidebar selection | `#e7e7ec` | `#2d2d33` |
| Success / warning / error | `#189a58` / `#b45309` / `#d64545` | `#6fd99b` / `#f2b544` / `#f28b82` |

- Cards have 12 px corners, controls 7 px, model tiles 8 px. Cards use a quiet hairline rather than a raised shadow.
- Rows place the name and supporting text on the left and controls on the right, with fine inner dividers. Normal rows are at least 48 px high; general rows are 60 px.
- Segmented controls use a grey track and a neutral selected thumb. Reserve the accent for primary actions, enabled switches and the selected model tile.
- Status lights are 7 px dots, always paired with text. Buttons have hover / pressed feedback; keyboard focus uses a visible 2 px accent ring. Reduced motion removes transitions and smooth scrolling.
- The macOS popover keeps native vibrancy behind a translucent canvas. Other windows use an opaque canvas.

### 2.3 Full settings layout

- A 188 px sidebar contains a simple **Mayuka** title, six navigation items with a grey selected pill, and the **仅在本机运行** footer. At the minimum width the sidebar narrows to 150 px.
- A quiet top title and a single divided status strip stay visible above the content: **BRIDGE / LISTENER / PERMISSION**. They share the canvas rather than appearing as separate cards.
- Content has 27 px side margins and 19 px section headings above grouped cards. Navigation keeps the existing anchored, single scrolling page.
- The model library groups its heading, real thumbnail grid and selected-model detail row in one card. A second card combines import and storage-path rows. The active-model badge and selected-tile outline express different states.
- General settings have **启动** and **运行组件** group labels, a login switch, and a two-row Core card with installation controls and its storage path.
- No settings search, model list-view toggle, or extra wizard / preview shortcuts on General. Only implemented controls belong in the interface.

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
┌──────────────────┬──────────────────────────────────────────┐
│ native controls  │ Settings                                 │
│ Mayuka           ├──────────────────────────────────────────┤
│                  │ BRIDGE       LISTENER       PERMISSION   │
│ Voice source     ├──────────────────────────────────────────┤
│ MCP connection   │ Model library                            │
│ [Model library]  │ Hint: double-click a model to preview     │
│ Avatar           │ ┌──────────────────────────────────────┐ │
│ General          │ │ Library · count                      │ │
│ Diagnostics      │ │ [thumbnail] [thumbnail] [thumbnail]  │ │
│                  │ │ Name · size/counts  Preview Use Delete│ │
│                  │ └──────────────────────────────────────┘ │
│                  │ ┌──────────────────────────────────────┐ │
│                  │ │ Import model             Choose file │ │
│                  │ │ Storage path                  Reveal │ │
│ Local only       │ └──────────────────────────────────────┘ │
└──────────────────┴──────────────────────────────────────────┘
```

Each navigation item anchors the same scrolling page. Voice, MCP, Avatar and Diagnostics use the same grouped-row grammar. General places its startup and runtime groups under separate muted labels.

### 3.3 First-run wizard (520×460)

```
┌──────────────────────────────────────────────┐
│                 Set up Mayuka                │
├──────────────────────────────────────────────┤
│    Welcome ── [2 Core] ── Model ── Done       │
│ ┌──────────────────────────────────────────┐ │
│ │ [component icon] Install Cubism Core      │ │
│ │ File-selection guidance                  │ │
│ ├──────────────────────────────────────────┤ │
│ │ Filename · installation state      Choose│ │
│ └──────────────────────────────────────────┘ │
├──────────────────────────────────────────────┤
│ Back                         Later    Next   │
└──────────────────────────────────────────────┘
```

A centered title, numbered progress steps and one white card keep the small window legible. The footer stays fixed; long messages scroll inside the body. Welcome and completion share the same card treatment.

### 3.4 Model preview (900×620, min 720×480)

```
┌────────────────────────────────────────────────────────────┐
│                    Model · preview                 Metadata│
├───────────────────────────────────────┬────────────────────┤
│ [− 100% +]       Background [choices] │ Motions            │
│                                       │ [grouped rows]     │
│                                       │ Expressions  Reset │
│             Model stage               │ [expression rows]  │
│                                       │ Parts     Show all │
│                                       │ [filter]           │
│ Scroll to zoom                        │ [checkbox rows]    │
├───────────────────────────────────────┴────────────────────┤
│ Preview only                              Use model Delete│
└────────────────────────────────────────────────────────────┘
```

The inspector is 278 px wide (245 px in a narrow window) and scrolls independently. Background and zoom controls sit over the stage; the footer remains visible. Preserve the real white / dark / checker options and the per-motion, per-expression and per-part controls rather than the demo's abbreviated lists or expression dropdown. The initial dark stage remains selected.

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
  1. **Voice source**: four segmented mode choices; fields depend on mode (`process_pattern`, or `source_id` / `source_name`); live level graph and readout; last six listener status changes this session; save and apply; a notice when an environment variable overrides the setting.
  2. **MCP connection**: Codex / Claude Code / URL tabs, one command with a copy button, port note.
  3. **Model library**: thumbnail grid, selected-model detail row, import and storage-path card; preview opens in its own window.
  4. **Avatar**: scale slider, current bounds, show / hide, reset position.
  5. **General**: startup group with launch at login (macOS and Windows only), and runtime group with Cubism Core status, upload / replace and storage path.
  6. **Diagnostics**: `settings.json` path (reveal in file manager), app and Electron versions.
- Can be opened directly at a given section, for example from the popover.

### 4.5 Model management

Details: `docs/specs/model-management.md`.

- **Settings, "角色模型"**: a hint line ("双击模型卡片…"), a grouped library card (thumbnail grid, names and "当前" badges), an import / storage two-row card with progress, and a detail row below the grid with the selected model's info, "放大预览", "设为当前" and "删除" (disabled for the active model). The settings window has no inline preview. Double-clicking a card (or "放大预览") opens a standalone preview window (900x620, resizable): a large stage on the left and an inspector on the right (background white / dark / checker, zoom buttons and mouse wheel, motions grouped and played per file, expressions with reset, filterable part checkboxes), with "设为当前" and "删除" in its footer. Card thumbnails are captured automatically; a card shows a placeholder (⚠ plus the reason on failure) until then. A warning banner appears when Cubism Core is missing and links to "通用".
- **Settings, "通用"**: a Cubism Core row (status, upload / replace, reveal). Core is a runtime dependency, not a character asset, so it is not on the model page.
- **Popover**: a "角色模型" box under the header with a dropdown of models; the last entry opens the full window at the model section. The tray context menu has a "切换模型" radio submenu (the only switcher on Linux) and shows "设置向导…" while Core or a model is missing.
- **Wizard**: 欢迎 → Core → 模型 → 完成. Core and model can each be skipped ("稍后"); "完成" stays disabled until both exist. Opens automatically at startup when either is missing.
- **Avatar empty state**: a small card ("还没有角色", "去设置") replaces the red error page when nothing is installed; the error page is only for real load failures.

## 5. Later

- Running-application picker for application mode.
- Click-through lock toggle.
