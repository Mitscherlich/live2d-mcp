# Live2D Desktop Companion

Electron 桌面 Live2D 陪伴应用：监听 Codex / ChatGPT 等 agent 进程的系统输出电平驱动口型，并通过本机 MCP 控制表情、动作和角色窗口。

应用只做视觉陪伴：**不提供 TTS、不播放 agent 音频、不采集麦克风、不落盘或上传音频，也不使用 VRM/Three 渲染管线**。

- 产品规格：[`SPEC.md`](SPEC.md)
- 架构说明：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 默认 bridge：`127.0.0.1:47832`（仅 loopback）
- 默认 MCP URL：`http://127.0.0.1:47832/mcp`

## 快速开始（Electron 默认路径）

需要 Node.js 20+ 与 npm；macOS 是当前原生 voice listener 的优先平台。

### 1. 安装依赖

```bash
npm install
```

### 2. 准备 Cubism Core 与模型

1. 从 [Live2D Cubism SDK for Web](https://www.live2d.com/download/cubism-sdk/download-web/) 取得 `Core/live2dcubismcore.min.js`，放入 `renderer/public/`。
2. 从 [Live2D 示例模型](https://www.live2d.com/en/download/sample-data/) 下载 HiyoriPro，完整放入 `renderer/public/model/HiyoriPro/`。

目录应为：

```text
renderer/public/
├── live2dcubismcore.min.js
└── model/
    └── HiyoriPro/
        ├── hiyori_pro_t11.model3.json
        └── ...
```

缺少这些资源不会让应用硬崩；角色窗会显示准备指引。生产构建在补齐资源后需要重新执行 `npm run build`。

### 3. 启动桌面应用

开发模式（Vite + Electron）：

```bash
npm run dev
```

生产构建与启动：

```bash
npm run build
npm start
```

启动后系统托盘提供“显示角色窗”“隐藏角色窗”“打开设置”“退出”。关闭角色窗只会隐藏它，应用和 MCP bridge 由托盘保活；请从托盘“退出”结束应用。

### 4. 连接 Codex MCP

应用运行时执行：

```bash
codex mcp add live2d --url http://127.0.0.1:47832/mcp
```

同一 URL 也可用于 Claude Code、Hermes 等支持 Streamable HTTP MCP 的客户端。托盘“打开设置”会展示与 bridge **实际监听端口一致**的 MCP URL 和可复制的 Codex 命令。

若设置了自定义端口：

```bash
LIVE2D_BRIDGE_PORT=49000 npm run dev
codex mcp add live2d --url http://127.0.0.1:49000/mcp
```

bridge 永远只绑定 loopback。可用以下接口排障或注入 external voice 事件：

```bash
curl -s http://127.0.0.1:47832/health

curl -s -X POST http://127.0.0.1:47832/events \
  -H 'content-type: application/json' \
  -d '{"type":"state","state":{"phase":"active","activity":"speaking"}}'

curl -s -X POST http://127.0.0.1:47832/events \
  -H 'content-type: application/json' \
  -d '{"type":"audio-level","level":0.8}'
```

## Voice source 设置

托盘 →“打开设置”可选择四种模式。设置写入 Electron `userData/settings.json`；合法变更会立即重启 listener，无需重启应用。非法 mode、正则或 application source 不会覆盖上一份有效配置。

| 模式 | 行为 | 必要字段 |
|------|------|----------|
| `automatic` | 默认按 Codex / ChatGPT / OpenAI 类进程名匹配 | 无 |
| `application` | 精确监听一个 application source | `source_id` 与 `source_name` |
| `custom` | 用自定义正则匹配目标进程 | `process_pattern`（合法正则，最多 200 字符） |
| `external` | 完全关闭原生进程捕获，只消费 loopback `POST /events` | 无 |

现有环境变量仍可覆盖持久化设置：

| 变量 | 说明 |
|------|------|
| `LIVE2D_VOICE_SOURCE_MODE` | `automatic` / `application` / `custom` / `external` |
| `LIVE2D_TARGET_PROCESS_PATTERN` | automatic 的匹配覆盖，或 custom 正则 |
| `LIVE2D_VOICE_SOURCE_ID` | application source ID |
| `LIVE2D_VOICE_SOURCE_NAME` | application 展示名 |
| `LIVE2D_NATIVE_HELPER_PATH` | macOS native helper 路径覆盖（排障用） |
| `LIVE2D_LISTENER_DEBUG=1` | 输出 listener 协议诊断，不输出音频内容 |

设置窗检测到环境变量覆盖时会明确提示：表单仍会持久化，但当前进程继续采用环境变量；移除覆盖并重启后才使用已保存值。

### macOS 权限与 external 降级

`automatic` / `application` / `custom` 使用 macOS 进程系统音频监听，需要在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中授权运行 Electron/终端的宿主应用。权限不足时 `/health` 与 MCP `get_status` 会报告 `permission-denied`；helper 缺失或不可用则报告 `unavailable`。

权限暂不可用时切换到 `external`，应用不会启动 native helper，仍可通过 `/events` 驱动口型。该降级路径同样不采麦克风、不含 TTS。

如需从源码构建 macOS universal helper：

```bash
npm run build:native
```

## MCP 工具

| 工具 | 说明 |
|------|------|
| `get_status` | 查询窗口、bridge、voice/listener 与模型状态 |
| `control_window` | `show` / `hide` / `toggle` 角色窗 |
| `get_model_info` | 获取表情、动作组与参数摘要 |
| `set_expression` | 切换表情 |
| `play_motion` | 播放动作 |
| `look_at` | 控制视线方向 |
| `set_parameter` | 设置 Live2D 参数 |
| `reset` | 重置表情、动作、视线与参数 |

不存在 `speak`、`lip_sync*` 或其他 TTS 工具。

## 验证

```bash
npm run build
npm test
npm run proof:f4
npm run proof:f5
npm run proof:f6
```

## Legacy / 已降级

旧的“独立 `mcp-server`（`:3000`）+ 浏览器 renderer（`:5173` / WS `:8765`）”双进程架构仅在迁移期保留，不再是快速开始或长期维护主路径。确需排查遗留兼容时运行：

```bash
npm run dev:legacy
```

新接入请始终使用 Electron 与 `http://127.0.0.1:47832/mcp`。
