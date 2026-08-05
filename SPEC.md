# Live2D Desktop Companion · 产品与技术规格说明书（SPEC）

| 字段 | 内容 |
|------|------|
| 文档 ID | SPEC-0001 |
| 标题 | Electron Live2D 桌面角色陪伴（Persona 架构迁移） |
| 状态 | Approved（用户已锁定决策，进入 ADR 实现） |
| 版本 | 1.0.0 |
| 日期 | 2026-08-03 |
| 仓库 | `/Users/mitscherlich/i/live2d-mcp` |
| 参考实现（只读） | `/Users/mitscherlich/f/persona`（MIT；**禁止修改**） |
| 关联 ADR | `.adr/0001-electron-live2d-companion/` |
| 实现 runner | `--impl=claude-code` |
| 验收 reviewer | `--reviewer=codex` |

---

## 1. 背景与问题陈述

### 1.1 现状（历史背景）

> 本节描述的是本 SPEC 撰写时的起点形态。该架构已于 F1–F7 迁移完成并整体删除，
> 当前实现见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；本节仅保留作历史背景。

彼时 `live2d-mcp` 为「**独立 Node MCP Server + 浏览器 Live2D 渲染器**」双进程架构：

```
Agent (Codex/Claude/…)
    │  MCP (HTTP :3000 或 stdio)
    ▼
mcp-server
    │  WebSocket (:8765)
    ▼
renderer (Vite 浏览器 :5173)  ← Live2D (pixi.js + pixi-live2d-display)
```

能力特点：

- MCP 可控制表情、动作、参数、眼神。
- 口型依赖 **服务端 TTS**（腾讯云 `speak` / 时间轴 `lip_sync*`），应用自身发声。
- **无桌面壳**、**无进程音频监听**、**无托盘/设置**，不适合作为 Codex live-voice 的视觉陪伴层。

### 1.2 参考产品（persona）

`persona` 是跨平台 Electron 桌面角色：

- **不运行 LLM、不采集麦克风、不发声、不落盘音频**。
- 通过 **进程级输出监听** 得到归一化电平 `level∈[0,1]`，驱动口型与 idle/listening/speaking。
- 本机 **loopback HTTP**（`/health`、`/events`）+ **Streamable HTTP MCP** 供 agent 控制窗口与动画。
- 四层：Native listener → Electron main → sandboxed preload → Renderer。

### 1.3 要解决的问题

将本仓库重构为 **Persona 式桌面陪伴**，但 **渲染保留 Live2D**（不使用 VRoid/VRM/Three 角色管线），并 **彻底移除 TTS**，使：

1. Codex live-voice（及可配置 agent 出声进程）说话时，Live2D 自动跟嘴。
2. Codex / Claude Code / Hermes 等可通过 MCP 控制表情、动作、窗口与状态。
3. 默认路径为单一 Electron 应用，而非浏览器 + 外挂 MCP。

---

## 2. 目标与非目标

### 2.1 目标（Goals）

| ID | 目标 | 验收要点 |
|----|------|----------|
| G1 | Electron 桌面应用可启动并显示 Live2D 角色（或明确缺模引导） | `bun run dev` / `start` 可见角色窗 |
| G2 | 口型由 **amplitude level + activity 状态机** 驱动（对齐 persona） | `POST /events` 注入 level 可见嘴动 |
| G3 | 本机 loopback：`GET /health`、`POST /events`（state / audio-level） | curl 可复现 |
| G4 | Streamable HTTP MCP：`get_status`、`control_window`、`get_model_info`、`set_expression`、`play_motion`；低成本保留 `look_at` / `set_parameter` / `reset` | tools/list + 调用有证据 |
| G5 | Voice source：automatic / application / custom / external；macOS 进程监听优先 | 设置可切换；native 失败时 external 仍可演示 |
| G6 | **完全移除 TTS** 及相关依赖与文档主路径 | 全库检索无 speak/TTS 运行时主路径 |
| G7 | 默认 Electron 一体化；旧「独立 mcp-server + 浏览器 WS」删除或降级并在 README 说明 | 文档与入口一致 |

### 2.2 非目标（Non-Goals）

- 不引入 VRoid / VRM / `@pixiv/three-vrm` / React Three Fiber 角色渲染。
- 不实现 LLM 宿主、不对话、不转录。
- 不采集麦克风、不存储/上传音频。
- 不实现腾讯云/其他云 TTS、不保留 `speak` / `lip_sync*` 工具。
- 不在本 MVP 强制完成 Windows/Linux 原生监听与完整安装包分发。
- 不修改 `/Users/mitscherlich/f/persona`。
- 不擅自 push 远程；ADR 本地 commit 由 loop 约束。

---

## 3. 用户已锁定决策

