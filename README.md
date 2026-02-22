# Live2D MCP Controller

通过 MCP (Model Context Protocol) 控制 Live2D 角色表情、动作和语音的系统。LLM 在与用户对话时，可以实时调用 MCP 工具让 Live2D 角色说话、切换表情、播放动作。

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

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `get_model_info` | 获取可用表情、动作、参数列表（建议首先调用） |
| `set_expression` | 切换表情（happy/sad/angry 等） |
| `play_motion` | 播放动作动画（Idle/TapBody 等分组） |
| `look_at` | 控制眼神方向（x/y: -1.0 到 1.0） |
| `set_parameter` | 精细控制单个参数（如 ParamMouthOpenY） |
| `reset` | 重置为默认姿态 |
| `speak` | 腾讯云 TTS 说话 + 字级时间轴口型同步 |
| `lip_sync_estimate` | 仅口型动画，不播放音频（配合外部 TTS） |
| `lip_sync` | 播放指定音频并同步口型 |

## TTS + 口型同步

使用**腾讯云 TTS**（温柔小柠音色）合成语音，基于字级时间戳实现精准口型同步。

### 配置腾讯云凭证

```bash
export TENCENT_SECRET_ID="your_secret_id"
export TENCENT_SECRET_KEY="your_secret_key"

cd mcp-server && npm run dev
```

凭证从[腾讯云控制台](https://console.cloud.tencent.com/cam/capi)获取。

### 使用 `speak` 工具

```typescript
await mcpClient.callTool("speak", {
  text: "你好，我是 Hiyori，很高兴认识你！",
  emotion: "happy",   // neutral | happy | sad | angry | surprised
  speed: 1.0,         // 0.5 - 2.0
  voice_type: 603004  // 可选，默认 603004（温柔小柠）
});
```

口型同步原理：
- 腾讯云 TTS 返回音频 + 字级时间戳
- 每个字对应独立的张嘴/闭嘴动画曲线
- 标点和停顿自动闭嘴，节奏自然

### 仅口型动画（配合外部 TTS）

```typescript
await mcpClient.callTool("lip_sync_estimate", {
  text: "你好！",
  emotion: "happy",
  speed: 1.0
});
```

## OpenClaw 集成

在 `~/.openclaw/config.json` 中添加 MCP 服务器配置：

```json
{
  "mcpServers": {
    "live2d": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "env": {
        "TENCENT_SECRET_ID": "your_secret_id",
        "TENCENT_SECRET_KEY": "your_secret_key"
      }
    }
  }
}
```

重启 OpenClaw gateway 后，AI 即可通过 MCP 工具实时控制 Live2D 角色。

### 推荐 System Prompt 片段

```
你有一个 Live2D 虚拟角色，可以通过 MCP 工具控制它的表情、动作和语音。
在对话过程中，根据情绪和内容主动调用这些工具，让角色富有表现力。

- 说话时调用 speak 工具，让角色开口发声并同步口型
- 根据对话情感切换合适的表情（happy/sad/angry/surprised）
- 适时播放动作动画增强互动感
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TENCENT_SECRET_ID` | - | 腾讯云 SecretId（TTS 必需） |
| `TENCENT_SECRET_KEY` | - | 腾讯云 SecretKey（TTS 必需） |
| `HTTP_PORT` | 3000 | MCP HTTP Server 端口 |
| `WS_PORT` | 8765 | WebSocket Bridge 端口 |
