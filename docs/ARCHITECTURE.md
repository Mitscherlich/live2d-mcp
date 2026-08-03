# Live2D Desktop Companion · 架构说明

| 字段 | 内容 |
|------|------|
| 状态 | 目标架构已锁定（SPEC-0001 v1.0.0）；实现按 ADR 0001 切片推进 |
| 权威规格 | [`SPEC.md`](../SPEC.md)（§5 架构、§6 需求、§9 TTS 移除范围） |
| 实现计划 | [`.adr/0001-electron-live2d-companion/plan.md`](../.adr/0001-electron-live2d-companion/plan.md)（切片 F1–F7） |
| 参考实现（只读） | `/Users/mitscherlich/f/persona`（MIT；分层与契约借鉴，**禁止修改**，不引入其 VRM/Three 渲染栈） |

> 本文描述**目标架构**。当前仓库处于迁移期：F1（TTS 清除）、F2（Electron 壳）、F3（voice 状态机 → 口型，见 §4.3）已落地；bridge（F4）及之后尚未实现。

---

## 1. 现状 vs 目标

### 1.1 现状（F1 之后的迁移期架构）

```
Agent (Codex / Claude Code / …)
    │  MCP (HTTP :3000 或 stdio)
    ▼
mcp-server (Node.js)
    │  WebSocket (:8765)
    ▼
renderer (Vite 浏览器 :5173)  ← Live2D (pixi.js + pixi-live2d-display)
```

- MCP 工具：表情 / 动作 / 参数 / 眼神 / 查询 / 重置（**已无 TTS**）。
- 无桌面壳、无进程音频监听、无托盘/设置。
- 该双进程形态是**遗留路径**，将随 F2–F7 被 Electron 一体化取代，不作为长期主路径维护。

### 1.2 目标架构（Electron 一体化）

