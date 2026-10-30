<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/mayuka-banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/mayuka-banner-light.svg">
  <img alt="Mayuka — 你的 AI，跃然桌面。" src="./docs/assets/mayuka-banner-light.svg" width="100%">
</picture>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

# Mayuka

**你的 AI，跃然桌面。**

Mayuka 是陪伴你使用 AI 的 Live2D 桌面角色。让它陪在 Codex、ChatGPT 等 agent 身边：口型跟随应用声音，表情、动作、视线和角色窗口则通过 MCP 控制。

基于 Electron、PixiJS 与 Live2D Cubism。原生应用音频监听目前面向 **macOS 14.2+**；Windows 和 Linux 可使用外部语音事件，尚未实现原生进程音频捕获。

## 运行演示

<table>
  <tr>
    <th width="68%">完整设置页</th>
    <th width="32%">托盘快捷弹窗</th>
  </tr>
  <tr>
    <td valign="top"><img src="./docs/assets/demo-settings.png" alt="实际运行的 Mayuka 设置页：bridge 与音频状态、口型来源、MCP 连接和角色窗控制" width="100%"></td>
    <td valign="top"><img src="./docs/assets/demo-tray.png" alt="实际运行的 Mayuka 托盘弹窗：显示或隐藏角色、重置位置、复制 MCP、切换口型来源和缩放" width="100%"></td>
  </tr>
</table>

截图来自实际运行的 macOS 应用，当前应用界面为中文。

## Mayuka 能做什么

- **让角色陪在桌面上。** 透明、置顶的 Live2D 角色窗，支持移动、缩放和锁定。
- **让口型跟随 AI 的声音。** 自动匹配进程、指定应用来源、自定义进程正则，或接收外部音量事件。
- **让 agent 通过 MCP 控制角色。** 查询模型能力、切换表情、播放动作、控制视线和参数。
- **从托盘快速操作。** 显示或隐藏角色、重置位置、切换口型来源、调整缩放，并复制 MCP 接入命令。

Mayuka 提供视觉陪伴，不合成或播放语音、不采集麦克风，也不保存或上传音频。bridge 仅监听 `127.0.0.1`。

## 快速开始

### 1. 安装依赖