| # | 决策 | 裁决 |
|---|------|------|
| D1 | 口型主路径 | 对齐 persona：**进程音频电平 / external events**；**完全移除 TTS** |
| D2 | MVP 平台 | **macOS 优先**；代码结构预留 linux/win，不强制一次做完 |
| D3 | MCP 工具面 | status + window + model info + expression + motion；（低成本）look_at / set_parameter / reset |
| D4 | 旧架构 | **Electron 默认主路径**；旧浏览器+WS **可删可降级**，README 写迁移说明 |
| D5 | 产品模型 | 本应用 **不发声**；agent 出声，本应用做视觉陪伴与 MCP 控演 |

---

## 4. 术语

| 术语 | 定义 |
|------|------|
| level | 归一化输出响度，浮点 `[0, 1]`，仅内存使用 |
| activity | `idle` \| `listening` \| `speaking` |
| phase | `inactive` \| `starting` \| `active` \| `stopping`（对齐 persona voice state） |
| voice source | 监听目标配置：automatic / application / custom / external |
| bridge | 本机 loopback HTTP，承载 `/health`、`/events`、`/mcp` |
| external 模式 | 关闭进程捕获，仅消费 `/events` 或协议事件 |

---

## 5. 架构

### 5.1 目标分层（参考 persona，渲染换 Live2D）

```
┌─────────────────────────────────────────────────────────────┐
│  Codex / Claude Code / Hermes / 其他 MCP client             │
└───────────────┬─────────────────────────────┬───────────────┘
                │ MCP /mcp                    │ POST /events
                ▼                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Electron Main                                              │
│  · window / tray / settings lifecycle                       │
│  · bridge-server (loopback)                                 │
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

**安全边界**：renderer **不得**拥有文件系统、原始音频、进程枚举权限。

### 5.2 与现状映射

| 现状 | 目标 |
|------|------|
| `mcp-server` Express + WS bridge | Electron main 内 bridge + MCP（同端口或文档化端口） |
| 浏览器打开 `renderer` | Electron `BrowserWindow` 加载 renderer |
| `tools/tts.ts` + Tencent/edge-tts | **删除** |
| `startSpeak` / `audioChunk` / 字幕说话链路 | **删除**；改为 level 事件驱动嘴型 |
| `set_expression` / `play_motion` 等 | 保留语义，经 main 转发至 renderer |
| 无 voice listener | 新增 macOS listener + external |

### 5.3 推荐目录（实现可微调，须写入 ARCHITECTURE.md）

```text
live2d-mcp/
├── SPEC.md
├── docs/ARCHITECTURE.md
├── package.json                 # electron + workspaces 或 monorepo 脚本
├── electron/
│   ├── main.cjs | main.ts
│   ├── preload.cjs
│   ├── bridge-server.*
│   ├── mcp-server.*
│   ├── audio-listener.*
│   ├── voice-source.*
│   └── settings-store.*
├── renderer/                    # Live2D UI（改造，去 WS 客户端依赖 main 桥）
├── native/                      # 可选：macOS helper（可参考 persona 契约）
└── (legacy mcp-server/)         # 删除或标记 deprecated，不得作为默认入口
```

### 5.4 口型与状态机（对齐 persona）

**Listener 契约**（所有来源统一）：

- `onSession(active: boolean)`
- `onLevel(level: number)` where `0 ≤ level ≤ 1`
- `onStatus(diagnostics)`

listener **不产出 activity**：它只报「会话开没开」与「当前电平」两件客观事实。
main 收到 `onSession` 只发 `state`（`phase: active|inactive`，`activity` 相应取
`listening|idle`），收到 `onLevel` 只发 `audio-level`。`listening ⇄ speaking` 的
判定全部由渲染侧状态机从同一条 level 流推导（见下），避免 main 与 renderer
各推一遍而产生分叉。

外部经 `POST /events` 注入的显式 `state.activity` 仍然生效（§8.1），
用于不接 listener 的集成方直接驱动状态。

**渲染侧**：

- activity 推导：状态机在 session 激活（`listening`）后，按 `level` 是否越过可闻阈值
  在 `listening ⇄ speaking` 间切换；session 结束立即回 `idle`。这是 activity 的
  **唯一推导点**（显式注入的 activity 直接覆盖）。
- 嘴型：每个动画帧根据当前 `level` 与 `activity===speaking` 平滑驱动嘴参（smoothing 可参考 persona `useAmplitudeLipSync` 思想，映射到 Live2D `ParamMouthOpenY` 等）。
- 身体/动作：speaking 期间可播放/保持说话相关 motion；短静音（建议默认 **900ms**，可配置常量）内保持 speaking，避免句间抖动切回 idle。
- MCP 触发的 `play_motion` / `set_expression` **可临时优先**于 voice 驱动身体动作；口型 level 仍可继续。

### 5.5 本机集成面

默认监听 **`127.0.0.1:47832`**（避免与 persona 默认 `47831` 冲突；可用环境变量 `LIVE2D_BRIDGE_PORT` 覆盖）。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 进程存活、模型就绪、窗口可见、voice/listener 摘要；**不含用户内容** |
| `/events` | POST | JSON：`state` / `audio-level` / 可选 `motion` 或 expression 命令 |
| `/mcp` | ALL | Streamable HTTP MCP |

**Host 校验**：仅 loopback Host；非本机 Origin 拒绝（浏览器客户端需受信本地 origin）。

**可选 URL scheme**（MVP 可后置，若做则文档化）：`live2d://show|hide|toggle|listening|speaking?level=`。

