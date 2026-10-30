# 设置界面重构设计（托盘弹窗 + 完整设置窗）

> 状态：已定稿，按本文实现。方案来源：`.temp/artifacts/settings/` 中的 B（状态台）+ D（托盘弹窗）。
> 范围：`electron/` 主进程、设置窗 preload 与 `electron/settings/` 页面。角色窗 renderer 不在本次范围内。

## 1. 目标

1. 点击托盘图标弹出**快捷弹窗**（方案 D），放高频操作：查看运行状态、切换口型来源、缩放角色、显示/隐藏/重置角色窗、复制 MCP 命令。
2. 弹窗里的「更多设置…」打开**完整设置窗**（方案 B）：顶部常驻状态条，锚点目录加单页长滚动，口型来源旁边有实时电平。
3. 两个窗口共用一套 IPC、视图模型和状态推送，不各写一份。

非目标：

- 不做锁定穿透开关。锁定状态在角色窗 renderer 内部（`button-group.ts`），主进程没有这个状态的真值。后续可以加一条 renderer 命令。
- 不做从运行中进程挑选应用的选择器。application 模式仍然手填 `source_id` / `source_name`，选择器作为后续项。
- 不改设置文件 schema（`settings.json` 仍是 version 1）。

## 2. 现状问题

| 问题 | 位置 |
|---|---|
| macOS 上 `setContextMenu` 会接管左键，点击图标只能弹菜单 | `electron/tray.cjs` |
| 状态只用文字描述，没有好/坏的区分；权限缺失只在页脚提了一句 | `electron/settings/settings.html` |
| 角色窗缩放、位置已持久化，但设置页看不到也不能改 | `settings-view.cjs` 未下发 |
| 只能复制 Codex 命令 | `SETTINGS_COPY_CHANNEL` |
| 改口型来源后无法确认是否生效（没有电平反馈） | — |

## 3. 交互

### 3.1 托盘

| 平台 | 左键 | 右键 |
|---|---|---|
| macOS / Windows | 开关快捷弹窗 | 弹出原有上下文菜单（兜底） |
| Linux | 系统托盘一般不派发 click，沿用 `setContextMenu`，菜单里「打开设置」直接打开完整窗 | 同左 |

上下文菜单项：显示角色窗、隐藏角色窗、重置窗口位置、打开设置（完整窗）、退出。

### 3.2 快捷弹窗（D）

- 无边框窗口，宽 340，高度由内容决定（页面上报高度，主进程限制在 200–640 之间）。
- 位置：水平方向居中对齐托盘图标。托盘在屏幕上半部分时（macOS 菜单栏）弹窗放在图标下方，在下半部分时（Windows 任务栏）放在上方。结果再收进显示器的 workArea。
- 失焦时自动隐藏。点托盘图标的瞬间会先触发 blur 把弹窗隐藏，接着 click 又会把它打开。为避免这种「点了没关掉」，blur 隐藏后 250ms 内的 click 不再打开弹窗。
- Esc 关闭。
- 内容自上而下：
  1. 头部：应用名，bridge 与 listener 两个状态点。
  2. 权限告警条：只在 listener 为 `permission-denied` 时出现，带「授权」按钮，点击打开系统设置。
  3. 三个磁贴：显示/隐藏角色、重置位置、复制 MCP 命令（Codex）。
  4. 口型来源：四段分段控件和实时电平条。automatic / external 点了直接保存。application / custom 如果已经保存过对应字段就直接切换，否则打开完整窗并定位到口型来源。
  5. 缩放：50%–175% 滑杆，松手时写入。
  6. 链接：更多设置…、退出。

### 3.3 完整设置窗（B）

- 尺寸 860×640，最小 720×520，固定深色（`#0d1117` 底）。macOS 用 `titleBarStyle: 'hiddenInset'`，页面自己画可拖动的标题栏；其他平台用系统标题栏。
- 状态条（常驻）：
  - **bridge**：监听中 / 未监听，附 `127.0.0.1:<port>`。
  - **listener**：来自 `listener.status` 枚举（running / idle / starting / disabled / permission-denied / unavailable / error），附模式与 detail。
  - **permission**：由 listener 状态推导，见 §5.3；需要授权时显示「去开启」。