需要 [Bun](https://bun.sh) **1.1+** 与 **Node.js 20+**。

```bash
bun install
```

### 2. 准备 Cubism Core 与模型

仓库不包含 Cubism Core 和角色模型资源，请单独取得后放入 `renderer/public/`。

1. 从 [Cubism SDK for Web](https://www.live2d.com/download/cubism-sdk/download-web/) 中取得 `Core/live2dcubismcore.min.js`，复制到 `renderer/public/`。
2. 放入 Cubism 3、4 或 5 模型，并保留它引用的 `.moc3`、贴图、动作、表情等文件。默认加载器使用以下 DeepSeek「大肥鱼」模型路径。

```text
renderer/public/
├── live2dcubismcore.min.js
└── model/
    └── DeepSeek/
        ├── 大肥鱼.model3.json
        └── …
```

请使用 **Cubism 5 SDK 5-r.4 及以前附带的 Core 5.x**。当前渲染器使用 `untitled-pixi-live2d-engine`、PixiJS v8 与 Cubism 5 Framework，暂不兼容 SDK 5-r.5 起附带的 Core 6.x。

更换模型时，修改 [`renderer/src/live2d-app.ts`](renderer/src/live2d-app.ts) 中的 `MODEL_PATH`，并调整 [`renderer/src/model-config.ts`](renderer/src/model-config.ts) 的参数映射。资源缺失时，角色窗会显示准备指引。

### 3. 启动 Mayuka

开发模式，同时运行 Vite 和 Electron：

```bash
bun run dev
```

或构建并启动生产版本：

```bash
bun run build
bun start
```

新增或修改模型资源后，使用 `bun start` 前需要重新构建。

点击托盘图标打开快捷面板，通过 **更多设置…** 进入完整设置页。右键托盘可打开上下文菜单；Linux 直接使用该菜单。关闭角色窗只会将其隐藏，托盘和 MCP bridge 继续运行；通过 **退出 Mayuka** 结束应用。

窗口位置、大小与缩放保存在 Electron 的 `userData/settings.json` 中。锁定状态在每次启动时重置。**重置位置** 会将角色窗恢复为右下角的 600 × 640、100% 缩放状态。

### 4. 接入你的 agent

应用运行时，注册本机 MCP 端点：

```bash
# Codex
codex mcp add live2d --url http://127.0.0.1:47832/mcp

# Claude Code
claude mcp add --transport http live2d http://127.0.0.1:47832/mcp
```

其他支持 Streamable HTTP MCP 的客户端也可连接同一 URL。设置页会展示实际监听端口，并提供可复制的命令。

如需更改 bridge 端口：

```bash
LIVE2D_BRIDGE_PORT=49000 bun run dev
codex mcp add live2d --url http://127.0.0.1:49000/mcp
```

## 口型来源

在托盘面板或设置页选择来源。合法变更立即生效并重启 listener；非法输入不会覆盖上一份有效配置。

| 模式 | 行为 | 必要字段 |
| --- | --- | --- |
| `automatic` | 默认按 Codex / ChatGPT / OpenAI 进程名自动匹配。 | 无 |
| `application` | 监听一个应用来源。 | `source_id`、`source_name` |
| `custom` | 使用正则表达式匹配目标进程。 | `process_pattern`，最多 200 字符 |
| `external` | 关闭原生捕获，只消费本机 `POST /events` 事件。 | 无 |

macOS 原生捕获需要在 **系统设置 → 隐私与安全性 → 屏幕与系统音频录制** 中为运行 Electron 的宿主应用授权。设置页提供权限入口。权限被拒绝时报告 `permission-denied`，helper 缺失或不可用时报告 `unavailable`。

原生捕获暂不可用时，可以使用 `external` 模式。如需重新构建 macOS universal helper，安装 Xcode 命令行工具后运行：

```bash
bun run build:native
```

### 外部事件

先在设置中选择 `external`，再向 bridge 发送状态和归一化音量：

```bash
# 检查正在运行的 bridge。
curl --noproxy '*' -s http://127.0.0.1:47832/health

# 通知角色：agent 正在说话。
curl --noproxy '*' -s -X POST http://127.0.0.1:47832/events \
  -H 'content-type: application/json' \
  -d '{"type":"state","state":{"phase":"active","activity":"speaking"}}'

# 发送 0 到 1 之间的音量；静音时发送 0。
curl --noproxy '*' -s -X POST http://127.0.0.1:47832/events \
  -H 'content-type: application/json' \
  -d '{"type":"audio-level","level":0.8}'
```

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `get_status` | 查询窗口、bridge、语音 listener 与模型就绪状态。 |
| `control_window` | 显示、隐藏或切换角色窗。 |
| `get_model_info` | 列出模型的表情、动作组和参数。 |
| `set_expression` | 选择表情。 |
| `play_motion` | 播放模型动作组中的动作。 |
| `look_at` | 设置角色视线方向。 |
| `set_parameter` | 设置 Live2D 参数。 |
| `reset` | 重置表情、动作、视线与参数。 |

建议先调用 `get_model_info` 确认模型支持的名称。声音来自你正在使用的 AI 工具或外部事件，Mayuka 不提供 TTS 工具。

## 配置

设置保存在 Electron 的 `userData/settings.json`。语音环境变量会覆盖当前进程的持久化设置；界面会提示覆盖状态，移除变量并重启后才会采用已保存值。

| 变量 | 用途 |
| --- | --- |
| `LIVE2D_BRIDGE_PORT` | 本机 bridge 端口，默认 `47832`。 |
| `LIVE2D_VOICE_SOURCE_MODE` | `automatic`、`application`、`custom` 或 `external`。 |
| `LIVE2D_TARGET_PROCESS_PATTERN` | 覆盖自动匹配规则，或提供自定义正则。 |
| `LIVE2D_VOICE_SOURCE_ID` | 应用来源 ID。 |
| `LIVE2D_VOICE_SOURCE_NAME` | 应用展示名。 |
| `LIVE2D_NATIVE_HELPER_PATH` | 覆盖原生 helper 路径。 |
| `LIVE2D_LISTENER_DEBUG=1` | 输出 listener 协议诊断，不包含音频内容。 |
| `LIVE2D_UI_CHROME=1` | 显示角色窗状态栏与调试面板。 |
| `LIVE2D_DEVTOOLS=1` | 打开 DevTools，同时显示角色窗调试界面。 |
| `LIVE2D_RENDERER_LOG=1` | 将 renderer 控制台消息转发到终端。 |
| `VITE_DEV_SERVER_URL` | 指定开发环境 renderer URL，例如 `http://127.0.0.1:5174/`。 |

角色窗默认隐藏状态栏和调试条。也可以通过 `?debug=1`、`?ui=1`，或执行 `localStorage.setItem('live2d.uiChrome', '1')` 后刷新来显示。

## 开发与验证

```bash
bun run build
bun run test
```

请使用 **`bun run test`** 执行仓库的 `node:test` 套件；裸命令 `bun test` 使用的是 Bun 自带测试器。

以下脚本可分别验证运行时集成：

```bash
bun run proof:f3  # 口型
bun run proof:f4  # 本机 bridge
bun run proof:f5  # MCP
bun run proof:f6  # 语音 listener
```

- [产品规格](SPEC.md)
- [架构说明](docs/ARCHITECTURE.md)
- [应用与托盘图标](electron/assets/icons/README.md)
- [README 封面与演示截图](docs/assets/README.md)