```
┌─────────────────────────────────────────────────────────────┐
│  Codex / Claude Code / Hermes / 其他 MCP client             │
└───────────────┬─────────────────────────────┬───────────────┘
                │ MCP /mcp                    │ POST /events
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Electron Main                                              │
│  · window / tray / settings lifecycle                       │
│  · bridge-server (loopback HTTP)                            │
│  · mcp-server (Streamable HTTP)                             │
│  · audio listener (macOS process tap；external 可空)        │
│  · settings-store (voice source 等)                         │
└───────────────┬─────────────────────────────────────────────┘
                │ 沙箱 preload（规范化事件 + 窄 API）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Renderer（Live2D）                                         │
│  · pixi.js + pixi-live2d-display                            │
│  · expression / motion / parameter / look_at                │
│  · amplitude lip-sync → ParamMouthOpenY（或等效嘴参）         │
│  · idle / listening / speaking 状态行为                     │
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
| React + Three.js / VRM 渲染 | **pixi.js + pixi-live2d-display（Live2D Cubism 4）** | **核心差异**：不引入 VRM/Three 角色管线；口型映射到 `ParamMouthOpenY` |
| MCP 工具面（window/status/animation） | status/window/model-info/expression/motion（+ 可选 look_at/parameter/reset） | 工具名按 Live2D 语义设计，server 名使用 live2d 系 |

---

## 3. 本机集成面（bridge）

默认监听 **`127.0.0.1:47832`**，环境变量 `LIVE2D_BRIDGE_PORT` 可覆盖。仅 loopback；拒绝非本机 Host/Origin。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 进程存活、模型就绪、窗口可见、voice/listener 摘要；不含用户内容 |
| `/events` | POST | JSON：`state`（voice state）/ `audio-level`（level，clamp 到 `[0,1]`）/ 可选动作或表情命令 |
| `/mcp` | ALL | Streamable HTTP MCP，与 bridge 同端口 |

MCP 连接示例：

```bash
codex mcp add live2d --url http://127.0.0.1:47832/mcp
```

---

## 4. 口型契约与状态机

### 4.1 Listener 契约（所有 voice source 统一）

- `onSession(active: boolean)`
- `onActivity("listening" | "speaking")`
- `onLevel(level: number)`，`0 ≤ level ≤ 1`
- `onStatus(diagnostics)`

voice source 四模式：`automatic`（默认匹配 codex/chatgpt 类进程名，regex 可配置）/ `application` / `custom`（自定义 regex）/ `external`（关闭进程捕获，仅消费 `/events`）。

### 4.2 渲染侧行为

- **嘴型**：每个动画帧按当前 `level` 与 `activity === speaking` 平滑驱动嘴参（思想对齐 persona `useAmplitudeLipSync`，映射到 Live2D `ParamMouthOpenY`）。
- **状态**：`idle` / `listening` / `speaking`；短静音（默认 **900ms**，可配置常量）内保持 speaking，避免句间抖动切回 idle。
- **优先级**：MCP 触发的 `play_motion` / `set_expression` 可临时优先于 voice 驱动的身体动作；口型 level 驱动不被打断。

### 4.3 Voice 事件通道（F3 落地）

| 环节 | 位置 | 说明 |
|------|------|------|
| 权威规范化 | `electron/voice-events.cjs` | `normalizeVoiceEvent`：白名单字段、level clamp `[0,1]`、phase/activity 枚举校验；非法负载丢弃（NFR-3，有单测） |
| main → renderer | IPC `live2d:voice` | `sendVoiceEvent(win, raw)`（`electron/main.cjs`）；F4 bridge `/events` 复用同一函数签名 |
| preload 窄 API | `electron/preload.cjs` | `window.live2d.onVoiceEvent(cb)`（浅校验 type 白名单后转发，返回取消订阅）；不暴露任意 IPC |
| renderer 消费 | `renderer/src/main.ts` → `lip-sync.ts` → `voice-state.ts` | 状态机 + 平滑 + 嘴参解析（`ParamMouthOpenY` 或别名，缺模型/缺参 no-op）；PIXI ticker LOW 优先级写入（motion 之后、当帧渲染生效） |

**测试注入（仅开发/测试）**：以 `LIVE2D_VOICE_INJECT=1`（或 CLI `--live2d-voice-inject`）启动 main 时，preload 经 `additionalArguments` 检测标志后额外暴露 `window.live2d.injectVoice(payload)`；该调用经 IPC `live2d:voice-inject` 回到 main，**过同一 `normalizeVoiceEvent`** 后再经 `live2d:voice` 送回 renderer——注入与真实推送走完全相同的 renderer 路径。未开标志时 `injectVoice` 不存在（生产无注入面）。调试快照 `window.__live2dVoiceDebug.snapshot()`（activity / smoothedMouth / mouthWrites / events 等）供脚本断言，证据脚本：`scripts/f3-lipsync-proof.mjs`（`npm run proof:f3`，`--e2e` 走 CDP 端到端）。

---

## 5. MCP 工具面（目标态）

| 工具 | 读写 | 说明 |
|------|------|------|
| `get_status` | 只读 | 窗口、模型、phase/activity、listener 状态 |
| `control_window` | 写 | `show` \| `hide` \| `toggle` |
| `get_model_info` | 只读 | 表情 / 动作组 / 关键参数列表 |
| `set_expression` | 写 | 表情名 |
| `play_motion` | 写 | group + 可选 index/priority |
| `look_at` | 写 | 可选（低成本保留） |
| `set_parameter` | 写 | 可选（低成本保留） |
| `reset` | 写 | 可选（低成本保留） |

Server instructions 须声明：本应用**不说话、不播放 agent 音频**，仅提供视觉陪伴与窗口控制。

---

## 6. 目标目录结构

```text
live2d-mcp/
├── SPEC.md
├── docs/ARCHITECTURE.md
├── package.json                 # electron + workspaces 脚本
├── electron/
│   ├── main.cjs | main.ts
│   ├── preload.cjs
│   ├── bridge-server.*
│   ├── mcp-server.*
│   ├── audio-listener.*
│   ├── voice-source.*
│   └── settings-store.*
├── renderer/                    # Live2D UI（去独立 WS 依赖，改由 main 桥接）
├── native/                      # 可选：macOS helper
└── (legacy mcp-server/)         # 迁移期保留，将删除或标记 deprecated
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