- 目录与分区：
  1. **口型来源**：四张模式卡片；按模式显示 `process_pattern` 或 `source_id`/`source_name`；实时电平图与读数；会话内状态日志（最近 6 条 listener 状态变化）；保存并应用。环境变量覆盖时显示提示。
  2. **MCP 连接**：Codex / Claude Code / URL 三个页签，下方一条命令和复制按钮；端口说明。
  3. **角色窗**：缩放滑杆、当前 bounds、显示/隐藏、重置位置。
  4. **通用**：登录时启动（仅 macOS / Windows）。
  5. **诊断**：`settings.json` 路径（在 Finder 中显示）、应用与 Electron 版本。
- 支持 `openFull(section)` 打开时直接滚动到指定分区。

## 4. 架构

```
Tray ──click──▶ SettingsWindows.togglePopover(trayBounds)
                     │
          ┌──────────┴───────────┐
     popover.html            settings.html（B）
          └─── settings-preload.cjs（同一份窄 API）───┘
                     │ IPC
              CompanionApp（组合根）
     settingsViewModel() · handleSettingsAction() · dispatchVoiceEvent → pushLevel
```

### 4.1 模块

| 模块 | 职责 | 依赖 |
|---|---|---|
| `electron/settings-windows.cjs`（新） | 两个设置窗的创建、定位、失焦隐藏、广播 view 与 level（level 节流到约 20Hz） | 注入 `BrowserWindow`、`screen` |
| `electron/settings-actions.cjs`（新） | 设置窗 action 负载的白名单校验，纯函数 | 无 |
| `electron/settings-channels.cjs` | 通道常量，新增 `action` 与 `level` | 无 |
| `electron/settings-preload.cjs` | 窄 API，两个窗口共用 | sandbox |
| `electron/settings-view.cjs` | 视图模型，新增 Claude Code 命令、权限推导、角色窗状态、版本、登录项 | `bridge-endpoint.cjs` |
| `electron/tray.cjs` | 左键回调带上托盘 bounds；右键弹菜单 | 注入 |
| `electron/companion-app.cjs` | 组装；执行 action；在 `dispatchVoiceEvent` 截取电平 | — |
| `electron/settings/` | `popover.html/js`、`settings.html` + `settings-renderer.js`、`shared.js`（文案/格式化），以及 `popover.css`、`settings.css` | — |

纯计算放在可以用 `node:test` 直接测的函数里，包括 `computePopoverPosition`、`parseSettingsAction`、`derivePermission`、`buildSettingsViewModel`。

### 4.2 IPC

| 通道 | 方向 | 说明 |
|---|---|---|
| `live2d:settings:get` | invoke | 取视图模型（已有） |
| `live2d:settings:save` | invoke | 保存 voiceSource（已有） |
| `live2d:settings:copy-command` | invoke | 参数 `kind`：`codex`（默认）/ `claude` / `url`（扩展） |
| `live2d:settings:changed` | main→页面 | 视图模型推送（已有，改为广播到两个窗口） |
| `live2d:settings:action` | invoke | 新增，参数 `{ type, ... }`，白名单见下 |
| `live2d:settings:level` | main→页面 | 新增，实时电平 `number`（0–1），只推送给可见窗口 |

action 白名单：

| type | 参数 | 行为 |
|---|---|---|
| `avatar-show` / `avatar-hide` / `avatar-reset` | — | 走 `showAvatarWindow` / `hideAvatarWindow` / `resetAvatarWindow` |
| `set-scale` | `scale: number` | `normalizeScale` 后通知 renderer 并持久化 |
| `open-full` | `section?: 'voice'\|'mcp'\|'avatar'\|'general'\|'diag'` | 打开完整窗并隐藏弹窗 |
| `close-popover` | — | 隐藏弹窗 |
| `fit-popover` | `height: number` | 弹窗按内容调整高度 |
| `open-permission-settings` | — | 打开「屏幕与系统音频录制」系统设置页（仅 darwin） |
| `reveal-settings-file` | — | 在文件管理器中显示 `settings.json` |
| `set-login-item` | `enabled: boolean` | `app.setLoginItemSettings`（仅 darwin / win32） |
| `quit` | — | 退出应用 |

