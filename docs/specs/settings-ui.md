# Settings UI: technical spec (tray popover + full settings window)

Companion to [`DESIGN.md`](../../DESIGN.md), which covers design language, wireframes and user flows. This document covers how the settings surfaces are built.

> Scope: `electron/` main process, the settings preload and `electron/settings/` pages. The avatar renderer is out of scope.

## 1. Constraints

- The popover and the full window share one IPC surface, one view model and one push mechanism. Do not write a second copy.
- Click-through lock state lives inside the avatar renderer (`button-group.ts`); the main process has no source of truth for it, so there is no lock toggle in settings yet. A renderer command could expose it later.
- Application mode still takes `source_id` / `source_name` by hand. A running-process picker is a later item.
- The `settings.json` schema is unchanged (version 1).

## 2. Problems this design fixed

| Problem | Location |
|---|---|
| On macOS `setContextMenu` takes over the left click, so the icon could only open a menu | `electron/tray.cjs` |
| Status was prose only, with no good / bad distinction; missing permission was a footer line | `electron/settings/settings.html` |
| Avatar scale and position were persisted but not visible or editable in settings | `settings-view.cjs` did not send them |
| Only the Codex command could be copied | `SETTINGS_COPY_CHANNEL` |
| No level feedback after changing the voice source | none |

## 3. Behavior details

### 3.1 Tray

- macOS / Windows: left click toggles the popover, right click pops up the context menu.
- Linux: `setContextMenu` is used because AppIndicator does not dispatch click.

### 3.2 Popover window

- Frameless, width 340. Height follows content: the page reports it and the main process clamps it to 200–640.
- Position: horizontally centered on the tray icon. Below the icon when the tray is in the top half of the screen, above it otherwise. The result is clamped into the display `workArea`.
- Hides on blur. Pressing the tray icon first blurs (hiding the popover) and then clicks (which would reopen it). To avoid "click did not close it", a click within 250 ms after a blur-hide does not reopen the popover.
- Esc closes it.

### 3.3 Full window

- 860×640, minimum 720×520, system light / dark appearance via `prefers-color-scheme`. macOS uses `titleBarStyle: 'hiddenInset'` and the page draws a draggable title bar; other platforms use the system title bar.
- `openFull(section)` opens and scrolls to a section.
- Voice mode behavior: `automatic` / `external` save immediately from the popover; `application` / `custom` switch immediately when the saved fields exist, otherwise open the full window at the voice section.

## 4. Architecture

```
Tray ──click──▶ SettingsWindows.togglePopover(trayBounds)
                     │
          ┌──────────┴───────────┐
     popover.html            settings.html
          └─── settings-preload.cjs (one narrow API) ───┘
                     │ IPC
              CompanionApp (composition root)
     settingsViewModel() · handleSettingsAction() · dispatchVoiceEvent → pushLevel
```

### 4.1 Modules

| Module | Responsibility | Dependencies |
|---|---|---|
| `electron/settings-windows.cjs` | Create and position both windows, hide on blur, broadcast view and level (level throttled to about 20 Hz) | Injected `BrowserWindow`, `screen` |
| `electron/settings-actions.cjs` | Allowlist validation of action payloads, pure functions | none |
| `electron/settings-channels.cjs` | Channel constants, including `action` and `level` | none |
| `electron/settings-preload.cjs` | Narrow API shared by both windows | sandbox |
| `electron/settings-view.cjs` | View model: Claude Code command, permission derivation, avatar state, versions, login item | `bridge-endpoint.cjs` |
| `electron/tray.cjs` | Left-click callback receives tray bounds; right click pops up the menu | Injected |
| `electron/companion-app.cjs` | Wiring, action execution, level interception in `dispatchVoiceEvent` | |
| `electron/settings/` | Four HTML pages with page-specific CSS and scripts, `shared.js` (copy and formatting), and `tokens.css` (shared palette, base styles and controls) | |

Pure computation lives in functions that `node:test` can call directly: `computePopoverPosition`, `parseSettingsAction`, `derivePermission`, `buildSettingsViewModel`.

### 4.2 IPC

| Channel | Direction | Notes |
|---|---|---|
| `live2d:settings:get` | invoke | Get the view model |
| `live2d:settings:save` | invoke | Save `voiceSource` |
| `live2d:settings:copy-command` | invoke | `kind`: `codex` (default), `claude`, `url` |
| `live2d:settings:changed` | main → page | View model push, broadcast to both windows |
| `live2d:settings:action` | invoke | `{ type, ... }`, allowlist below |
| `live2d:settings:level` | main → page | Live level, number in 0–1, sent only to visible windows |

Action allowlist:

| type | Params | Behavior |
|---|---|---|
| `avatar-show` / `avatar-hide` / `avatar-reset` | none | `showAvatarWindow` / `hideAvatarWindow` / `resetAvatarWindow` |
| `set-scale` | `scale: number` | `normalizeScale`, notify renderer, persist |
| `open-full` | `section?: 'voice' \| 'mcp' \| 'avatar' \| 'general' \| 'diag'` | Open the full window and hide the popover |
| `close-popover` | none | Hide the popover |
| `fit-popover` | `height: number` | Resize the popover to its content |
| `open-permission-settings` | none | Open the system "Screen & System Audio Recording" page (darwin only) |
| `reveal-settings-file` | none | Reveal `settings.json` in the file manager |
| `reveal-models-dir` | none | Open the models directory |
| `reveal-core` | none | Reveal the installed Cubism Core (or the home directory when missing) |
| `open-wizard` | none | Open the first-run wizard |
| `model-activate` | `id` | Hot-swap the active model (see `model-management.md`) |
| `model-remove` | `id` | Delete a non-active model |
| `set-login-item` | `enabled: boolean` | `app.setLoginItemSettings` (darwin / win32 only) |
| `quit` | none | Quit the app |

