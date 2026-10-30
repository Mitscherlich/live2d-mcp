# Live2D Desktop Companion · 架构说明

| 字段 | 内容 |
|------|------|
| 状态 | ADR 0001 F1–F7 已落地；Electron 一体化为默认运行路径 |
| 权威规格 | [`SPEC.md`](../SPEC.md)（§5 架构、§6 需求、§9 TTS 移除范围） |
| 实现计划 | [`.adr/0001-electron-live2d-companion/plan.md`](../.adr/0001-electron-live2d-companion/plan.md)（切片 F1–F7） |
| 参考实现（只读） | `/Users/mitscherlich/f/persona`（MIT；分层与契约借鉴，**禁止修改**，不引入其 VRM/Three 渲染栈） |

> 本文描述当前已落地架构：F1–F7 的 TTS 清除、Electron 壳、voice 口型、loopback bridge、Streamable HTTP MCP、macOS process-audio listener、系统托盘与最小设置均已实现。旧独立 `mcp-server` + 浏览器双进程流程已整体删除。

---

## 1. 落地现状与架构图

### 1.1 默认现状（F7 完成后的 Electron 一体化）

```
Agent (Codex / Claude Code / …)
    │  Streamable HTTP MCP /mcp
    ▼
Electron main (:47832 loopback)
    ├── bridge /health + /events
    ├── voice listener + settings store
    ├── tray / window lifecycle
    └── sandboxed preload → Live2D renderer
```

- 包管理与脚本入口为 **Bun**（`packageManager: bun@…`，锁文件 `bun.lock`）。安装用 `bun install`，任务用 `bun run …`。测试请用 `bun run test`（`node:test` 套件）；勿用裸 `bun test`（会进 Bun 内置测试器）。Electron 与 `node --check` / `node --test` 仍走 Node 兼容运行时。
- `bun run dev` / `bun start` 均进入 Electron；托盘关闭角色窗时保活 bridge 与 renderer。
- 设置窗展示实际 MCP URL，并将 voice source 与角色窗状态原子写入 `userData/settings.json`；无环境覆盖时热更新 listener。角色窗启动恢复位置/大小/缩放，恢复位置应用 80×40px 可见 snap。
- 旧双进程形态（独立 `mcp-server` + 浏览器 renderer）已删除，Electron 一体化是唯一路径。

### 1.2 当前架构（Electron 一体化）

```
┌─────────────────────────────────────────────────────────────┐
│  Codex / Claude Code / Hermes / 其他 MCP client             │
└───────────────┬─────────────────────────────┬───────────────┘
                │ MCP /mcp                    │ POST /events
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Electron Main（CompanionApp 组合根）                        │
│  · 窗口 / TrayController / 设置窗生命周期                    │
│  · BridgeService：bridge-server (loopback HTTP)             │
│    + McpSessionManager (Streamable HTTP)                    │
│  · VoiceListenerManager（macOS 进程输出 tap；external 可空） │
│  · SettingsStore（voice source / 窗口状态）                  │
└───────────────┬─────────────────────────────────────────────┘
                │ 沙箱 preload（规范化事件 + 窄 API）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Renderer（Live2D）                                         │
│  · pixi.js v8 + untitled-pixi-live2d-engine（Live2DApp）     │
│  · VoiceController：amplitude lip-sync → ParamMouthOpenY     │
│    （或等效嘴参）+ idle/listening/speaking 体态              │
│  · CommandDispatcher：表情/动作/参数/视线命令执行            │
│  · MouseFollow / WindowControls / ClickInteraction          │
└─────────────────────────────────────────────────────────────┘
```

**安全边界**：renderer 不得拥有文件系统、原始音频、进程枚举权限。

---

## 2. 四层职责（对齐 persona，渲染层换 Live2D）

| 层 | 职责 | 关键约束 |
|----|------|----------|
| ① Native listener | 发现受支持的语音进程（macOS 进程输出 tap），在内存中计算归一化输出电平 `level∈[0,1]` | 不采麦克风；音频样本仅用于算 level，**不落盘、不上传**；external 模式下该层可整体为空 |
| ② Electron main | 应用生命周期：窗口、托盘、设置；承载 loopback bridge、Streamable HTTP MCP、voice source 解析 | 唯一拥有 OS 能力的层；MCP 工具调用被翻译为窄的主进程回调 |
| ③ 沙箱 preload | 只暴露规范化事件（state / level）与窄设置 API | 不暴露文件系统、任意 IPC、原始音频 |
| ④ Renderer（Live2D） | 渲染 Cubism 模型；电平驱动口型；idle/listening/speaking 状态行为；执行表情/动作/参数命令 | 无任何特权；嘴参映射 `ParamMouthOpenY`（或等效） |