---

## 6. 功能需求

### 6.1 桌面壳（FR-DESKTOP）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-D1 | Electron 启动角色透明/置顶窗口（能力范围内） | P0 |
| FR-D2 | 托盘菜单：显示/隐藏、设置、退出 | P0 |
| FR-D3 | 无模型时引导设置/说明路径，不硬崩 | P0 |
| FR-D4 | 开发模式可加载 Vite dev server；生产加载 build 产物 | P0 |
| FR-D5 | `--background` 可选后台启动（若成本低） | P2 |

### 6.2 语音监听与口型（FR-VOICE）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-V1 | automatic 默认匹配 codex/chatgpt 类进程名（regex 可配置） | P0 |
| FR-V2 | application / custom regex / external 四模式 | P0 |
| FR-V3 | macOS 进程输出监听产出 level（或明确权限失败提示） | P0 |
| FR-V4 | external：仅 `/events` 驱动，不启 native | P0 |
| FR-V5 | 不采集麦克风；音频样本仅内存算 level，不落盘不上传 | P0 |
| FR-V6 | 环境变量可覆盖匹配模式（如 `LIVE2D_TARGET_PROCESS_PATTERN`） | P1 |

### 6.3 Live2D 表现（FR-LIVE2D）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-L1 | 加载现有 Cubism4 模型（如 HiyoriPro 路径可配置/文档化） | P0 |
| FR-L2 | `set_expression` / `play_motion` 可用 | P0 |
| FR-L3 | level → 嘴参平滑 | P0 |
| FR-L4 | `look_at` / `set_parameter` / `reset`（低成本则做） | P1 |
| FR-L5 | 禁止 VRM 管线 | P0 |

### 6.4 MCP（FR-MCP）

| 工具 | 读写 | 说明 |
|------|------|------|
| `get_status` | 只读 | 窗口、模型、phase/activity、listener |
| `control_window` | 写 | `show` \| `hide` \| `toggle` |
| `get_model_info` | 只读 | 表情/动作组/关键参数列表 |
| `set_expression` | 写 | 表情名 |
| `play_motion` | 写 | group + 可选 index/priority |
| `look_at` | 写 | 可选 |
| `set_parameter` | 写 | 可选 |
| `reset` | 写 | 可选 |

**禁止工具**：`speak`、`lip_sync`、`lip_sync_estimate` 及任何 TTS 封装。

Server instructions 须声明：本应用不说话、不播放 agent 音频；仅视觉与窗口控制。

### 6.5 设置（FR-SETTINGS）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-S1 | 配置 voice source 模式与匹配 | P0 |
| FR-S2 | 展示 MCP URL 便于 `codex mcp add` | P0 |
| FR-S3 | 完整模型库/动画市场级 UI | 非本 SPEC |

---

## 7. 非功能需求

| ID | 类别 | 要求 |
|----|------|------|
| NFR-1 | 隐私 | 无 mic、无音频上传、无音频落盘 |
| NFR-2 | 安全 | preload 窄桥；bridge 仅 loopback |
| NFR-3 | 可测 | 事件规范化、voice source sanitize、MCP 非法输入拒绝有单测 |
| NFR-4 | 文档 | README + ARCHITECTURE；含权限说明与 MCP 连接示例 |
| NFR-5 | 兼容 | Node 版本在 package engines 声明；Electron 版本锁定 |
| NFR-6 | 许可 | 借鉴 persona 时适配 Live2D；不整包无必要粘贴；不引入 persona 的 VRM 资源 |

---

## 8. 接口契约

### 8.1 Voice state 事件

```json
{
  "type": "state",
  "state": {
    "phase": "active",
    "activity": "speaking",
    "microphoneMuted": false,
    "outputMuted": false
  }
}
```

### 8.2 Audio level 事件

```json
{
  "type": "audio-level",
  "level": 0.31
}
```

`level` 必须有限数字，服务端 clamp 到 `[0,1]`。

