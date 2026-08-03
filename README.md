# Live2D Desktop Companion（迁移中）

> **本仓库正在迁移为 Persona 式 Electron Live2D 桌面陪伴**：监听 Codex 等 agent 语音进程的输出电平驱动口型，MCP 控制表情 / 动作 / 窗口；**不发声、不含 TTS、不使用 VRM**。
>
> - 目标规格：[`SPEC.md`](SPEC.md)
> - 目标架构：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（默认 bridge `127.0.0.1:47832`）
> - 实现切片：`.adr/0001-electron-live2d-companion/plan.md`（F1–F7）
>
> 历史 TTS 能力（腾讯云 `speak` / `lip_sync*` 工具、字级时间轴口型、字幕链路）已彻底移除。

当前处于迁移期：Electron 壳（F2）尚未落地，下述「独立 MCP Server + 浏览器渲染器」双进程流程为**遗留运行方式**，将随切片推进被 Electron 一体化默认入口取代。

## 遗留架构（迁移期）

```
你的 AI 对话程序
      │
      │  MCP 调用 (HTTP :3000 或 stdio)
      ▼
MCP Server (Node.js :3000)
      │
      │  WebSocket (:8765)
      ▼
Live2D Renderer (浏览器 :5173)
```

## 快速开始（遗留流程）

### 第一步：下载必要文件

**1. Live2D Cubism Core**

从 [Live2D Cubism SDK for Web](https://www.live2d.com/download/cubism-sdk/download-web/) 下载，
解压后找到 `Core/live2dcubismcore.min.js`，放到 `renderer/public/` 目录。

**2. HiyoriPro 模型**

从 [Live2D 示例模型](https://www.live2d.com/en/download/sample-data/) 下载 HiyoriPro 模型，
解压后将整个文件夹放到 `renderer/public/model/HiyoriPro/` 目录。

最终目录结构：
```
renderer/public/
├── live2dcubismcore.min.js
└── model/
    └── HiyoriPro/
        ├── hiyori_pro_t11.model3.json
        └── ...
```

### 第二步：安装依赖并启动

```bash
# 安装依赖（只需一次）
npm install

# 启动 MCP Server（HTTP 模式）
cd mcp-server && npm run dev

# 新开一个终端，启动渲染器
cd renderer && npm run dev
```

打开浏览器访问 http://localhost:5173，看到 Live2D 角色后即表示成功。

### 第三步：配置 AI 客户端

在你的 AI 程序配置中添加 MCP 服务器：

```json
{
  "mcpServers": {
    "live2d": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## MCP 工具列表（遗留流程）

| 工具 | 说明 |
|------|------|
| `get_model_info` | 获取可用表情、动作、参数列表（建议首先调用） |
| `set_expression` | 切换表情（happy/sad/angry 等） |
| `play_motion` | 播放动作动画（Idle/TapBody 等分组） |
| `look_at` | 控制眼神方向（x/y: -1.0 到 1.0） |
| `set_parameter` | 精细控制单个参数（如 ParamMouthOpenY） |
| `reset` | 重置为默认姿态 |

目标态工具面（含 `get_status` / `control_window`）见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5。

### 推荐 System Prompt 片段

```
你有一个 Live2D 虚拟角色，可以通过 MCP 工具控制它的表情和动作。
在对话过程中，根据情绪和内容主动调用这些工具，让角色富有表现力。
本角色不发声，仅作视觉陪伴。

- 根据对话情感切换合适的表情（happy/sad/angry/surprised）
- 适时播放动作动画增强互动感
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_PORT` | 3000 | MCP HTTP Server 端口 |
| `WS_PORT` | 8765 | WebSocket Bridge 端口 |
| `LIVE2D_BRIDGE_PORT` | 47832 | （目标架构）本机 bridge 端口，见 ARCHITECTURE.md |