### 与 persona 的映射

| persona | 本仓库（目标） | 差异 |
|---------|----------------|------|
| Native listener（进程输出 → level） | `native/` + `electron/audio-listener.*` | 契约一致；macOS 优先（Core Audio process tap），linux/win 预留 |
| Electron main（lifecycle + bridge + MCP + settings） | `electron/main.*` + `bridge-server.*` + `mcp-server.*` + `settings-store.*` | 职责一致；bridge 默认端口 **47832**（避开 persona 47831） |
| 沙箱 preload（规范化事件窄桥） | `electron/preload.cjs` | 思路一致 |
| React + Three.js / VRM 渲染 | **pixi.js v8 + untitled-pixi-live2d-engine（Live2D Cubism 5 Framework，兼容 Cubism 3/4/5 模型）** | **核心差异**：不引入 VRM/Three 角色管线；口型映射到 `ParamMouthOpenY` |
| MCP 工具面（window/status/animation） | status/window/model-info/expression/motion（+ 可选 look_at/parameter/reset） | 工具名按 Live2D 语义设计，server 名使用 live2d 系 |

---

## 3. 本机集成面（bridge，F4/F5 已落地）

默认监听 **`127.0.0.1:47832`**，环境变量 `LIVE2D_BRIDGE_PORT` 可覆盖端口（host 永远 loopback：bind host 在 `createBridgeServer` 模块边界强制，非 loopback 直接抛错）。仅 loopback；Host 头必须解析为 `127.0.0.1` / `localhost` / `[::1]`，非本机 Host 一律 403（DNS rebinding 防线，对全部路由生效）；Origin 头作用于写路径（`/events` 与 `/mcp`）：存在时仅受信本机 origin（`http(s)://loopback[:port]`）放行，其余 403；无 Origin（curl 等）放行。`/health` 只读且不含用户内容，不校验 Origin（浏览器跨源也读不到响应——无 CORS 放行头）。

| 接口 | 方法 | 状态 | 说明 |
|------|------|------|------|
| `/health` | GET | **F4/F6 已落地** | 200 JSON：`ok` / `bridgePort` / `voice` 摘要（phase、activity、lastLevel、接受/拒绝计数）/ `windowVisible` / `voiceInject` / `listener`（F6 起为真实 source/status，见 §4.1）/ `mcp`（F5 起 `implemented:true` + 实际 `url`）。`/health` 不做 renderer 往返，因此不报告模型就绪状态；模型真实状态用 MCP `get_status`（见 §5）。**不含用户内容** |
| `/events` | POST | **F4 已落地** | JSON：`state`（SPEC §8.1）/ `audio-level`（§8.2，level clamp `[0,1]`）。body 上限 64KB；过 `electron/voice-events.cjs` 权威规范化（与 F3 注入同一份校验）后调 `sendVoiceEvent` 推送到 renderer。202 `{"accepted":true}`；非法 JSON 400 / 非法事件 422 / 超限 413 |
| `/mcp` | POST/GET/DELETE | **F5 已落地** | Streamable HTTP MCP（`electron/mcp-server.cjs`，`@modelcontextprotocol/sdk`，server 名 `live2d-companion`）。工具面见 §5。每 `initialize` 一个 session（`mcp-session-id` 头，`enableJsonResponse`）；无 session 的非 initialize POST → 400 `-32000`；body 复用 64KB 上限，坏 JSON → 400 `-32700`；其他方法 → 405。`mcpHandler` 是 `createBridgeServer` 的必填参数（缺失即构造期抛错，无运行时占位分支）。session 生命周期：每次请求刷新 `lastSeenAt`，新建 session 时清扫空闲超过 30 分钟者并在总数达 32 时驱逐最久未活动者 —— `enableJsonResponse` 没有 SSE 长连可感知断线，客户端被 SIGKILL 时不会发 DELETE，只能靠空闲超时兜底 |