Security:

- The sender must be one of the two settings windows (`isWindowSender`).
- Payloads go through `parseSettingsAction` first; invalid payloads return `{ ok: false, error }`.
- The preload exposes no arbitrary IPC. Channel literals are inlined there, and `settings-channels.test.cjs` reads the source text to prevent drift.
- The only external URLs are fixed system-settings deep links; pages cannot supply a URL.

### 4.3 View model (new fields)

```js
{
  // existing: mcpUrl, codexCommand, voiceSource, listener,
  //           environmentOverridesVoice, bridgeListening, effectiveVoiceSource, message
  claudeCommand: 'claude mcp add --transport http live2d http://127.0.0.1:47832/mcp',
  port: 47832,
  permission: 'granted' | 'denied' | 'not-required' | 'unknown',
  avatar: { visible: true, x, y, width, height, scale },
  loginItem: { supported: true, openAtLogin: false },
  settingsFilePath: '…/settings.json',
  versions: { app: '0.1.0', electron: '39.8.10' },
}
```

Permission derivation: `permission-denied` → `denied`; `running` or `idle` → `granted`; `disabled` → `not-required`; anything else → `unknown`.

### 4.4 Push timing

- `notifySettingsChanged` broadcasts to both windows. New call sites: avatar show / hide / reset, scale change, login item change. Avatar drags and gesture scaling push only while a settings window is visible, to avoid sending IPC while dragging.
- Level: after `dispatchVoiceEvent` delivers an `audio-level`, it calls `settingsWindows.pushLevel(level)`, at most once per 50 ms and only when a settings window is visible.

### 4.5 CSP

All four pages keep `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:`. Each loads `tokens.css` followed by its own stylesheet using local `<link>` elements, which `style-src 'self'` permits. There are no external requests or inline script / style blocks. Settings and model preview additionally retain `frame-src live2d-app://root http://127.0.0.1:5173` for the existing preview / thumbnail frames. Runtime meter dimensions and thumbnail backgrounds continue to be assigned through DOM style properties.


### 4.6 Page structure and shared styling

- `tokens.css` owns light / dark custom properties, typography, radii, base controls, focus-visible rings and reduced-motion rules. The four page stylesheets own their layout; none imports another page's stylesheet.
- `settings.html` uses a three-row grid (title, status, scroll area), with the sidebar spanning the rows. `#content` remains the only scrolling content container and `#toc a` retains its six anchor targets: `voice`, `mcp`, `model`, `avatar`, `general`, `diag`.
- Existing action / form ids remain intact. New presentation ids are `model-count`, `model-empty`, `model-pick`, `models-path`, `core-status`, `core-led`, `core-path`, and the six section heading ids. The import file input sits outside `#dropzone`; `#model-pick` opens that same input. The model drawer is now a detail row inside the library card, with its existing close action retained.
- Model buttons keep `aria-current` for the active model, add `aria-pressed` for the selected detail row, and render a separate current-model badge. Counts and storage paths come from the existing library view (`root`, `core.path`, `models`); no new IPC or view-model fields are required. TOC selection also updates `aria-current="location"`.
- `wizard.html` loads only `tokens.css` and `wizard.css`, using its own title bar, progress list, card body and footer. Existing `data-pane` / `data-step` hooks and navigation / import ids remain; the script updates progress-number decoration and `aria-current="step"`. Window dimensions and readiness rules are unchanged.
- `model-preview.html` moves `#bg` and the zoom controls to the stage toolbar and `#meta` to the title bar. Motion, expression and part containers keep their ids and data. The initial dark stage, white / dark / checker values and all postMessage payloads are unchanged; background buttons expose `aria-pressed`.
- `popover.css` uses the shared tokens while keeping transparent document backgrounds and a translucent macOS canvas so native vibrancy remains visible. Its DOM actions, resize reporting and mode-switch behavior are unchanged.
- The native `BrowserWindow` background colors remain unchanged by this presentation refactor; the loaded pages paint their own themed backgrounds.

## 5. Tests

- `tray.test.cjs`: left click callback carries bounds; darwin / win32 right click pops up the menu without calling `setContextMenu`; linux calls `setContextMenu`.
- `settings-actions.test.cjs`: allowlist, parameter validation, rejection of invalid payloads.
- `settings-windows.test.cjs`: `computePopoverPosition` for menu bar on top, taskbar at the bottom and edge clamping into `workArea`; with a fake `BrowserWindow`, click suppression after blur-hide and level throttling.
- `settings-view.test.cjs`: Claude command and permission derivation.
- `settings-channels.test.cjs`: preload inline copy compared against the new channels.
- Manual: after `bun run dev`, click the tray icon, switch modes, drag the scale slider, open the full window, copy a command.
