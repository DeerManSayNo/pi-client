# DeerHux 项目审视报告

生成时间：2026-06-07  
项目路径：`/Users/huanghaoqi/Documents/DeerManNotesAir/LuYuAllProject/DeerManProject/DeerHux`  
版本：`0.6.12`

## 1. 审视范围与方法

本次审视覆盖：

1. 项目根目录与构建配置。
2. Next.js App Router 页面与 API Routes。
3. React 组件、Hooks 与主要 UI 状态流。
4. Agent 会话生命周期、SSE 流、会话文件读写。
5. 模型、技能、角色、系统提示词、记忆、MCP、扩展能力。
6. 文件访问安全边界与文件浏览/预览。
7. 定时任务、代码索引、并行/隔离 Agent 运行。
8. Tauri 桌面壳与打包链路。
9. 静态检查结果与明确风险点。

未执行 `next build`，遵循项目说明：开发阶段不要运行 `next build`，避免污染 `.next/` 并影响 `npm run dev`。

## 2. 执行检查结果

### 2.1 TypeScript 类型检查

命令：

```bash
PATH=/usr/local/bin:$PATH node_modules/.bin/tsc --noEmit
```

结果：通过，无输出。

说明：默认 shell 的 `PATH` 中没有 `node`，直接执行 `node_modules/.bin/tsc` 会失败：

```text
env: node: No such file or directory
```

本机 Node 位于：

```text
/usr/local/bin/node
```

### 2.2 ESLint

命令：

```bash
PATH=/usr/local/bin:$PATH npm run lint -- --max-warnings=0
```

结果：失败，但只有 warning，无 error。

```text
components/SkillsConfig.tsx
  763:6  warning  React Hook useCallback has a missing dependency: 'cwd'
  795:6  warning  React Hook useCallback has a missing dependency: 'cwd'
```

对应函数：

- `toggleDisableModelInvocation`：依赖数组为空，但使用了 `cwd`。
- `deleteSkill`：依赖数组为 `[selected]`，但使用了 `cwd`。

建议修复：

```tsx
}, [cwd]);
```

以及：

```tsx
}, [cwd, selected]);
```

### 2.3 Git 工作区状态

当前存在未提交修改与新增文件：

```text
 M app/api/models-config/test/route.ts
 M app/api/models/route.ts
 M app/api/skills/route.ts
 M components/AppShell.tsx
 M components/ChatInput.tsx
 M components/ModelsConfig.tsx
 M components/SkillsConfig.tsx
 M components/ToolPanel.tsx
 M hooks/useAgentSession.ts
 M lib/legacy-migration.ts
 M next.config.ts
?? app/api/extensions/
?? components/ExtensionsConfig.tsx
?? docs/pi-extension-support-plan.md
?? lib/extensions/
```

最近一次提交：

```text
42bd1ef refactor: rebrand pi-agent to DeerHux
```

建议：在继续大改前先确认这些变更是否属于同一任务，避免审视修复与既有开发内容混杂。

## 3. 技术栈与项目定位

### 3.1 项目定位

DeerHux 是 DeerHux Agent 的桌面客户端与 Web UI，核心能力包括：

- 浏览本地会话文件。
- 与 Agent 实时对话。
- SSE 流式输出。
- 会话分叉与会话内分支。
- 模型、技能、工具、角色、系统提示词配置。
- 文件浏览、文件预览、图片/音频预览。
- 定时任务。
- 并行 Agent 与隔离工作区运行。
- Tauri 桌面打包。

### 3.2 核心依赖

来自 `package.json`：

| 类别 | 依赖 |
|---|---|
| 框架 | `next@16.2.1`, `react@19.2.4`, `react-dom@19.2.4` |
| Agent SDK | `@earendil-works/pi-coding-agent@^0.75.5`, `@earendil-works/pi-ai@^0.75.5` |
| 桌面 | `@tauri-apps/api`, `@tauri-apps/cli`, `@tauri-apps/plugin-dialog` |
| 调度 | `node-cron` |
| Markdown/代码高亮 | `react-markdown`, `remark-gfm`, `react-syntax-highlighter` |
| 样式 | Tailwind CSS 4 |
| 语言 | TypeScript 5.9 |

## 4. 顶层目录审视

| 路径 | 作用 | 备注 |
|---|---|---|
| `app/` | Next.js App Router 页面与 API | API 是后端主入口 |
| `components/` | 前端 UI 组件 | 大部分业务 UI 在此 |
| `hooks/` | 自定义 React Hooks | 会话 Hook 复杂度最高 |
| `lib/` | 服务端/共享业务逻辑 | Agent、会话、调度、索引等核心逻辑 |
| `scripts/` | 构建/补丁/运行时脚本 | Node 下载与 core patch |
| `src-tauri/` | Tauri 2 桌面壳 | Rust 启动 Web Server + Webview |
| `docs/` | 设计与方案文档 | 包含扩展支持方案等 |
| `bin/` | npm bin 启动入口 | `deerhux` CLI |
| `.next/` | Next 构建/开发产物 | 已存在；开发时不应主动 build |
| `node_modules/` | 依赖 | 正常存在 |
| `src-tauri/target/` | Rust 构建产物 | 不应进入源码审视重点 |

