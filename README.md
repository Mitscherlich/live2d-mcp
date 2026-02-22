# Live2D MCP Controller

通过 MCP (Model Context Protocol) 控制 Live2D 角色表情和动作的系统。LLM 在与用户对话时，可以调用 MCP 工具实时控制 Live2D 角色。

## 架构

```
你的 AI 对话程序
      │
      │  MCP 调用 (HTTP 或 stdio)
      ▼
MCP Server (Node.js :3000)
      │
      │  WebSocket (:8765)
      ▼
Live2D Renderer (浏览器 :5173)
```

## 快速开始

### 第一步：下载必要文件

**1. Live2D Cubism Core**

从 [Live2D Cubism SDK for Web](https://www.live2d.com/download/cubism-sdk/download-web/) 下载，
解压后找到 `Core/live2dcubismcore.min.js`，放到 `renderer/public/` 目录。

**2. Hiyori 示例模型**

从 [Live2D 示例模型](https://www.live2d.com/en/download/sample-data/) 下载 Hiyori 模型，
解压后将整个 `Hiyori` 文件夹放到 `renderer/public/model/` 目录。

最终目录结构：
```
renderer/public/
├── live2dcubismcore.min.js   ← Cubism Core
└── model/
    └── Hiyori/
        ├── Hiyori.model3.json
        └── ...（其他模型文件）
```

### 第二步：启动服务

```bash
# 安装依赖（只需一次）
npm install

# 启动 MCP Server（HTTP 模式，供 AI 程序连接）
cd mcp-server && npm run dev

# 新开一个终端，启动渲染器
cd renderer && npm run dev
```

打开浏览器访问 http://localhost:5173，看到 Live2D 角色后即表示成功。

### 第三步：配置你的 AI 程序

在你的 AI 对话程序中，将 MCP Server 地址配置为：`http://localhost:3000/mcp`

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `get_model_info` | 获取可用表情、动作、参数列表（建议首先调用） |
| `set_expression` | 切换表情（happy/sad/angry 等） |
| `play_motion` | 播放动作动画（Idle/TapBody 等分组） |
| `look_at` | 控制眼神方向（x/y: -1.0 到 1.0） |
| `set_parameter` | 精细控制参数（如 ParamMouthOpenY） |
| `reset` | 重置为默认姿态 |

## 如何配置 mcp

发送这段提示词给你的 Claude Code / OpenClaw:

```md
帮我添加 live2d mcp，这是一个运行在本地的 http sse mcp 服务，参考配置如下：

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

完成后测试这个 mcp 并向我报告。
```

需要先构建：`cd mcp-server && npm run build`

## 开发

```bash
# MCP Server 开发（热更新）
cd mcp-server && npm run dev

# Renderer 开发（热更新）
cd renderer && npm run dev

# 构建
npm run build
```

## WebSocket 端口配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_PORT` | 3000 | MCP HTTP Server 端口 |
| `WS_PORT` | 8765 | WebSocket Bridge 端口 |