实现：`electron/bridge-server.cjs`（纯 `node:http`，无 Electron 依赖、也不加载 MCP SDK，`node:test` 直测）+ `electron/mcp-server.cjs`（MCP 协议与工具面，controller 由 main 注入）+ `electron/mcp-protocol.cjs`（零第三方依赖的协议常量层：`MCP_PATH`、`sendJsonRpcError`、JSON-RPC 错误码 `-32700`/`-32603`/`-32000`）。`MCP_PATH` 与 `sendJsonRpcError` 以 `mcp-protocol.cjs` 为**唯一出口**，`mcp-server.cjs` 只消费不转出；HTTP 层与设置视图层（`settings-view.cjs` 仅为拼 MCP URL 需要 `MCP_PATH`）因此都不必把 `@modelcontextprotocol/sdk` + `zod` 拉进模块图。main 在 `app.whenReady` 后 `listen`、`will-quit` 时 `close`（`electron/main.cjs` `startBridge()`）。监听失败（如端口占用）不杀应用，打印清晰日志提示用 `LIVE2D_BRIDGE_PORT` 换端口。

curl 示例（应用运行中）：

```bash
curl -s http://127.0.0.1:47832/health
# → {"ok":true,"bridgePort":47832,"voice":{...},"windowVisible":true,...}

curl -s -X POST http://127.0.0.1:47832/events \
  -H 'content-type: application/json' \
  -d '{"type":"state","state":{"phase":"active","activity":"speaking","microphoneMuted":false,"outputMuted":false}}'
# → 202 {"accepted":true}

curl -s -X POST http://127.0.0.1:47832/events \
  -H 'content-type: application/json' \
  -d '{"type":"audio-level","level":0.8}'
# → 202 {"accepted":true}；renderer 口型目标随 level 驱动（证据：scripts/f4-bridge-proof.mjs）
```

端到端证据：`bun run proof:f4`（默认 HTTP 层：curl → bridge → onEvent 与权威规范化同源；`--e2e` 追加真 Electron + curl 注入 + CDP 快照断言口型变化）。

MCP 连接示例（F5 已生效，应用运行中）：

```bash
codex mcp add live2d --url http://127.0.0.1:47832/mcp
```

Claude Code / Hermes 使用同一 URL（按其 MCP 配置格式，SPEC §8.4）。
MCP 端到端证据：`bun run proof:f5`（默认 HTTP 层：官方 SDK client → tools/list + read/write 调用 + 非法参数拒绝 + 缺模降级；`--e2e` 追加真 Electron：control_window 真实作用窗口、set_expression 经 CDP 快照坐实抵达 renderer）。

---

## 4. 口型契约与状态机

### 4.1 Listener 契约（所有 voice source 统一）

- `onSession(active: boolean)`
- `onLevel(level: number)`，`0 ≤ level ≤ 1`
- `onStatus(diagnostics)`

listener 不产出 activity：`listening ⇄ speaking` 由 renderer 的 `VoiceStateMachine` 从同一条 level 流推导（阈值 0.018、静音保持 900ms）。`state.activity` 仍是 `/events` 的合法注入字段（外部编排方可显式驱动），由 `voice-events.cjs` 规范化后进入同一条链路。

静音期的连续 0 由 listener 抑制：非零 level 逐条转发，静音后的第一条 0 必须送达（renderer 靠它起算 900ms 静音保持），此后连续 0 全部丢弃直到再次出现非零 —— helper 以 30Hz 无条件推 level，否则整条链路都在搬运 0。

进程发现按捕获状态分档：未捕获时每 1.5s 一次 `ps` 快照；已捕获后降到 12s 一次（捕获期的发现结果本就被捕获 key 早退丢弃，helper 退出/错误是事件驱动上报的）。`application` 模式只跑 `ps -axo pid=,ppid=,comm=` 一次（该模式按 executable identity 精确匹配，不读命令行）；`automatic`/`custom` 额外取 `pid=,args=`，因为 CLI 启动的 codex 其 comm 只是 `node`。

voice source 四模式：`automatic`（默认匹配 codex/chatgpt 类进程名，regex 可配置）/ `application` / `custom`（自定义 regex）/ `external`（关闭进程捕获，仅消费 `/events`）。