## 5. 构建与运行流程

### 5.1 Web 开发模式

1. 执行：
   ```bash
   npm run dev
   ```
2. 实际命令：
   ```bash
   next dev -p 30141
   ```
3. 浏览器访问：
   ```text
   http://localhost:30141
   ```
4. `app/page.tsx` 渲染 `AppShell`。
5. 前端通过 `/api/*` 与本地服务通信。

### 5.2 Tauri 开发模式

1. 执行：
   ```bash
   npm run tauri dev
   ```
2. Tauri 配置中的 `beforeDevCommand` 会启动：
   ```bash
   npm run dev
   ```
3. Rust 端打开 Webview，地址为：
   ```text
   http://localhost:30141
   ```
4. Debug 构建会自动打开 devtools。

### 5.3 Tauri 发布构建

1. 执行：
   ```bash
   npm run tauri:build
   ```
2. 该命令先执行：
   ```bash
   npm run download:node
   ```
3. 再执行 Tauri build。
4. `tauri.conf.json` 中的 `beforeBuildCommand` 会运行：
   ```bash
   npm run build
   ```
5. Next 使用 `output: "standalone"`。
6. 打包资源包括：
   - `../.next/standalone`
   - `../.next/static`
   - `../public`
   - `../skills`
   - `resources/deerhux-server.js`
   - `binaries/node`

## 6. Next 配置审视

文件：`next.config.ts`

关键配置：

1. `output: "standalone"`：适配 Tauri 打包与 npm bin 分发。
2. `experimental.proxyClientMaxBodySize = 25MB`：支持图片以 base64 JSON 方式发送给 Agent。
3. `serverExternalPackages`：将 Agent SDK、cron、yaml、undici 等作为服务端外部包处理。
4. `allowedDevOrigins`：允许 `127.0.0.1` 与局域网 `192.168.*.*`。
5. `env` 注入：
   - `NEXT_PUBLIC_APP_VERSION`
   - `NEXT_PUBLIC_CORE_VERSION`

风险点：

- `coreVersion` 读取失败时为 `unknown`，UI 若展示版本应能处理。
- 当前 shell PATH 不含 `/usr/local/bin`，部分脚本在受限环境下可能找不到 Node。

## 7. 前端启动与 UI 主流程

### 7.1 页面入口

文件：`app/page.tsx`

流程：

1. 页面组件加载。
2. 渲染 `components/AppShell.tsx`。
3. `AppShell` 管理全局 UI 状态：
   - 当前会话。
   - 当前工作目录。
   - 标签页。
   - 文件查看器。
   - 配置弹窗。
   - 侧边栏刷新。
   - Agent 运行态。

### 7.2 `AppShell.tsx` 主要职责

文件：`components/AppShell.tsx`

核心职责：

1. 维护 Chat Tab 与文件 Tab。
2. 根据当前项目/会话驱动 `SessionSidebar`。
3. 渲染 `ChatWindow`。
4. 打开模型、技能、角色、记忆、MCP、系统提示词、定时任务等配置面板。
5. 支持文件自动打开策略：图片、音频、常见文本文件等。
6. 处理 URL/本地状态恢复。

### 7.3 标签页流程

相关文件：

- `components/TabBar.tsx`
- `components/FileViewer.tsx`
- `components/ChatWindow.tsx`

步骤：

1. 初始存在 Chat Tab。
2. 用户从文件浏览器或工具输出点击文件。
3. `AppShell` 调用 open file 逻辑。
4. 如果文件已打开，则激活对应 Tab。
5. 如果未打开，则新增文件 Tab。
6. `FileViewer` 根据文件类型渲染：
   - 文本/代码。
   - 图片。
   - 音频。
   - diff 视图。
   - 二进制/不可预览提示。

## 8. 会话浏览流程

### 8.1 会话列表接口

接口：`GET /api/sessions`  
文件：`app/api/sessions/route.ts`  
核心逻辑：调用 `listAllSessions()`。

### 8.2 会话读取底层

文件：`lib/session-reader.ts`

步骤：

1. `getSessionsDir()` 通过 Agent SDK 的 `getAgentDir()` 获取数据目录。
2. `listAllSessions()` 使用 5 秒 TTL 缓存。
3. 真正读取时调用 `SessionManager.listAll()`。
4. 将 SDK 的 SessionInfo 转成 UI 的 `SessionInfo`。
5. 建立 `sessionId -> filePath` 缓存。
6. 如果存在父会话路径，则转换为 `parentSessionId`。

### 8.3 会话详情接口

接口：`GET /api/sessions/[id]`  
文件：`app/api/sessions/[id]/route.ts`

步骤：

