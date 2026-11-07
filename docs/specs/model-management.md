# Model management: technical spec

> Status: **implemented**. UI language, wireframes and flows live in `DESIGN.md` §4.5; this document keeps the technical detail. Decisions: settings layout A (grid + info drawer) with a standalone preview/inspector window (layout B), tray C1 (dropdown + context-menu submenu), onboarding D1 (wizard), hot swap, read-only preview page, no MCP model tools.
> Scope: settings window model page, tray popover, first-run wizard, model storage and loading. Voice, MCP and window interaction are unchanged.

## 1. Problem

| Today | Consequence |
|---|---|
| `MODEL_PATH = '/model/DeepSeek/大肥鱼.model3.json'` is hard-coded in `renderer/src/live2d-app.ts`; `model-config.ts` holds per-model motion names and physics drives | Switching models means editing code and rebuilding |
| Models and `live2dcubismcore.min.js` must be copied into `renderer/public/` by hand (git-ignored) | A fresh install shows the "model failed to load" page |
| No UI to inspect a model's motions or expressions | Users cannot tell what a model supports before using it |

## 2. Goals and non-goals

Goals

1. Import a model from a zip in the settings window and preview its motions, expressions and part visibility in a standalone preview window.
2. Switch the active model from settings; store imported models under `~/.mayuka/models`; remove the hard-coded path.
3. Switch models quickly from the tray popover.
4. Onboarding: on first run (no Cubism Core and/or no model) guide the user to upload both, instead of showing the error page.

Non-goals

- No model marketplace or download; no online search (SPEC FR-S3 stays out of scope).
- Mayuka does not bundle or redistribute Cubism Core or any model (licensing). The user supplies both.
- No editing of model files; no multi-avatar (one active model at a time).
- No `speak` / `lip_sync*` tools (SPEC §9 boundary is untouched).

## 3. Storage layout

```
~/.mayuka/
├─ core/
│  └─ live2dcubismcore.min.js        # user-supplied Cubism Core
└─ models/
   └─ <model-id>/                    # one directory per imported model
      ├─ mayuka-model.json           # our manifest (see 3.1)
      └─ ...                         # extracted files, original layout preserved
```

- `<model-id>`: slug of the `model3.json` base name plus a short hash, e.g. `hiyori_pro_t11-3fa9`. Re-importing the same zip creates a new id; the UI offers "replace" when the name matches.
- The root is `os.homedir()/.mayuka`, overridable with `MAYUKA_HOME` (needed for tests; follows the `LIVE2D_BRIDGE_PORT` convention).
- `settings.json` (userData, version bump to 2) gains `model: { activeId: string | null }`. Sanitize in `settings-store.cjs`; unknown or missing ids fall back to `null`. The model list is **derived by scanning `models/`**, not stored in settings, so manual copies and deletions stay consistent.

### 3.1 Manifest `mayuka-model.json` (written on import)

```json
{ "version": 1, "id": "hiyori_pro_t11-3fa9", "name": "Hiyori Pro",
  "entry": "hiyori_pro_t11.model3.json", "importedAt": "2026-11-06T00:00:00Z",
  "source": "hiyori-ok.zip", "bytes": 4479419, "cubism": "4",
  "motions": ["Idle", "Flick"], "expressions": ["default"], "parts": ["PartHair"] }
```

`motions` / `expressions` / `parts` are read from `model3.json`, `*.exp3.json` and `*.cdi3.json` at import time so lists and the tray popover render without loading the model.

### 3.2 Per-model overrides

`model-config.ts` (`HIT_AREA_MOTIONS`, `MOTION_NAMES`, `PHYSICS_INPUT_DRIVES`) is DeepSeek-specific. Move it to an optional `mayuka-model.json` field `overrides` with the same three keys; absent means empty tables (the file already documents that empty is the safe default). The built-in values for 大肥鱼 become a migration seed, applied only when importing a model whose entry name matches.

## 4. Import pipeline (main process)

New module `electron/model-library.cjs` (injectable `fs`, `now`, `homedir`, like other electron modules; no direct `require('electron')`).