F6 实现链路：`electron/main.cjs` 启动时用 `resolveVoiceSourceConfig` 解析配置，通过 `createAudioListener` 决定是否创建 `NativeProcessAudioListener`；native 的 `onSession` / `onLevel` 全部转换成 `state` / `audio-level` 并进入同一个 `sendVoiceEvent`，与 `/events` 不存在旁路。应用 `will-quit` 时先 `stop()` listener。`/health.listener` 与 MCP `get_status.listener` 都由 `buildListenerSummary` 从最近 native 状态构造。

| mode | 目标选择 | native 行为 |
|------|----------|-------------|
| `automatic` | 默认正则匹配 codex / chatgpt / openai 类进程；可由 env 覆盖 | macOS 启动 process tap helper |
| `application` | `source_id=process:darwin:<base64url executable>` 精确匹配，配套 `source_name` | macOS 启动 helper；F7 设置窗提供必要字段 |
| `custom` | 用户提供合法进程正则 | macOS 启动 helper |
| `external` | 不枚举、不捕获进程 | listener 为 `disabled`，仅 `/events` 驱动 |

运行期环境变量：

| 变量 | 说明 |
|------|------|
| `LIVE2D_VOICE_SOURCE_MODE` | `automatic` / `application` / `custom` / `external`；默认 `automatic` |
| `LIVE2D_TARGET_PROCESS_PATTERN` | automatic 覆盖或 custom 正则（最多 200 字符，非法时告警并安全回退） |
| `LIVE2D_VOICE_SOURCE_ID` / `LIVE2D_VOICE_SOURCE_NAME` | application 模式目标 |
| `LIVE2D_NATIVE_HELPER_PATH` | native helper 绝对路径覆盖（开发/排障） |
| `LIVE2D_LISTENER_DEBUG=1` | 输出 helper 协议排障日志；不输出音频内容 |

公开 listener 状态封闭为：`disabled`（external）、`starting`、`idle`、`running`、`permission-denied`、`unavailable`、`error`。helper 缺失明确为 `unavailable/helper-missing`；Core Audio tap 创建失败且 TCC preflight 未授权时为 `permission-denied/tap-create-failed`，并提示「屏幕与系统音频录制」权限及 external 降级方式。仅缺权限或 native 不可用不会影响 bridge `/events`。

macOS helper 源码为 `native/macos/Live2dAudioListener.mm`，只在 Core Audio 回调内计算归一化峰值并通过 NDJSON 输出 level，原始样本不落盘、不上传，也不采麦克风。运行 `bun run build:native` 生成 universal `native/bin/darwin/live2d-audio-listener` 并执行 `--self-test`；应用开发态默认从该路径加载，打包态从 resources 下的 `native/darwin/` 加载。

产品级证据：`bun run proof:f6` 启动真实 Electron，分别验证 external 的 `/health` + MCP status、native sentinel 未启动、`/events` 到 renderer 口型，以及 automatic helper 缺失时的同源 `unavailable/helper-missing` 状态。

### 4.2 渲染侧行为

- **嘴型**：每个动画帧按当前 `level` 与 `activity === speaking` 平滑驱动嘴参（思想对齐 persona `useAmplitudeLipSync`，映射到 Live2D `ParamMouthOpenY`）。
- **状态**：`idle` / `listening` / `speaking`；短静音（默认 **900ms**，可配置常量）内保持 speaking，避免句间抖动切回 idle。
- **优先级**：MCP 触发的 `play_motion` / `set_expression` 可临时优先于 voice 驱动的身体动作；口型 level 驱动不被打断。

### 4.3 Voice 事件通道（F3 落地）

| 环节 | 位置 | 说明 |
|------|------|------|
| 权威规范化 | `electron/voice-events.cjs` | `normalizeVoiceEvent`：白名单字段、level clamp `[0,1]`、phase/activity 枚举校验；非法负载丢弃（NFR-3，有单测） |
| main → renderer | IPC `live2d:voice` | `sendVoiceEvent(win, raw)`（`electron/main.cjs`）；F4 bridge `/events` 的 onEvent 即调用此函数（§3） |
| preload 窄 API | `electron/preload.cjs` | `window.live2d.onVoiceEvent(cb)`（浅校验 type 白名单后转发，返回取消订阅）；不暴露任意 IPC |
| renderer 消费 | `renderer/src/main.ts` → `lip-sync.ts` → `voice-state.ts` | 状态机 + 平滑 + 嘴参解析（`ParamMouthOpenY` 或别名，缺模型/缺参 no-op）；PIXI ticker LOW 优先级写入（motion 之后、当帧渲染生效） |