1. 根据 session id 调用 `resolveSessionPath()`。
2. 找不到则返回 404。
3. 使用 `SessionManager.open(filePath)` 打开 jsonl。
4. 获取 entries 与 leafId。
5. 调用 `buildSessionContext(entries, leafId)`。
6. 读取 header 与文件 mtime。
7. 尝试解析 `parentSession` 元数据。
8. 找到第一条用户消息作为 firstMessage。
9. 如果 query 包含 `includeState`，额外返回内存中 Agent 状态。
10. 返回：
    - `sessionId`
    - `filePath`
    - `info`
    - `leafId`
    - `context`
    - 可选 `agentState`

### 8.4 会话上下文构建

文件：`lib/session-reader.ts` 的 `buildSessionContext()`

步骤：

1. 以 entry id 建立 Map。
2. 调用 SDK 的 `buildSessionContext()` 生成基础上下文。
3. 根据 leafId 找目标叶子。
4. 从叶子向根回溯，得到当前分支路径。
5. 扫描路径中的自定义 `role_profile`，得到 `roleId`。
6. 处理 compaction：
   - 如果存在压缩条目，把 synthetic summary 映射到 compaction id。
   - 根据 `firstKeptEntryId` 计算保留消息。
7. 构造 `entryIds`，与 `messages` 平行对应。
8. 将 SDK 的 `compactionSummary` 转成 UI 可渲染的 user message。
9. 调用 `normalizeToolCalls()` 统一 toolCall 字段。
10. 返回 UI 所需 context。

## 9. 新会话发送消息流程

接口：`POST /api/agent/new`  
文件：`app/api/agent/new/route.ts`

前端入口通常来自 `ChatWindow` / `useAgentSession`。

完整步骤：

1. 前端提交：
   - `cwd`
   - prompt command
   - 可选 `provider`
   - 可选 `modelId`
   - 可选 `toolNames`
   - 可选 `thinkingLevel`
   - 可选 `roleId`
2. 后端校验 `cwd` 是否存在。
3. 将模型、工具、推理等级、角色字段从 command 中拆出。
4. 构造临时 key：`__new__${Date.now()}`。
5. 调用：
   ```ts
   startRpcSession(tempKey, "", cwd, toolNames)
   ```
6. `startRpcSession` 创建真实 AgentSession，并返回真实 `sessionId`。
7. 调用 `addAllowedRoot(cwd)`，让文件浏览/预览允许访问该项目目录。
8. 如果指定模型，发送 `set_model`。
9. 如果指定 thinking level，发送 `set_thinking_level`。
10. 如果指定 role，发送 `set_role`。
11. 发送真正 prompt command。
12. 失效会话列表缓存。
13. 返回：
    ```json
    { "success": true, "sessionId": "...", "data": "..." }
    ```

## 10. 既有会话发送消息流程

接口：`POST /api/agent/[id]`  
文件：`app/api/agent/[id]/route.ts`

步骤：

1. 读取 URL 中的 `id`。
2. 解析 request body。
3. 优先检查内存中是否已有运行中的 wrapper：
   ```ts
   getRpcSession(id)
   ```
4. 如果存在且 alive，直接 `existing.send(body)`。
5. 如果不存在：
   1. `resolveSessionPath(id)` 找 jsonl 文件。
   2. `SessionManager.open(filePath)` 打开。
   3. 读取 cwd。
   4. 构建 context。
   5. 调用 `startRpcSession(id, filePath, cwd, undefined, context.roleId)`。
   6. `addAllowedRoot(cwd)`。
6. 发送 command。
7. 返回结果。

## 11. SSE 实时流流程

接口：`GET /api/agent/[id]/events`  
文件：`app/api/agent/[id]/events/route.ts`

步骤：

1. 强制动态：`dynamic = "force-dynamic"`。
2. 读取 session id。
3. 优先复用内存中的 rpc session。
4. 如果 session 不存在：
   1. resolve jsonl path。
   2. 读取 cwd。
   3. 调用 `startRpcSession()`。
   4. `addAllowedRoot(cwd)`。
5. 创建 `ReadableStream`。
6. 立即发送：
   ```json
   { "type": "connected", "sessionId": "..." }
   ```
7. 订阅 Agent 事件。
8. 如果事件是 `agent_file_changed`，把变更文件所在目录加入 allowed roots。
9. 每个事件序列化为 SSE：
   ```text
   data: {...}\n\n
   ```
10. 每 30 秒发送 heartbeat：
    ```text
    :\n\n
    ```
11. request abort 时取消订阅、清理 heartbeat、关闭 controller。

风险点：

- `cleanup()` 中直接 `controller.close()`，如果已关闭可能抛错；目前没有 try/catch 包裹 `controller.close()`。
- abort listener 未移除，通常影响不大，但可以更严谨。

## 12. AgentSession 生命周期

核心文件：`lib/rpc-manager.ts`

### 12.1 Registry 设计

1. 一个 `AgentSessionWrapper` 对应一个 session id。
2. Registry 存在 `globalThis.__deerhuxSessions`。
3. 这样可以跨 Next.js 热更新保留 session。
4. 启动锁存在 `globalThis.__deerhuxStartLocks`。
5. 避免并发请求重复创建同一个 session。

