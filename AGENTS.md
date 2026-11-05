# AGENTS.md

Guidance for AI coding agents working in this repository.

## Overview

Mayuka (repo name: live2d-mcp) is a desktop floating character built with Electron, PixiJS v8 and Live2D Cubism 5. Its mouth follows audio from other applications, and MCP lets an agent control expressions, motions, gaze and the character window. The prototype is [xikhar/persona](https://github.com/xikhar/persona) (VRM + three.js); we borrow ideas only and never copy its code.

Product boundary (SPEC §9): the app does not speak, does no TTS, and does not capture the microphone. Do not add `speak` or `lip_sync*` tools.

Docs: `SPEC.md` for product spec and decisions, `docs/ARCHITECTURE.md` for layering and channel details, `DESIGN.md` for settings UI design language and wireframes, `docs/specs/` for technical specs. Read ARCHITECTURE before changing any cross-process channel.

## Commands

Uses bun (`packageManager: bun@1.3.14`) and Node >= 20.

```bash
bun install
bun run dev                 # start Vite (5173) + Electron; alias of dev:electron
bun run build               # renderer (tsc + vite build) + electron syntax check
bun run test                # node --test: electron/test/**/*.test.cjs + renderer/test/**/*.test.ts
node --test electron/test/window-interactions.test.cjs                          # single test file
node --test --test-name-pattern='releaseMouseIgnore' electron/test/*.test.cjs   # filter by name
bun run build:native        # build the macOS native audio helper (native/macos)
bun run proof:f3|f4|f5|f6   # end-to-end proof scripts (lipsync / bridge / MCP / listener); the app must be launchable
```

- There is no lint script. `build:electron` only runs a syntax check over `electron/` and `electron/settings/`.
- Cubism Core (`renderer/public/live2dcubismcore.min.js`) and models are not in the repo. When missing, the window shows a guide instead of crashing; see README.
- The loopback bridge defaults to port 47832 and can be overridden with `LIVE2D_BRIDGE_PORT`. `.mcp.json` already points at `http://127.0.0.1:47832/mcp`.

## Architecture

Two process domains communicating over fixed IPC channels:

- **`electron/*.cjs` (main, CommonJS, no build step)**: `main.cjs` only bootstraps. The composition root is `companion-app.cjs` (`CompanionApp`), which wires up windows, tray, settings windows, the bridge, listeners and the window interaction controller.
- **`renderer/src/*.ts` (Vite + TS, ESM)**: `live2d-app.ts` owns the Pixi/Live2D model, `voice-state.ts` / `lip-sync.ts` implement the state machine and mouth sync, and `command-dispatcher.ts` executes visual commands sent down by MCP.

Data flows that span several files:

1. **Voice events**: bridge `POST /events`, test injection and the native listener all converge on `CompanionApp.dispatchVoiceEvent`. Payloads go through `normalizeVoiceEvent` in `voice-events.cjs` (authoritative validation, level clamped to [0,1]) and are then sent to the renderer on `live2d:voice`.
2. **MCP commands**: `bridge-server.cjs` mounts `/mcp` on the same port; `mcp-server.cjs` registers tools and validates input with zod. Visual tools go through `renderer-command-channel.cjs` as `live2d:command` to the renderer, where `command-dispatcher.ts` executes them and replies `{ok, data?, error?}`. With no model loaded they degrade to `isError`. The command type allowlist lives in `renderer-commands.cjs`; adding a command also requires updating preload.
3. **Window interaction**: `window-interactions.cjs` owns window move snapping (at least 80x40 px stays inside the work area), the source of truth for scale (0.5-1.75), mouse click-through, and a 33 ms global mouse poll. Click-through is split by platform: darwin/win32 use `selective` (passes `forward: true`); everything else uses `whole-window`, where the renderer receives no mouse events and the only way out is the tray item "reset window position" (`releaseMouseIgnore`).
4. **Listeners**: `voice-listener-manager.cjs` and `voice-source.cjs` pick the voice source; `native-process-audio-listener.cjs` drives the helper in `native/macos`. Only an in-memory RMS level is computed.

## Conventions and pitfalls

- **Preload cannot require local modules** (sandbox). `preload.cjs` and `settings-preload.cjs` inline channel names and some validation. When you change constants in `window-state.cjs` or `renderer-commands.cjs`, update them too; source-probe tests guard this.
- **Renderer tests load `.ts` directly via Node type-stripping.** Tested modules must not use parameter properties, enums or other runtime-only TS syntax, and imports need the `.ts` extension (see the comment in `command-dispatcher.ts`).
- **Two scale semantics coexist on purpose**: `sanitizeScale` (invalid falls back to default, for persisted data) and `normalizeScale` (invalid throws, for IPC input). Do not merge them.
- **Electron modules avoid requiring `electron` directly.** Dependencies are injected by the composition root, and tests use fake `ipcMain` / `BrowserWindow`. Follow the same injectable style for new code.
- Bridge write paths (`/events`, `/mcp`) check `Origin` and accept only trusted local origins. MCP sessions are reclaimed after 30 minutes idle, with a cap of 32.
- Write all new comments, docs and commit messages in English; commit format is `type(scope): message`. Existing Chinese comments are being translated gradually: translate the ones in code you touch, and do not do repo-wide rewrites in unrelated changes.
- `DESIGN.md` holds only design language, UI design, wireframes and user flows. Technical detail (architecture, IPC, view models, CSP, tests) belongs under `docs/specs/`.