### 8.3 健康检查（示例形状，字段可扩展但需稳定）

```json
{
  "ok": true,
  "bridgePort": 47832,
  "modelReady": true,
  "windowVisible": true,
  "voice": { "phase": "active", "activity": "speaking" },
  "listener": { "status": "running", "mode": "external" },
  "mcp": { "path": "/mcp" }
}
```

### 8.4 MCP 连接示例

```bash
codex mcp add live2d --url http://127.0.0.1:47832/mcp
```

Claude Code / Hermes 使用同一 URL（按其 MCP 配置格式）。

---

## 9. TTS 移除范围（强制）

必须删除或剥离，且不得残留为默认路径：

| 区域 | 说明 |
|------|------|
| `mcp-server/src/tools/tts.ts` | 整文件删除 |
| `registerTTSTools` 及 MCP 注册 | 删除 |
| `edge-tts` 依赖 | 从 package.json 移除 |
| `TENCENT_SECRET_*` 文档与运行时必需逻辑 | 删除 |
| renderer：`startSpeak` / `audioChunk` / `endSpeak` / 字幕说话链路 | 删除或改为仅 level 驱动 |
| README TTS 章节 | 删除或改为「已移除」历史说明一行 |
| WS 命令类型中的 speak/TTS 变体 | 清理 |

验收：全库（排除 lock 历史可说明）检索 `speak` 工具、`TextToVoice`、`edge-tts`、`TENCENT_SECRET` 无运行时主路径。

---

## 10. 迁移策略

1. **默认入口**改为 Electron（`bun run dev` / `bun start`）。
2. 旧 `mcp-server` + 浏览器双开流程：**删除或移入 `legacy/` 并停止维护**；README 仅描述桌面路径。
3. 现有 Live2D 渲染核心（`live2d-app.ts` 表情/动作/参数）**迁移复用**，去掉对独立 WS 的硬依赖，改为 preload IPC / 主进程推送事件。
4. 模型与 Cubism Core 仍由用户按文档放入 `renderer/public/`（或后续 settings 配置路径）；缺资源时 UI/日志明确指引。

---

## 11. 实现切片（与 ADR roadmap 对齐）

| 切片 | 名称 | 交付物摘要 |
|------|------|------------|
| F1 | TTS 清除 + 架构文档 | 无 TTS；`docs/ARCHITECTURE.md`；门禁绿 |
| F2 | Electron 壳 + 嵌入 Live2D | 桌面窗显示模型或引导 |
| F3 | 状态/电平 → 口型 | renderer 状态机 + 嘴参；可经 IPC 注入 |
| F4 | Bridge `/health` + `/events` | curl 端到端口型 |
| F5 | MCP 工具 | 约定工具可发现可调用 |
| F6 | Voice source + macOS listener | automatic/external 可用；权限失败有提示 |
| F7 | 托盘/最小设置 + README | MCP URL、voice 设置、迁移说明 |

每片统一 DoD 见 `.adr/0001-electron-live2d-companion/plan.md`。

---

## 12. 验收总标准（Release DoD）

- [ ] Electron 可启动，Live2D 可见或有缺模引导。
- [ ] TTS 代码与依赖已移除，检索通过。
- [ ] `curl` `/health` 与 `/events` 驱动口型有证据。
- [ ] MCP tools/list 含约定工具；`get_status` / `control_window` / 表情或动作调用有证据。
- [ ] external 模式完整可演示；macOS listener 可用或文档记录权限缺口。
- [ ] README 含架构、启动、权限、MCP 连接、无 TTS。
- [ ] 未修改 persona 仓库；未引入 VRM。
- [ ] 各 ADR 切片有 runner 报告 + 验收报告（reviewer=codex），结论可追溯。

---

## 13. 风险与暂停条件

| 风险 | 处置 |
|------|------|
| macOS System Audio Recording 需用户授权 | external 路径先通；暂停请用户授权后再验 native |
| 缺 Cubism Core / 模型文件 | 引导路径；不伪造资源 |
| native helper 编译失败 | 最多 3 轮修复；否则 BLOCKED 并交付 external |
| 与 persona 端口/工具名冲突 | 默认端口 47832；MCP server 名使用 live2d 系 |

---

## 14. 开放问题（本版本已关闭）

| 问题 | 状态 |
|------|------|
| 是否保留 TTS 并列主路径？ | **关闭：完全移除** |
| 是否上 VRM？ | **关闭：否** |
| 是否长期双模式（浏览器+Electron）？ | **关闭：否，Electron 默认** |
| MVP 是否做三端监听？ | **关闭：仅 macOS 优先** |

---

## 15. 修订历史

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | 2026-08-03 | 由已锁定 `/goal` 与用户选项（1 移除 TTS，2A/3A/4A）固化为 SPEC |