### 12.2 Wrapper 关键状态

`AgentSessionWrapper` 管理：

- 事件 listeners。
- 待配对工具事件。
- SSE 订阅取消函数。
- idle timer。
- alive 状态。
- roleId。
- 临时 role settings。
- baseSystemPrompt。
- 最近事件类型。
- 最近事件时间。
- 最近内容时间。
- 事件计数。
- streaming / compacting 状态。

### 12.3 工具执行模式

文件：`lib/rpc-manager.ts`

规则：

| 工具 | 模式 |
|---|---|
| `read` | parallel |
| `grep` | parallel |
| `find` | parallel |
| `ls` | parallel |
| `code_search` | parallel |
| `bash` | sequential |
| `edit` | sequential |
| `write` | sequential |

如果环境变量 `PI_DISABLE_PARALLEL_TOOLS=1` 或 `true`，则强制 sequential。

### 12.4 自动重试硬化

`hardenAutoRetry()` 调整 Agent SDK 行为：

1. 最小 retry delay 不低于 5000ms。
2. 对 transport close / websocket close 等错误做过滤。
3. 如果 assistant 已有足够内容，则避免无意义 retry。
4. retry 前等待 1000ms 安静窗口。

### 12.5 系统提示词同步

`setEffectiveSystemPrompt()` 同时写入：

1. `session.agent.state.systemPrompt`
2. 私有 `_baseSystemPrompt`

原因：SDK 的 `AgentSession.prompt()` 每轮会从私有 base prompt 重置 state prompt；只改 state 会导致 UI 预览正确但下一轮实际 prompt 仍旧。

## 13. 前端会话 Hook 流程

核心文件：`hooks/useAgentSession.ts`

### 13.1 主要职责

1. 加载会话详情。
2. 加载模型列表。
3. 创建新会话。
4. 向既有会话发送命令。
5. 连接 SSE。
6. 合并 streaming message。
7. 处理 tool call / tool result。
8. 处理 agent_end、compaction、abort、continue。
9. 维护 watchdog 与自动恢复。
10. 压缩展开后的 skill 文本供 UI 展示。

### 13.2 Skill 展示压缩

当用户输入 `/skill:name args` 后，SDK 可能把消息保存为完整 skill 内容：

```xml
<skill name="xxx" location="...">
...
</skill>

args
```

`compressSkillText()` 会在 UI 展示时还原成：

```text
/skill:xxx args
```

这只影响显示，不改变模型实际接收内容。

### 13.3 Streaming reducer

状态：

```ts
{
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}
```

动作：

- `start`
- `update`
- `end`
- `reset`

### 13.4 模型缓存

`fetchModels()` 使用模块级 `modelsPromise` 合并并发请求，避免同一时刻重复请求 `/api/models`。

### 13.5 Watchdog

Hook 中定义：

- `eventIdleMs`
- `contentIdleMs`
- `eventThresholdMs`
- `contentThresholdMs`
- `AutoRecoveryMode`
- `StallLevel`

用途：检测 Agent 卡住，并支持保守/激进自动恢复。

## 14. 模型配置流程

### 14.1 模型列表接口

接口：`GET /api/models`  
文件：`app/api/models/route.ts`

步骤：

1. 获取 agentDir。
2. 从 `models.json` 读取用户配置模型。
3. 创建 `AuthStorage` 与 `ModelRegistry`。
4. 获取 registry 可用模型。
5. 只保留在 `models.json` 中配置过的模型。
6. 合并 registry 信息与配置文件信息。
7. 使用 `getSupportedThinkingLevels()` 计算推理等级。
8. 从 `SettingsManager` 读取默认 provider/model。
9. 只有默认模型存在于配置模型中才返回。
10. 返回：
    - `models`
    - `modelList`
    - `defaultModel`
    - `thinkingLevels`
    - `thinkingLevelMaps`

### 14.2 模型能力接口

接口：`POST /api/models`  
用途：返回指定模型的 input 能力。

步骤：

1. 接收 `provider`, `modelId`。
2. registry.find。
3. 返回：
   ```json
   { "input": ["text"] }
   ```
   或模型声明的真实 input。

### 14.3 模型配置读写

接口：`GET/PUT /api/models-config`  
文件：`app/api/models-config/route.ts`

作用：读取/写入 Agent 数据目录下的 `models.json`。

### 14.4 模型测试接口

接口：`POST /api/models-config/test`  
文件较复杂，用于测试模型文本/图片能力。

风险点：

- 该 route 有 261 行，建议保持测试超时与错误分类清晰。
- 如果模型测试中创建临时资源，需确认异常路径下清理完整。

## 15. 技能系统流程

### 15.1 技能列表接口

接口：`GET /api/skills`  
职责：列出可用 skills，兼容 DeerHux 与旧 Pi Agent skill 目录。

### 15.2 技能安装接口