**测试注入（仅开发/测试）**：以 `LIVE2D_VOICE_INJECT=1`（或 CLI `--live2d-voice-inject`）启动 main 时，preload 经 `additionalArguments` 检测标志后额外暴露 `window.live2d.injectVoice(payload)`；该调用经 IPC `live2d:voice-inject` 回到 main，**过同一 `normalizeVoiceEvent`** 后再经 `live2d:voice` 送回 renderer——注入与真实推送走完全相同的 renderer 路径。未开标志时 `injectVoice` 不存在（生产无注入面）。调试快照 `window.__live2dVoiceDebug.snapshot()`（activity / smoothedMouth / mouthWrites / events 等）供脚本断言，证据脚本：`scripts/f3-lipsync-proof.mjs`（`bun run proof:f3`，`--e2e` 走 CDP 端到端）。

### 4.4 命令通道（F5 落地，MCP 视觉工具执行路径）

| 环节 | 位置 | 说明 |
|------|------|------|
| 帧协议常量/校验 | `electron/renderer-commands.cjs` | type 白名单（`getModelInfo` / `setExpression` / `playMotion` / `lookAt` / `setParameter` / `reset`）、命令帧形状校验、结果帧规范化（纯函数，无状态，有单测） |
| 请求-响应关联器 | `electron/renderer-command-channel.cjs` | `createRendererCommandChannel({ ipcMain, getWindow, timeoutMs })` → `{ send, isReady, handleWindowClosed, dispose }`。持有 `requestId` 生成、挂起表、超时兜底、结果帧配对、ready 标志、窗口销毁冲销、IPC sender 校验（只认当前角色窗的 `webContents`）。Electron 只经 `ipcMain` 与 `getWindow` 两个注入点进来，故 fake 双件即可单测全部路径 |
| main → renderer | IPC `live2d:command` | `sendRendererCommand(type, params)`（`electron/main.cjs`）转调上面的 `send`：携带 `requestId`，等待结果帧（超时 2s，窗口销毁立即失败）；所有失败 resolve 为 `{ ok:false, error }`，MCP 工具层转 isError |
| renderer → main | IPC `live2d:command-result` / `live2d:command-ready` | preload 注册 `onCommand` 即发 ready 帧；结果帧过 `normalizeCommandResultFrame` 防御性校验后按 `requestId` 配对（两个监听随通道创建自注册，`dispose()` 摘除） |
| preload 窄 API | `electron/preload.cjs` | `window.live2d.onCommand(handler)`（帧形状浅校验 + handler 异常兜底；sandbox 限制下内联常量，与 renderer-commands.cjs 同步） |
| renderer 执行 | `renderer/src/main.ts` `initCommandChannel` | 映射到 `Live2DApp`（表情/动作/视线/参数/重置/模型信息）；**无模型时 `{ ok:false, error }` 清晰降级不崩溃**；调试快照 `window.__live2dCommandDebug.snapshot()`（counts / lastCommand / modelLoaded）供 proof 断言 |

MCP 工具（§5）→ controller（main）→ 本通道 → renderer：链路证据 `bun run proof:f5 -- --e2e`（CDP 计数坐实命令抵达 renderer；非法参数在 MCP zod 层被拒、不进 renderer）。

### 4.5 托盘与设置生命周期（F7 落地）