| # | Step | Failure message (shown in UI) |
|---|---|---|
| 1 | Validate zip: size cap (default 512 MB), entry-count cap (5000), uncompressed-size cap (1 GB) | 不是有效的 zip 文件 / 文件过大 |
| 2 | Extract to a fresh temp dir **inside** `~/.mayuka/.tmp/`; reject absolute paths, `..` segments and symlinks (zip-slip); reject names that collide after normalization | 压缩包包含不安全的路径 |
| 3 | Locate exactly one `*.model3.json` (shallowest wins; several at the same depth is an error); parse; verify every file in `FileReferences` (moc, textures, physics, pose, motions, expressions) exists inside the model dir | 缺少 *.model3.json / 贴图 X 不存在 |
| 4 | Verify the `.moc3` header magic `MOC3` and version byte | 不是有效的 moc3 |
| 5 | Write manifest, then `rename` the temp dir to `models/<id>` (atomic on the same volume) | 安装失败 |

Any failure removes the temp dir; nothing partial is ever visible under `models/`. Stale temp dirs older than 1 hour are removed at startup. The extraction library must be a vetted dependency (candidate: `yauzl`) chosen in the implementation PR; we do not hand-roll zip parsing.

Cubism Core import: accept a `.js` file or an SDK zip. For a zip, look for `**/live2dcubismcore.min.js`. Validate by file size sanity and by evaluating nothing: check it contains the string `Live2DCubismCore`. Install to `~/.mayuka/core/` via temp file + rename. The Core version string is read with a regex on the file header comment and shown only if found.

## 5. Serving files to the renderer

Today `/model/...` resolves against `renderer/public`. Two new paths under the existing `live2d-app://` scheme (prod) and an equivalent Vite middleware or proxy (dev):

| URL | Maps to | Notes |
|---|---|---|
| `live2d-app://root/user-models/<id>/<path>` | `~/.mayuka/models/<id>/<path>` | `<id>` must match `^[a-z0-9_-]+$`; resolved path must stay inside the model dir (reuse the `resolveDistFile` containment check, generalized) |
| `live2d-app://root/user-core/live2dcubismcore.min.js` | `~/.mayuka/core/live2dcubismcore.min.js` | 404 when absent |

- `renderer/index.html` stops loading Core with a static `<script>`; `main.ts` first asks the main process whether Core is installed, then injects the script dynamically, then dynamic-imports the render core. This is already the order described in `main.ts` (dynamic import because the engine throws without Core).
- Settings windows have their own CSP (`default-src 'none'; img-src 'self' data:`). The preview runs in a sandboxed iframe (see 6.3) inside the preview window, and the settings page keeps one hidden capture iframe for thumbnails, so the only widening is `frame-src live2d-app://root` (plus the dev origin in dev) on both pages; neither page loads Core, models or WebGL itself. The preview page carries its own CSP allowing `user-core` / `user-models`.
- Keep legacy `/model/...` working in dev only, as a fallback when `activeId` is null and `renderer/public/model/` exists, so existing contributors are not broken. Remove after one release.

## 6. UI

Prototypes: `.temp/demos/`. Visual language follows `DESIGN.md` §2 (all four settings surfaces follow system light / dark appearance and share grouped-row controls).

### 6.1 Settings window: new section "角色模型" (`settings.model`)

Inserted in the TOC after "口型来源". Common elements (both layouts):

- Cubism Core is **not** on this page; it lives in the "通用" section (§6.1.1).
- **Model list** with a "使用中" pill on the active one.
- **Import**: drop target or file picker; progress shows the five pipeline steps; failure shows the message from §4 and states that nothing was written.
- **Hint line** above the grid: double-click a card to preview. Single click opens the info drawer.
- **Info drawer**: name, size and counts, "放大预览", "设为当前", "删除" (disabled for the active model). No inline preview.
- **Preview window**: see 6.3.
- Reveal in file manager.
- Manifest path and storage root displayed, with "在访达中显示".

Layout (decided): **A. Grid + drawer** (`a-library-grid.html`): card grid with an info drawer; the preview is a separate window. The master-detail alternative (`b-master-detail.html`) is dropped.

#### 6.1.1 Cubism Core in "通用"

Core is a runtime dependency, not a character asset, so it sits in the "通用" section: status light, version, path `~/.mayuka/core/`, "替换" and "在访达中显示". The model section shows only a warning banner linking to it when Core is missing.

### 6.2 Tray popover: "角色模型" block

Placed under the header (and permission banner, if shown), above the three tiles. Decided: **C1** current-model row with a dropdown list (`c-tray-switch.html`; the C2 thumbnail strip is dropped). Both end with an "import…" entry that opens the full window at the model section. The popover only switches; import, preview and delete live in the full window. "更多设置…" is unchanged.

The popover shows no thumbnails until generated: v1 renders a placeholder (first letter on a hue derived from the id). See open question 4.

Tray context menu (Linux fallback and right click) gains a "切换模型" submenu listing models, because Linux has no popover.