接口：`POST /api/skills/install`  
流程：

1. 接收 skill 信息。
2. 通过 `runNpx()` 执行安装/下载相关动作。
3. 调用 legacy migration 将旧目录或项目目录同步到 DeerHux 目录。
4. 返回安装结果。

### 15.3 技能搜索接口

接口：`POST /api/skills/search`  
流程：

1. 接收 query 和 limit。
2. 使用 npx 或远程 API 搜索。
3. 解析安装量与搜索结果。
4. 返回 UI 需要的 SkillSearchResult。

### 15.4 技能 UI

文件：`components/SkillsConfig.tsx`

职责：

- 展示全局/项目/路径来源 skills。
- 安装新 skill。
- 删除 skill。
- 启用/禁用。
- 设置 `disableModelInvocation`。
- 展示 skill 详情。

已发现问题：两个 `useCallback` 缺少 `cwd` 依赖，见第 2.2 节。

## 16. 角色、记忆与系统提示词

### 16.1 角色

核心文件：`lib/roles.ts`

能力：

1. 内置默认角色。
2. 读取全局角色：`~/.deerhux/agent/roles.json`。
3. 读取项目角色：`<cwd>/.agents/roles.json`。
4. 创建、更新、删除、移动角色。
5. 为角色添加长期设定。
6. 将角色设定组合进系统提示词。
7. 识别用户是否有“保存为角色设定”的意图。

API：

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/roles` | GET | 列出角色 |
| `/api/roles` | POST | 创建角色 |
| `/api/roles/[id]` | PATCH | 修改角色 |
| `/api/roles/[id]` | DELETE | 删除角色 |
| `/api/roles/[id]/settings` | POST | 添加角色设定 |

### 16.2 记忆

核心文件：`lib/memory.ts`

能力：

1. 读取全局 memory 文件。
2. 写入全局 memory。
3. 组合成 system prompt 片段。

API：`GET/PUT /api/memory`

UI：`components/MemoryConfig.tsx`

### 16.3 系统提示词

核心文件：`lib/system-prompt-decomposer.ts`

能力：

1. 将完整 system prompt 分解为多个 section。
2. 重新组合 section。
3. 创建/更新/删除系统提示词版本。
4. 按角色读取配置。
5. 全局/角色级启用禁用 section。
6. 根据允许的 skills 过滤 prompt 中的 skill 内容。

API：

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/system-prompt` | GET | 读取系统提示词配置 |
| `/api/system-prompt` | PATCH | 修改 section 配置 |
| `/api/system-prompt` | POST | 创建版本 |
| `/api/system-prompt/[id]` | GET | 读取版本 |
| `/api/system-prompt/[id]` | PATCH | 更新版本 |
| `/api/system-prompt/[id]` | DELETE | 删除版本 |

UI：`components/SystemPromptConfig.tsx`

## 17. 文件访问与文件浏览流程

### 17.1 安全边界

核心文件：`lib/file-access.ts`

核心规则：

1. 文件访问不允许任意路径。
2. 允许根目录来自：
   - 所有会话的 cwd。
   - 运行中新加入的 extra roots。
   - home 下的 legacy default cwd 目录。
3. allowed roots 有 5 秒 TTL 缓存。
4. 路径比较时处理 Windows 盘符与 UNC 路径。
5. 通过 realpath/native 规避部分符号链接绕过。

### 17.2 文件接口

接口：`GET /api/files/[...path]`  
文件：`app/api/files/[...path]/route.ts`

步骤：

1. 从 route segments 还原文件路径。
2. 获取 allowed roots。
3. 校验 target 是否在 allowed roots 中。
4. 如果是目录：
   - 读取 children。
   - 过滤 `node_modules`, `.git`, `.next`, `target` 等。
   - 返回文件/目录列表。
5. 如果是图片：
   - 检查大小限制 10MB。
   - 返回 image mime。
6. 如果是音频：
   - 支持 Range 请求。
   - 返回 audio mime。
7. 如果是文本：
   - 限制预览大小 256KB。
   - 返回内容与 language。
8. 其他情况返回不可预览信息或二进制响应。

### 17.3 文件打开 UI

相关文件：

- `components/FileExplorer.tsx`
- `components/FileViewer.tsx`
- `components/FileIcons.tsx`
- `components/ChangedFilesList.tsx`

文件浏览步骤：

1. `FileExplorer` 根据 cwd 请求 `/api/files/...`。
2. 目录节点懒加载。
3. 点击文件调用 `onOpenFile`。
4. `AppShell` 新增/激活文件 Tab。
5. `FileViewer` 请求文件内容并渲染。

## 18. 定时任务流程