- `electron/icons.cjs` 统一解析随应用分发的 `electron/assets/icons/` B6 图标资源：macOS Dock 用应用 PNG，窗口在 Windows 用 ICO、其他平台用 PNG；托盘在 macOS 用 18 pt Template + @2x，在 Windows 用多尺寸彩色 ICO，其他平台用彩色 PNG，保留各自 DPI 表示。
- `electron/tray.cjs` 用上述正式资源创建托盘（macOS 标记为 template image），菜单动作固定为显示角色窗、隐藏角色窗、重置窗口位置、打开设置、退出；不依赖 persona 或模型资源。macOS / Windows 左键开关快捷弹窗、右键弹该菜单（不 `setContextMenu`，否则 macOS 左键被菜单接管）；Linux 托盘不派发 click，沿用 `setContextMenu`。
- 「把角色窗露出来」只有一处实现：`electron/main.cjs` 的 `showAvatarWindow()`（必要时建窗 → 最小化则 `restore()` → `show()` → `focus()`）。托盘显示/托盘点击、macOS dock `activate`、第二实例唤起、MCP `control_window show|toggle` 全部走它；`windowAction()` 退化为 MCP 适配层，只负责把 show/hide/toggle 翻译成显示或隐藏并返回操作后的可见性。
- 有可用托盘时，角色窗 `close` 转为 `hide`，`window-all-closed` 不退出；托盘“退出”设置 quitting 状态后走 Electron 正常退出清理 bridge、MCP handler 与 listener。
- `electron/settings-store.cjs` 将 `{ version, voiceSource, window: { x, y, width, height, scale } }` 保存到 Electron `userData/settings.json`。候选值先经过 `sanitizeVoiceSource` 与窗口状态范围校验，再以同目录临时文件 + rename 原子发布；非法输入不会破坏上一份配置。
- 设置界面分两层（设计见仓库根 `DESIGN.md`）：托盘快捷弹窗 `settings/popover.html`（无边框，贴托盘定位，失焦隐藏）与完整设置窗 `settings/settings.html`（状态条 + 锚点目录）。两窗由 `electron/settings-windows.cjs` 的 `SettingsWindows` 管理，共用同一 sandbox preload：读取/保存设置、按 `codex|claude|url` 复制命令、经 `live2d:settings:action` 发白名单 action（`settings-actions.cjs` 校验），并订阅 view 与实时电平（`dispatchVoiceEvent` 截取，仅推可见窗口、节流 50ms）。renderer 无文件系统、clipboard 或任意 IPC 权限；外部跳转只有固定的系统设置 deep link。
- 设置窗的 MCP URL 优先取 bridge 实际监听端口，尚未监听时按 `LIVE2D_BRIDGE_PORT`（非法值回退 47832）展示。voice 保存后立即重启 listener；显式 `LIVE2D_*` 环境覆盖仍优先，UI 会提示需移除覆盖并重启。

---

## 5. MCP 工具面（F5 已落地）

挂载：bridge 同端口 `/mcp`（默认 `http://127.0.0.1:47832/mcp`，SPEC §8.4），实现 `electron/mcp-server.cjs`（server 名 `live2d-companion`）；工具回调经 main controller → §4.4 命令通道转发 renderer（窗口控制由 main 自完成）。入参由 zod schema 校验，非法输入在 MCP 层以 isError 拒绝（不进 renderer）；模型未加载时视觉工具返回 `success:false` 清晰降级，不崩溃。

| 工具 | 读写 | 说明 |
|------|------|------|
| `get_status` | 只读 | 窗口可见性、bridge 端口/URL、voice 摘要（phase/activity/lastLevel/计数，与 `/health` 同源）、listener 真实模式/状态（F6，见 §4.1）、mcp 端点、模型就绪（renderer 往返真值：`ready:true/false`，通道未挂接为 `null`）；不含用户内容 |
| `control_window` | 写 | `show` \| `hide` \| `toggle`（hide 不退出应用；窗口已关闭时 show/toggle 会重建） |
| `get_model_info` | 只读 | 表情 / 动作组 / 参数列表（renderer 往返；无模型清晰错误） |
| `set_expression` | 写 | 表情名 |
| `play_motion` | 写 | group + 可选 index/priority（index 省略随机、priority 默认 2） |
| `look_at` | 写 | x/y ∈ [-1,1]（低成本保留） |
| `set_parameter` | 写 | param_id + value（低成本保留） |
| `reset` | 写 | 默认表情 + Idle + 视线归中（低成本保留） |

Server instructions 已声明：本应用**不说话、不播放 agent 音频**、无任何 TTS/语音工具，仅提供视觉表现与窗口控制（SPEC §6.4 强制项）。**禁止工具** `speak` / `lip_sync*` / TTS 封装未注册、不可发现（proof 与单测均含否定断言）。