安全约束沿用现有做法：sender 必须是两个设置窗之一（`isWindowSender`）；负载先经过 `parseSettingsAction` 校验，非法负载返回 `{ ok:false, error }`；preload 不暴露任意 IPC，通道字面量内联，由 `settings-channels.test.cjs` 读源文本防止漂移。外部 URL 只有固定的系统设置 deep link，页面无法传入 URL。

### 4.3 视图模型（新增字段）

```js
{
  // 已有：mcpUrl, codexCommand, voiceSource, listener, environmentOverridesVoice, bridgeListening, effectiveVoiceSource, message
  claudeCommand: 'claude mcp add --transport http live2d http://127.0.0.1:47832/mcp',
  port: 47832,
  permission: 'granted' | 'denied' | 'not-required' | 'unknown',
  avatar: { visible: true, x, y, width, height, scale },
  loginItem: { supported: true, openAtLogin: false },
  settingsFilePath: '…/settings.json',
  versions: { app: '0.1.0', electron: '39.8.10' },
}
```

### 4.4 推送时机

- `notifySettingsChanged` 广播到两个窗口（已有的调用点不变）。新增调用点：角色窗 show/hide/reset、缩放变化、登录项变化。角色窗拖动或手势缩放只在有可见设置窗时推送，避免拖动时空发 IPC。
- 电平：`dispatchVoiceEvent` 投递 `audio-level` 成功后调用 `settingsWindows.pushLevel(level)`，有可见设置窗时每 50ms 最多推送一次。

## 5. 视觉规范

### 5.1 快捷弹窗（跟随系统深浅色）

- 系统字体；macOS 用 `vibrancy: 'popover'`，页面背景半透明。
- tokens：`--sel` 系统蓝 `#0a6cff` / 深色 `#3d8bff`；卡片白 / `#323238`；ok `#1f9a48` / `#4cd07d`；warn `#b26a00` / `#f0a640`。
- 圆角：窗口 12，卡片 10，分段控件 7。

### 5.2 完整设置窗（固定深色）

- 背景 `#0d1117`，面板 `#121821`，分隔线 `#232c3a`，强调 `#7d93ff`，ok `#3fd07f`，warn `#f2b33d`，err `#ff6b6b`。
- 等宽字体用于键名、命令、端口与日志（`ui-monospace, SF Mono, Menlo`）。
- 状态灯：8px 圆点加 3px 同色 20% 光晕。

### 5.3 状态文案

| listener.status | 状态灯 | 文案 |
|---|---|---|
| running | ok | 正在捕获 |
| idle | ok | 等待声音（`no-matching-process` 时显示「未找到目标进程」） |
| starting | warn | 启动中 |
| disabled | 灰 | 仅外部事件 |
| permission-denied | warn | 需要授权 |
| unavailable | err | 不可用 |
| error | err | 出错 |

权限推导：`permission-denied` → denied；`running` 或 `idle` → granted；`disabled` → not-required；其余情况 → unknown。

### 5.4 CSP

两个页面都使用 `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:`。样式抽成同目录 css 文件，不再使用 inline style。

## 6. 测试

- `tray.test.cjs`：左键带 bounds 回调；darwin/win32 右键弹菜单、不调用 `setContextMenu`；linux 调用 `setContextMenu`。
- `settings-actions.test.cjs`（新）：白名单、参数校验、非法负载拒绝。
- `settings-windows.test.cjs`（新）：`computePopoverPosition` 覆盖菜单栏在上、任务栏在下、贴边收进 workArea；用 fake BrowserWindow 验证 blur 隐藏后的点击抑制和 level 节流。
- `settings-view.test.cjs`：Claude 命令、权限推导。
- `settings-channels.test.cjs`：新增通道的 preload 内联副本比对。
- 手工：`bun run dev` 后点托盘图标、切换模式、拖动缩放、打开完整窗、复制命令。

## 7. 后续

- 运行中进程选择器（application 模式）。
- 锁定穿透开关（需要 renderer 命令回报 locked 状态）。
- 完整窗浅色主题。