### 18.1 API

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/scheduler` | GET | 列出任务 |
| `/api/scheduler` | POST | 创建任务 |
| `/api/scheduler/[id]` | GET | 获取单个任务 |
| `/api/scheduler/[id]` | PATCH | 修改任务 |
| `/api/scheduler/[id]` | DELETE | 删除任务 |

### 18.2 Engine

文件：`lib/scheduler/engine.ts`

步骤：

1. `startScheduler()` 只启动一次。
2. 从 store 加载任务。
3. 每个 enabled task 调用 `scheduleJob()`。
4. 校验 cron 表达式。
5. 如果已有同 id job，先 unschedule。
6. 使用本机时区注册 node-cron。
7. 触发时调用 `executeTask(task)`。
8. 修改任务时先 unschedule，再按 enabled 状态重建。
9. 删除任务时同时停止 job 与删除持久化记录。

### 18.3 Runner

文件：`lib/scheduler/runner.ts`

执行 prompt task 步骤：

1. 动态导入 Agent SDK。
2. 创建 sessionManager。
3. 默认启用全部编码工具：`read,bash,edit,write,grep,find,ls`。
4. 创建 AgentSession。
5. 如果配置了模型，尝试设置模型。
6. 订阅 session 事件。
7. 发送 prompt。
8. 等待 `agent_end`。
9. 抓取最后一条 assistant 输出。
10. 检查 errorMessage。
11. 写入任务日志。
12. 单次最长等待 30 分钟。

风险点：

- Runner 创建的 session 没有通过 `rpc-manager`，因此不继承 Web 层所有 role/system prompt/allowed root 逻辑。
- `executeTask(task)` 使用传入 task 的旧 `runCount` 加 1，如果同一任务并发触发可能存在计数竞争。

## 19. 代码索引流程

相关文件：

- `lib/code-index/config.ts`
- `lib/code-index/paths.ts`
- `lib/code-index/scanner.ts`
- `lib/code-index/database.ts`
- `lib/code-index/indexer.ts`
- `lib/code-index/search.ts`

API：

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/index/status` | GET | 获取索引状态 |
| `/api/index/refresh` | POST | 重新扫描并写入索引 |
| `/api/index/search` | POST | 搜索索引 |

流程：

1. 根据 cwd hash 计算索引路径。
2. scanner 遍历项目文件。
3. 忽略二进制与常见无关目录。
4. 写入 JSON 数据库。
5. 搜索时读取索引，按 terms 匹配内容并生成 snippet。
6. `rpc-manager` 中注册/配置了 `code_search` 工具的 parallel 执行模式。

## 20. 并行 Agent 与隔离运行

### 20.1 普通并行运行

相关文件：

- `lib/parallel-agent/orchestrator.ts`
- `lib/parallel-agent/run-store.ts`
- `lib/parallel-agent/worker-session.ts`
- `lib/parallel-agent/prompts.ts`

API：

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/parallel-runs` | POST | 启动并行 run |
| `/api/parallel-runs` | GET | 列出 runs |
| `/api/parallel-runs/[runId]` | GET | 获取状态 |
| `/api/parallel-runs/[runId]/events` | GET | SSE 事件 |
| `/api/parallel-runs/[runId]/abort` | POST | 中止 |

流程：

1. 前端提交问题与 worker specs。
2. orchestrator 创建 run。
3. 每个 worker 使用独立 Agent session 执行子任务。
4. run-store 维护状态与事件订阅。
5. SSE 向前端推送 worker 进度。

### 20.2 隔离运行

相关文件：

- `lib/parallel-agent/isolated-orchestrator.ts`
- `lib/parallel-agent/worktree.ts`
- `lib/parallel-agent/isolated-types.ts`

API：

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/isolated-runs` | POST | 启动隔离 run |
| `/api/isolated-runs` | GET | 列出 runs |
| `/api/isolated-runs/[runId]` | GET | 状态 |
| `/api/isolated-runs/[runId]/events` | GET | SSE |
| `/api/isolated-runs/[runId]/abort` | POST | 中止 |
| `/api/isolated-runs/[runId]/diffs` | GET | 获取 diff |
| `/api/isolated-runs/[runId]/apply` | POST | 应用 patch |

隔离 run 步骤：

1. 判断 cwd 是否 Git 仓库。
2. Git 仓库创建 worktree；非 Git 创建临时 copy。
3. 每个 worker 在隔离目录中运行。
4. worker 使用完整编码工具。
5. 采集 Agent 事件并写入 run events。
6. worker 完成后生成 diff。
7. 用户可调用 apply 接口将 patch 应用回主工作区。
8. 可中止并清理临时目录/worktree。

风险点：

- apply patch 前需要确保主工作区状态安全；`worktree.ts` 有 `getRepoStatus()`，但 UI/API 是否强制检查需要持续确认。
- 非 Git 临时 copy 对大项目成本较高。

## 21. MCP 与扩展系统

### 21.1 MCP 配置

文件：`lib/mcp-config.ts`  
API：`GET/PUT /api/mcp-config`  
UI：`components/McpConfig.tsx`

能力：

1. 读取本地 MCP server 配置。
2. 规范化 server 字段。
3. 写入配置。
4. UI 可编辑 command、args、env、url、transport 等。

### 21.2 扩展视图

新增文件：

- `app/api/extensions/route.ts`
- `components/ExtensionsConfig.tsx`
- `lib/extensions/*`