调用证据：`bun run proof:f5`（HTTP 层）与 `node scripts/f5-mcp-proof.mjs --e2e`（真 Electron：tools/list、get_status、control_window 真实作用于窗口、set_expression 经 CDP 坐实抵达 renderer）。

---

## 6. 目标目录结构

```text
live2d-mcp/
├── SPEC.md
├── docs/ARCHITECTURE.md
├── package.json                 # electron + workspaces 脚本
├── electron/
│   ├── main.cjs                 # 入口：flags 解析 + 单实例锁 + 事件接线（~90 行）
│   ├── companion-app.cjs        # CompanionApp 组合根：窗口/托盘/设置/voice 事件汇聚
│   ├── bridge-service.cjs       # BridgeService：loopback HTTP + MCP 生命周期
│   ├── bridge-server.cjs / bridge-endpoint.cjs
│   ├── mcp-server.cjs           # McpSessionManager + 8 工具注册
│   ├── mcp-protocol.cjs / protocol-utils.cjs / renderer-protocol.cjs
│   ├── renderer-command-channel.cjs / renderer-commands.cjs
│   ├── window-interactions.cjs  # WindowInteractionController（拖动/缩放/热区轮询）
│   ├── window-state.cjs         # 窗口状态模型（sanitize/normalize，零依赖）
│   ├── voice-listener-manager.cjs # VoiceListenerManager（世代号防陈旧回调）
│   ├── audio-listener.cjs / native-process-audio-listener.cjs
│   ├── process-discovery.cjs / listener-status.cjs / voice-source.cjs / voice-events.cjs
│   ├── settings-store.cjs       # SettingsStore（current 唯一缓存真值）
│   ├── settings-view.cjs / settings-preload.cjs / settings-channels.cjs
│   ├── settings-windows.cjs     # SettingsWindows：托盘弹窗 + 完整设置窗
│   ├── settings-actions.cjs     # 设置窗 action 白名单校验
│   ├── settings/                # popover.html/js/css · settings.html/settings-renderer.js/settings.css · shared.js
│   ├── tray.cjs                 # TrayController
│   ├── preload.cjs              # 沙箱窄 API（内联副本有 source-probe 护栏）
│   └── test/                    # node:test 套件
├── renderer/
│   └── src/
│       ├── main.ts              # 入口组合根（启动期断言 + 接线，~90 行）
│       ├── live2d-app.ts        # Live2DApp：PIXI/Cubism 封装
│       ├── status-bar.ts / mouse-follow.ts / window-controls.ts
│       ├── click-interaction.ts / debug-panel.ts
│       ├── voice-controller.ts / command-dispatcher.ts
│       ├── lip-sync.ts / voice-state.ts / desktop-interactions.ts  # 纯逻辑
│       ├── model-config.ts / boot-error.ts / button-group.ts
│       └── live2d-bridge.d.ts   # preload 窄 API 类型（Live2dApi）
├── native/
│   ├── macos/Live2dAudioListener.mm
│   └── bin/darwin/live2d-audio-listener
```

---

## 7. 非目标（明确排除）

- **无 TTS**：不含任何语音合成；历史 TTS（腾讯云 speak / edge-tts / lip_sync* 工具与字幕链路）已于 F1 彻底移除。
- **无 VRM**：不引入 VRoid / VRM / `@pixiv/three-vrm` / React Three Fiber 角色渲染。
- **无 LLM**：不运行语言模型、不对话、不转录。
- 不采集麦克风；音频样本仅内存计算 level，不落盘、不上传。

---

## 8. 实现顺序

按 ADR 0001 切片推进（每片独立 DoD 与验收）：

| 切片 | 名称 | 状态见 |
|------|------|--------|
| F1 | TTS 清除 + 架构文档（本片） | `.adr/0001-electron-live2d-companion/plan.md` |
| F2 | Electron 壳 + 嵌入 Live2D | 同上 |
| F3 | 状态/电平 → 口型 | 同上 |
| F4 | Bridge `/health` + `/events` | 同上 |
| F5 | MCP Streamable HTTP 工具 | 同上 |
| F6 | Voice source + macOS listener | 同上 |
| F7 | 托盘/最小设置 + README | 同上 |