### 6.3 Preview (standalone window + read-only preview page)

Decided: previews live in their **own window** (layout B, inspector), not in the settings page, so any model can be inspected at a useful size without activating it. The avatar window is not touched.

- **Window**: `settings-windows.cjs` `openModelPreview(id)`, one instance (opening another model reloads it), 900x620, min 720x480, same sandboxed preload as the other settings windows. Page: `electron/settings/model-preview.html/css/js`, query `id` and `previewOrigin`. Opened by the `model-preview` settings action (double-click on a card, or "放大预览" in the drawer).
- **Stage**: a sandboxed `<iframe>` of `preview.html` (dev: Vite origin, prod: `live2d-app://root`). It reuses `live2d-app.ts` but not the bridge, voice state machine, lip-sync, click-through or window controls. Core is loaded from `/user-core/...`, with the dev-only `/live2dcubismcore.min.js` as fallback (mirrors the avatar's legacy fallback). If Core is missing the stage shows a message in place of a blank frame.
- **Inspector**: background (white / dark / checker), zoom (buttons, reset, wheel; 0.3x to 3x of the fit scale), motions grouped by group with one button per motion file, expressions plus reset, part checkboxes with a filter (names from the cdi3 file) and "show all". Footer: "设为当前" and "删除" (disabled for the active model).
- **Messages** (`postMessage`, source and origin checked, fixed schema). Window to page: `load`, `motion`, `expression`, `part`, `reset`, `zoom`, `snapshot`, `destroy`. Page to window: `ready`, `loaded` (motion files, expressions, parts), `zoom`, `snapshot`, `error`.
- The preview shows the model's own idle, physics and gaze; no voice input.
- **Lifecycle**: the iframe exists only while the window exists. On `pagehide` the window posts `destroy`, which stops the ticker, destroys the model and the Pixi app (releasing the WebGL context); closing the window frees the page and its copy of Core. Deleting the model closes the window.

**Thumbnails.** The settings page owns one hidden capture iframe (`.capture-frame`, one at a time). While Core is installed, it loads each model that has no thumbnail, waits briefly, asks the page for a `snapshot`, saves it through `live2d:model:save-thumb`, and destroys the iframe before the next one. The page renders one frame synchronously (`Live2DApp.renderNow()`), copies it into a 320x320 canvas and refuses to return an image with no drawn pixels (a blank capture is a failure, not a thumbnail). Failures (no Core, load error, 30 s timeout, blank) are remembered for the session and shown on the card (⚠ with a tooltip). The file is `thumb-v2.png`; earlier builds wrote `thumb.png`, which could be fully transparent, so the old name is ignored and those models regenerate.

**Costs accepted:** a second WebGL context and a second copy of Core while the preview window or a capture is alive; the avatar window keeps running.

"Set as current" then performs the hot swap in the avatar window (§7). Because preview state lives in the preview window, nothing needs restoring in the avatar when it closes.

### 6.4 Onboarding

Trigger: at startup, `CompanionApp` computes `readiness = { core: bool, model: bool }`.

- Both ready: normal startup.
- Either missing: open the onboarding window (or reuse the settings window in onboarding mode) and show the avatar window in **empty state** (§6.5). Never show the red error page for the "not installed" case; the error page remains for genuine load failures (corrupt model, WebGL failure).
- Reopenable from tray → "设置向导…" while anything is missing; hidden once both are ready.

Decided: **D1** step-by-step wizard (欢迎 → Core → 模型 → 完成; D2 checklist dropped). It has: Core and model each skippable ("稍后"), "完成" disabled until both are present, links to the Live2D SDK download page (opened with `shell.openExternal`, https only), and a note that files stay local.

### 6.5 Avatar window empty state

When `readiness` is incomplete the renderer shows a small card ("还没有角色" + "去设置" button) instead of the boot error. MCP visual tools keep returning `isError` with a message pointing at the cause (`no-model` vs `core-missing`) so agents can tell the user.

## 7. Switching the active model

Flow: UI → `live2d:settings:action { type: 'model.activate', id }` → main validates id exists and its manifest parses → persists `settings.model.activeId` → tells the avatar window to load.

- **Hot swap** in `live2d-app.ts` (decided). Sequence: load the new model first; on success remove the old one from the stage and destroy it (`destroy({ children: true, texture: true, textureSource: true })`), then fit, restart Idle, rebind lip-sync mouth parameters and reload per-model `overrides`.
- Consequences to handle: both models are briefly in memory; the old model must be fully released (verify with repeated-switch test); in-flight motions are dropped; commands and voice events arriving during a swap are queued or answered `busy`; per-model tables in `model-config.ts` become instance state, not module constants.
- Failure handling: if the new model fails to load, the old model is never removed, the renderer reports back, main reverts `activeId`, and the UI shows "切换失败,已恢复为 <name>".
- Window position, scale and click-through state are untouched (owned by `window-interactions.cjs`).

## 8. IPC and code touch points

Channel names live in `electron/model-channels.cjs`; `preload.cjs` and `settings-preload.cjs` inline the literals, guarded by `model-channels.test.cjs`. Activate / remove / reveal / open-wizard reuse the existing `live2d:settings:action` channel (whitelist in `settings-actions.cjs`).

| Channel | Direction | Purpose |
|---|---|---|
| `live2d:model:get-active` (invoke) | avatar → main | `{ id, name, coreUrl, modelUrl, overrides }` or `{ missing: 'core' \| 'model' }` |
| `live2d:model:changed` (send) | main → avatar | `{ requestId, active }`: load it (hot swap) |
| `live2d:model:load-result` (invoke) | avatar → main | `{ requestId, ok, error? }`; main rolls `activeId` back on failure or after a 30 s timeout |
| `live2d:model:import` (invoke) | settings → main | file path resolved in preload via `webUtils.getPathForFile`; returns `{ ok, id?, error?, step? }` |
| `live2d:model:progress` (send) | main → settings | `{ step, total, label }` |
| `live2d:core:import` (invoke) | settings → main | `.js` or SDK zip |
| `live2d:model:save-thumb` (invoke) | settings → main | PNG bytes (magic checked, <= 2 MB) written to `thumb-v2.png` |

Modules: `mayuka-paths.cjs` (home, `MAYUKA_HOME`), `model-library.cjs` (scan / import / remove, yauzl), `model-service.cjs` (activation, rollback, serialized swaps), `model-override-seeds.cjs` (per-entry seeds such as 大肥鱼), `user-assets.cjs` (URL to file mapping shared by the prod scheme handler and the dev Vite middleware). Renderer: `main.ts` (boot / swap flow, empty state), `live2d-app.ts` (`loadModel` / `unloadModel` / `destroy`), `preview.ts` + `preview.html` (preview page); `electron/settings/model-preview.*` (preview window). `settings.json` is version 2 (`model.activeId`).

Dev switches: `MAYUKA_HOME` relocates the library; `MAYUKA_NO_LEGACY=1` disables the dev-only `renderer/public` fallback so first-run flows can be exercised.

No MCP model tools are added (decided).

## 9. Security

- Imported files are untrusted: zip-slip and symlink rejection, size and count caps, extraction only into the app's temp dir, no execution of any imported content. Core is a `.js` file loaded into the avatar renderer by design; it is user-supplied, so show the file path and size in the confirmation, and never fetch Core from the network automatically.
- Scheme handler path containment per §5; model ids are slug-restricted.
- Bridge write paths (`/events`, `/mcp`) are unchanged; model import is IPC-only and not exposed on the loopback bridge.
- `openExternal` for the SDK page: fixed allowlisted URL, https only.

## 10. Testing

- Unit: `model-library`, `model-service`, `model-channels` (source probe), `renderer-protocol` containment, `settings-store` v2, `settings-actions`, `tray` (submenu), renderer `command-dispatcher`.
- Real-app verification (prod build, temp `MAYUKA_HOME`, CDP): wizard auto-opens when Core or model is missing; Core and model import through the native picker; failed imports leave nothing under `models/` or `.tmp/`; the preview window opens from a card double-click and lists motions, expressions and parts (toggling and per-motion playback were not clicked through), and missing thumbnails are generated with real pixels (checked on the PNG, 320x320); 10 alternating hot swaps keep the avatar loaded, lip-sync still writes `ParamMouthOpenY`, and MCP `get_model_info` still answers.
- Not covered by automation: tray popover dropdown and tray submenu clicks (menu-bar item is not reachable headlessly; logic is unit-tested).

## 11. Packaging

`yauzl` is pure JavaScript (no native module), so asar packaging is not a concern. The repository has no packager config yet.

## 12. Decisions on earlier open questions

1. Thumbnails: captured automatically in the background by a hidden preview iframe (`thumb-v2.png`); placeholder with reason otherwise.
2. 大肥鱼 in `renderer/public/model`: dev-only fallback, never auto-imported.
3. Core accepts a bare `.js` or an SDK zip.
4. MCP `list_models` / `set_model` are out of scope.