流程：

1. 前端请求 `/api/extensions?cwd=...`。
2. 后端调用 `loadExtensionsView(cwd)`。
3. 加载 compatible skill sources。
4. 加载 MCP server views。
5. 归一化诊断信息。
6. UI 分组展示扩展来源、数量与诊断。

当前这些文件为未跟踪新增文件，建议单独提交并补充测试。

## 22. API 路由总览

| Route | Methods | 主要依赖/作用 |
|---|---|---|
| `/api/home` | GET | 返回 home dir |
| `/api/default-cwd` | POST | 创建/返回默认 cwd |
| `/api/sessions` | GET | 会话列表 |
| `/api/sessions/new` | POST | 返回 410，旧接口废弃 |
| `/api/sessions/[id]` | GET/PATCH/DELETE | 会话详情、重命名、删除 |
| `/api/sessions/[id]/context` | GET | 指定 leaf 上下文 |
| `/api/agent/new` | POST | 新建会话并发送首条消息 |
| `/api/agent/[id]` | GET/POST | Agent 状态、发送命令 |
| `/api/agent/[id]/events` | GET | Agent SSE |
| `/api/agent/running` | GET | 运行中会话状态 |
| `/api/models` | GET/POST | 模型列表、模型 input 能力 |
| `/api/models-config` | GET/PUT | models.json 读写 |
| `/api/models-config/test` | POST | 模型连通性/能力测试 |
| `/api/auth/providers` | GET | 认证 provider |
| `/api/auth/all-providers` | GET | 所有 provider |
| `/api/auth/login/[provider]` | POST/GET | OAuth 登录 |
| `/api/auth/logout/[provider]` | POST | 登出 |
| `/api/auth/api-key/[provider]` | GET/POST/DELETE | API Key 管理 |
| `/api/files/[...path]` | GET | 文件/目录读取与预览 |
| `/api/files/reveal` | POST | 系统文件管理器中显示 |
| `/api/skills` | GET/DELETE/PATCH | 技能列表、删除、修改 |
| `/api/skills/search` | POST | 搜索技能 |
| `/api/skills/install` | POST | 安装技能 |
| `/api/roles` | GET/POST | 角色列表/创建 |
| `/api/roles/[id]` | PATCH/DELETE | 角色更新/删除 |
| `/api/roles/[id]/settings` | POST | 角色设定追加 |
| `/api/system-prompt` | GET/PATCH/POST | 系统提示词配置/版本 |
| `/api/system-prompt/[id]` | GET/PATCH/DELETE | 系统提示词版本操作 |
| `/api/memory` | GET/PUT | 全局记忆 |
| `/api/mcp-config` | GET/PUT | MCP 配置 |
| `/api/extensions` | GET | 扩展视图 |
| `/api/scheduler` | GET/POST | 定时任务列表/创建 |
| `/api/scheduler/[id]` | GET/PATCH/DELETE | 定时任务详情/修改/删除 |
| `/api/index/status` | GET | 代码索引状态 |
| `/api/index/refresh` | POST | 刷新代码索引 |
| `/api/index/search` | POST | 搜索代码索引 |
| `/api/parallel-runs` | GET/POST | 并行 run |
| `/api/parallel-runs/[runId]` | GET | 并行 run 状态 |
| `/api/parallel-runs/[runId]/events` | GET | 并行 run SSE |
| `/api/parallel-runs/[runId]/abort` | POST | 中止并行 run |
| `/api/isolated-runs` | GET/POST | 隔离 run |
| `/api/isolated-runs/[runId]` | GET | 隔离 run 状态 |
| `/api/isolated-runs/[runId]/events` | GET | 隔离 run SSE |
| `/api/isolated-runs/[runId]/abort` | POST | 中止隔离 run |
| `/api/isolated-runs/[runId]/diffs` | GET | diff |
| `/api/isolated-runs/[runId]/apply` | POST | 应用 patch |

## 23. Tauri 桌面壳审视

### 23.1 配置

文件：`src-tauri/tauri.conf.json`

关键点：

1. 产品名：`DeerHux`。
2. identifier：`com.deermansayno.deerhux`。
3. devUrl：`http://localhost:30141`。
4. 打包目标：`dmg`, `nsis`。
5. 外部二进制：`binaries/node`。
6. macOS 最低版本：11.0。
7. Windows NSIS currentUser 安装。
8. CSP 为 null。

风险点：

- `csp: null` 对桌面应用开发便利，但安全性较弱；如果未来加载远程内容，应收紧 CSP。

### 23.2 Rust 启动流程

文件：`src-tauri/src/lib.rs`

Debug：

1. Webview 打开 `http://localhost:30141`。
2. 打开 devtools。

Release：

1. 找可用本地端口。
2. 找 app resource dir。
3. 找随包 node binary。
4. macOS 下将 node 复制到临时目录，避免 Dock 图标问题。
5. 启动 `deerhux-server.js`。
6. 设置环境变量：
   - `DEERHUX_RESOURCE_DIR`
   - `PORT`
7. 轮询 HTTP server，最多约 10 秒。
8. Webview 打开 `http://127.0.0.1:{port}`。
9. macOS 使用 overlay titlebar。
10. Windows 使用无边框窗口。

## 24. npm bin 启动流程

文件：`bin/deerhux.js`

步骤：

1. 定位包目录。
2. 检查 `.next` 是否存在。
3. 解析 Next CLI 入口。
4. 解析 CLI 参数 `--port/-p` 与 `--hostname/-H`。
5. 默认端口 `30141`。
6. 使用当前 Node 执行：
   ```bash
   next start -p <port>
   ```
7. 监听 stdout 中的 `Ready`。
8. Ready 后自动打开浏览器。

风险点：

- 如果安装包中 `.next` 不完整，只会提示 `Build artifacts not found`。
- 该脚本依赖当前 `process.execPath`，用户环境中的 Node 必须可用。

## 25. 主要风险与改进建议

### P0 / 需要优先处理

1. **ESLint warning 导致严格 lint 失败**
   - 文件：`components/SkillsConfig.tsx`
   - 修复依赖数组即可。

2. **执行环境 PATH 不包含 Node**
   - 当前工具环境里 `node` 不在 PATH。
   - 建议在开发文档或脚本中说明，或统一通过 Tauri 内嵌 Node / npm 环境处理。

### P1 / 建议尽快处理

1. **SSE cleanup 健壮性**
   - 文件：`app/api/agent/[id]/events/route.ts`
   - 建议对 `controller.close()` 加 try/catch，并移除 abort listener。

2. **调度任务并发与 runCount 竞争**
   - 文件：`lib/scheduler/runner.ts`
   - 建议 store 层提供原子 increment 或执行前重新读取最新 task。

3. **Tauri CSP 为 null**
   - 如果完全本地可接受；若未来加载外部资源，应配置 CSP。

4. **大组件复杂度过高**
   - `AppShell.tsx`: 1775 行。
   - `ChatInput.tsx`: 1770 行。
   - `ModelsConfig.tsx`: 1676 行。
   - `SessionSidebar.tsx`: 1618 行。
   - `useAgentSession.ts`: 1384 行。
   - 建议按状态、请求、子视图继续拆分。

### P2 / 持续优化

1. **API Routes 缺少统一错误格式**
   - 当前大多返回 `{ error: String(error) }`。
   - 可统一为 `{ success:false, error:{ code,message } }`。

2. **会话缓存 TTL 固定 5 秒**
   - 当前简单有效。
   - 如果会话数量很多，可考虑基于文件 watcher 或增量更新。

3. **文件访问 allowed roots 依赖会话 cwd**
   - 新项目未创建会话前，需确保 cwd 被 addAllowedRoot。
   - 当前新会话流程已处理。

4. **新增扩展系统未提交**
   - `lib/extensions/*` 与 `components/ExtensionsConfig.tsx` 是新增文件。
   - 建议补充使用说明与单独提交。

## 26. 建议的下一步操作清单

1. 修复 `components/SkillsConfig.tsx` 两个 hook 依赖 warning。
2. 再运行：
   ```bash
   PATH=/usr/local/bin:$PATH npm run lint -- --max-warnings=0
   ```
3. 再运行：
   ```bash
   PATH=/usr/local/bin:$PATH node_modules/.bin/tsc --noEmit
   ```
4. 为新增扩展系统补充最小文档：
   - 数据来源。
   - UI 入口。
   - 与 skills/MCP 的关系。
5. 将超大组件拆分为：
   - 容器组件。
   - 请求 hooks。
   - 纯展示组件。
   - 类型定义文件。
6. 给关键 API 加最小集成测试或 smoke test 脚本：
   - `/api/sessions`
   - `/api/models`
   - `/api/files`
   - `/api/scheduler`
7. 审查 Tauri release 下 `deerhux-server.js` 的日志落地与错误提示。
8. 确认 `.next/`、`src-tauri/target/`、`.codegraph/` 等产物均不进入发布源码提交。

## 27. 总结

整体来看，DeerHux 已经形成了较完整的桌面 Agent 客户端架构：

- Next.js 负责 UI 与本地 API。
- AgentSession 在服务端进程内运行，并通过 SSE 推送状态。
- 会话文件继续采用 DeerHux/Agent SDK 的 jsonl 文件格式。
- Tauri release 通过内嵌 Node + standalone Next server 提供桌面体验。
- 模型、技能、角色、系统提示词、记忆、MCP、调度、并行 Agent 等能力已经具备完整雏形。

当前最明确的问题不是类型错误，而是工程治理层面：

1. 少量 lint warning。
2. 超大前端组件需要拆分。
3. 新增扩展系统还未提交，需整理边界。
4. 部分运行时流程可进一步增强异常处理与安全策略。

建议先修复 lint，再将新增扩展能力独立提交，然后进入组件拆分和 API 错误格式统一阶段。
