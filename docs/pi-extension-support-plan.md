# DeerHux 支持 Pi 扩展完整方案

> 版本：v0.2  
> 适用项目：DeerHux  
> 核心方向：**DeerHux Extension Facade over Pi ResourceLoader / Extension Runtime**  
> 目标：在不破坏现有 DeerHux 架构的前提下，优先复用 Pi 已有 ResourceLoader / Extension Runtime，DeerHux 只做配置来源归一、UI 展示、状态 overlay、安全策略和 Runtime 接入编排。

---

## 1. 背景

DeerHux 当前已经高度依赖 Pi 生态：

- 核心 Agent Runtime 来自 `@earendil-works/pi-coding-agent`
- 模型能力来自 `@earendil-works/pi-ai`
- 会话管理依赖 Pi 的 `SessionManager`
- Skills 安装已经通过 `npx skills add --agent pi` 接入 Pi 技能生态
- 当前 `app/api/skills/route.ts` 已经使用 `DefaultResourceLoader.getSkills()` 读取 skills
- Pi SDK 已经导出 `DefaultResourceLoader`、`discoverAndLoadExtensions`、`createExtensionRuntime`、`defineTool`、`LoadExtensionsResult`
- `createAgentSession()` 已经返回 `extensionsResult`
- 项目中已有 `.pi` 到 `.deerhux` 的 legacy migration 逻辑

因此 DeerHux 支持 Pi 扩展时，不应另起一套完整插件系统，而应在 Pi 现有能力之上建立 DeerHux 自己的 facade 层。

---

## 2. 核心结论

推荐架构从：

```txt
DeerHux 自研 Extension Layer
```

调整为：

```txt
DeerHux Extension Facade
        ↓
Pi DefaultResourceLoader / Extension Runtime
        ↓
createAgentSession()
```

也就是：

- Pi Runtime 负责真正的资源发现、skills 加载、extension runtime、tool definition 协议。
- DeerHux 负责 UI 管理、来源展示、状态 overlay、配置合并、安全提示、MCP 适配、session 生命周期编排。

这样可以避免出现两套扩展系统：

```txt
Pi Extension Runtime
DeerHux Custom Extension Runtime
```

从而降低维护成本和升级冲突。

---

## 3. 目标

本方案目标是让 DeerHux 支持以下能力：

1. 兼容 Pi Skills / `SKILL.md`
2. 复用 Pi `DefaultResourceLoader` 作为 skills 真源
3. 展示 skills、MCP、扩展工具、roles 的统一扩展视图
4. 兼容 `.deerhux`、`.pi`、`.agents` 多来源配置，但不默认静默复制所有 `.pi` 内容
5. 支持 MCP 配置多来源读取和归一化
6. 中期支持 MCP tools 注入 Agent runtime
7. 长期支持 Pi Extension Runtime / package extension 的可视化管理
8. 不破坏现有 session、tools、roles、skills、MCP 配置功能

---

## 4. 非目标

初期不建议直接实现：

- 完整插件市场
- 自研独立 package tool 插件协议
- 热插拔长期运行扩展进程
- 复杂权限沙箱
- 实时文件监听
- 完全替代 Pi Runtime
- 自动复制所有 `.pi` 配置到 `.deerhux`
- MCP runtime 立即接入

package tool / JS 插件如果后续要做，应优先复用 Pi 已有 Extension Runtime，而不是新建一套 `activate(context)` 协议。

---

## 5. 设计原则

### 5.1 优先复用 Pi Runtime

DeerHux 不重新实现 Pi 已经提供的 extension / skill runtime。

优先复用：

```ts
DefaultResourceLoader
createAgentSession().extensionsResult
discoverAndLoadExtensions
createExtensionRuntime
defineTool
```

DeerHux 新增层只作为 facade：

```txt
读取 Pi Runtime 结果
归一化成 UI DTO
叠加 DeerHux 状态文件
控制启用 / 禁用
处理导入、提示、安全、缓存
```

### 5.2 扩展发现和 Runtime 注入分离

Facade 层负责：

- 获取 Pi ResourceLoader 的真实加载结果
- 合并 DeerHux MCP 配置
- 合并 `.pi` / `.deerhux` / `.agents` 的只读兼容来源
- 去重
- 生成 UI DTO
- 生成 diagnostics

`rpc-manager.ts` 只负责：

- 创建 ResourceLoader / Facade Runtime 输入
- 将可用 tools 注入 `createAgentSession()`
- 管理 session 生命周期
- 在 destroy 时清理 MCP client / 子进程

### 5.3 UI 展示结果必须尽量等同 Runtime 实际结果

Skills 展示不能和 Agent 实际使用的 skills 脱节。

因此 skills 初期必须以 `DefaultResourceLoader.getSkills()` 为真源，而不是 DeerHux 手写目录扫描为真源。

### 5.4 兼容 `.pi`，但不盲目复制 `.pi`

推荐策略：

- 读取 `.pi` 作为兼容来源
- UI 标记来源
- 用户需要时手动“导入到 DeerHux”
- 不默认静默复制所有 `.pi` 配置

这需要配套调整 `lib/legacy-migration.ts`，否则旧迁移逻辑仍会把 `.pi` skills / configs 自动复制到 `.deerhux`。

### 5.5 DeerHux 主动配置优先

`.deerhux` 是 DeerHux 用户主动配置，优先级高于 legacy `.pi`。

### 5.6 Runtime 对象和 API DTO 必须分离

不能把 `ToolDefinition`、`execute` 函数、明文 env token 返回给前端。

需要拆成：

```ts
LoadedExtensionsRuntime // 给 rpc-manager.ts
LoadedExtensionsView    // 给 /api/extensions
```

---

## 6. 当前项目状态

### 6.1 Skills

当前文件：

```txt
app/api/skills/route.ts
```

已经使用：

```ts
const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
await loader.reload();
const { skills, diagnostics } = loader.getSkills();
```

这意味着当前 UI 的 skills 来源已经接近 Pi Runtime 真实加载结果。

后续不应把它退回到简单目录扫描。

### 6.2 MCP

当前已有：

```txt
lib/mcp-config.ts
components/McpConfig.tsx
app/api/mcp-config/route.ts
```

但当前 MCP 主要是配置保存 / 编辑，尚未注入 Agent runtime。

当前格式：

```json
{
  "version": 1,
  "servers": []
}
```

### 6.3 ToolPanel

当前工具 preset：

```ts
none: []
default: ["read", "bash", "edit", "write"]
full: ["bash", "read", "edit", "write", "grep", "find", "ls", "code_search"]
```

当前没有 `custom` 状态。扩展工具加入后必须补充 `custom`，否则 UI 会误显示 default。

### 6.4 Legacy Migration

当前 `lib/legacy-migration.ts` 会自动同步：

```txt
~/.pi/agent/skills -> ~/.deerhux/agent/skills
<cwd>/.pi/skills -> <cwd>/.deerhux/skills
<cwd>/.agents/skills -> <cwd>/.deerhux/skills
```

并且 first-run 会复制 `~/.pi/agent/*.json` 到 `~/.deerhux/agent/`。

这和新方案的“不默认静默复制 `.pi`”冲突，必须在实施前调整。

---

## 7. 建议新增 Facade 结构

新增：

```txt
lib/extensions/
  index.ts
  types.ts
  view.ts
  runtime.ts
  skills-overlay.ts
  mcp.ts
  cache.ts
  config.ts
```

职责：

```txt
lib/extensions/index.ts         统一入口
lib/extensions/view.ts          给 API/UI 的 DTO，不含 execute/token
lib/extensions/runtime.ts       给 rpc-manager.ts 的 runtime objects
lib/extensions/skills-overlay.ts 叠加 DeerHux skills-state
lib/extensions/mcp.ts           MCP 配置多来源读取、格式归一、后续 runtime client
lib/extensions/cache.ts         短 TTL 缓存
lib/extensions/config.ts        路径和优先级定义
```

整体流程：

```txt
DefaultResourceLoader / Pi Extension Runtime / DeerHux MCP Config
        ↓
DeerHux Extension Facade
        ↓
View DTO for UI       Runtime objects for rpc-manager.ts
        ↓                       ↓
/api/extensions       createAgentSession({ resourceLoader, customTools })
```

---

## 8. 类型设计

### 8.1 通用 source

```ts
export type ExtensionSource =
  | "builtin-deerhux"
  | "builtin-pi"
  | "global-deerhux"
  | "global-pi"
  | "project-deerhux"
  | "project-pi"
  | "project-agents"
  | "package"
  | "pi-runtime"
  | "mcp";

export interface ExtensionDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  source?: ExtensionSource;
  filePath?: string;
  detail?: unknown;
}
```

### 8.2 UI DTO

```ts
export interface LoadedExtensionsView {
  skills: SkillView[];
  mcpServers: McpServerView[];
  tools: ToolView[];
  roles: RoleView[];
  diagnostics: ExtensionDiagnostic[];
}

export interface SkillView {
  id: string;
  name: string;
  description?: string;
  filePath: string;
  baseDir?: string;
  enabled: boolean;
  disableModelInvocation?: boolean;
  source: ExtensionSource;
  sourceLabel?: string;
  canDelete: boolean;
  canImportToDeerHux: boolean;
  frontmatter?: Record<string, unknown>;
}

export interface McpServerView {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];          // 只返回 key，不返回明文 env value
  description?: string;
  source: ExtensionSource;
  configPath?: string;
  canEdit: boolean;
  canDelete: boolean;
  canImportToDeerHux: boolean;
}

export interface ToolView {
  name: string;
  label?: string;
  description?: string;
  enabled: boolean;
  source: ExtensionSource;
  provider?: "builtin" | "code_search" | "mcp" | "pi-extension";
}

export interface RoleView {
  id: string;
  name: string;
  description?: string;
  source: ExtensionSource;
  canEdit: boolean;
  canDelete: boolean;
}
```

### 8.3 Runtime 结构

```ts
import type { ToolDefinition, ResourceLoader } from "@earendil-works/pi-coding-agent";

export interface LoadedExtensionsRuntime {
  resourceLoader?: ResourceLoader;
  customTools: ToolDefinition[];
  cleanupCallbacks: Array<() => void | Promise<void>>;
  diagnostics: ExtensionDiagnostic[];
}
```

注意：`LoadedExtensionsRuntime` 不进入 `/api/extensions` JSON 响应。

---

## 9. Skills 兼容方案

### 9.1 真源

Skills 初期真源必须是：

```ts
DefaultResourceLoader.getSkills()
```

即：

```ts
const loader = new DefaultResourceLoader({ cwd, agentDir });
await loader.reload();
const result = loader.getSkills();
```

这样 UI 展示和 Agent Runtime 看到的 skills 尽量一致。

### 9.2 不建议手写完整 scanner

不要用手写扫描替代 Pi ResourceLoader：

```txt
~/.deerhux/agent/skills
~/.pi/agent/skills
<cwd>/.deerhux/skills
<cwd>/.pi/skills
<cwd>/.agents/skills
```

这些路径可以作为 UI 兼容提示或 import 来源，但不应作为 skills 真源。

### 9.3 启用状态 overlay

当前 UI 通过修改 `SKILL.md` frontmatter 控制：

```yaml
disable-model-invocation: true
```

后续建议新增状态文件：

```txt
~/.deerhux/agent/skills-state.json
<cwd>/.deerhux/skills-state.json
```

格式：

```json
{
  "version": 1,
  "skills": {
    "github-search": {
      "enabled": true,
      "disableModelInvocation": false
    }
  }
}
```

但必须配套 Runtime 生效方式。

### 9.4 Runtime 生效方式

如果引入 `skills-state.json`，必须实现 ResourceLoader wrapper：

```ts
class DeerHuxResourceLoader implements ResourceLoader {
  constructor(private inner: DefaultResourceLoader, private state: SkillsState) {}

  getSkills() {
    const result = this.inner.getSkills();
    return applySkillsStateOverlay(result, this.state);
  }
}
```

然后在 `rpc-manager.ts`：

```ts
const resourceLoader = await createDeerHuxResourceLoader({ cwd, agentDir });

await createAgentSession({
  cwd,
  agentDir,
  sessionManager,
  resourceLoader,
});
```

否则 `skills-state.json` 只会影响 UI，不会影响 Agent。

### 9.5 `.pi` skills 策略

- `.pi` skills 可以只读展示。
- 用户点击“导入到 DeerHux”时复制到 `.deerhux`。
- 不默认静默复制。
- 删除 `.pi` 来源 skill 默认不允许，只允许禁用或导入后编辑。

---

## 10. MCP 兼容方案

### 10.1 当前状态

当前已有：

```txt
lib/mcp-config.ts
components/McpConfig.tsx
app/api/mcp-config/route.ts
```

但 MCP 尚未注入 Agent runtime。

### 10.2 MCP 配置读取路径

建议 facade 读取：

```txt
~/.deerhux/agent/mcp.json
~/.pi/agent/mcp.json
<cwd>/.deerhux/mcp.json
<cwd>/.pi/mcp.json
```

初期可以只读 `.pi`，写入仍只写 `.deerhux`。

### 10.3 支持两类格式

#### DeerHux 格式

```json
{
  "version": 1,
  "servers": [
    {
      "id": "github",
      "name": "GitHub",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "xxx"
      }
    }
  ]
}
```

#### 通用 MCP 格式

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "xxx"
      }
    }
  }
}
```

两者都归一化为 `McpServerView` / runtime server config。

### 10.4 优先级

建议：

```txt
project-deerhux
project-pi
global-deerhux
global-pi
```

同 id server 冲突时，保留优先级最高的。

### 10.5 API 脱敏

`/api/extensions` 不返回明文 env。

只返回：

```json
{
  "envKeys": ["GITHUB_PERSONAL_ACCESS_TOKEN"]
}
```

编辑具体 MCP 配置时，也应考虑 token masking / preserve old value。

---

## 11. MCP Runtime 接入方案

MCP runtime 不放在 MVP 第一阶段。

中期目标：把 MCP server 暴露的 tools 转换成 Pi `ToolDefinition`，注入 `createAgentSession({ customTools })`。

### 11.1 转换方向

```ts
const tool = defineTool({
  name: `mcp_${safeServerId}_${safeToolName}`,
  label: mcpTool.name,
  description: mcpTool.description,
  parameters: convertJsonSchemaToTypeBox(mcpTool.inputSchema),
  executionMode: "sequential",
  execute: async (_toolCallId, params, signal) => {
    const result = await mcpClient.callTool({
      serverId: server.id,
      name: mcpTool.name,
      arguments: params,
      signal,
    });

    return normalizeMcpToolResult(result);
  },
});
```

### 11.2 必须补充的实现细节

MCP runtime 接入时必须处理：

1. MCP SDK 依赖和 client 封装
2. stdio 子进程生命周期
3. session destroy 时 cleanup
4. tool call timeout
5. abort signal 透传
6. JSON Schema 到 TypeBox 的有限转换
7. 复杂 schema diagnostics
8. toolName sanitize
9. 内置工具名冲突
10. MCP text / image / resource / structured result 归一化
11. MCP error result 归一化
12. env token 脱敏和安全提示

### 11.3 生命周期

`AgentSessionWrapper` 建议新增：

```ts
private cleanupCallbacks: Array<() => void | Promise<void>> = [];

addCleanup(fn: () => void | Promise<void>) {
  this.cleanupCallbacks.push(fn);
}
```

`destroy()` 时：

```ts
for (const cleanup of this.cleanupCallbacks) {
  await cleanup();
}
```

当前 `destroy()` 是同步函数，实际改造时需要决定：

- 改成 async 并调整调用方；或
- 保持同步但 fire-and-forget cleanup。

---

## 12. Package / Pi Extension 方案

不建议初期自研 npm / local JS 插件协议。

长期方向：

- 优先复用 Pi 已有 Extension Runtime。
- DeerHux UI 展示 Pi extension 的来源、工具、命令、诊断。
- 如果 Pi Runtime 已经返回 `extensionsResult`，DeerHux 优先消费这个结果。
- 只有 Pi Runtime 无法满足 DeerHux 特定需求时，再考虑 DeerHux 自有补充协议。

如果未来支持 local JS / npm package，默认策略：

- 默认禁用
- 必须 UI 手动启用
- 展示 package / path / permissions
- 不返回 execute 到前端
- 不自动执行未知 package 的 activate
- local path 必须在项目目录或 allowlist 内

---

## 13. `rpc-manager.ts` 接入方案

当前 `lib/rpc-manager.ts` 已经有内置 `code_search` custom tool。

未来建议：

```ts
const extensionsRuntime = await loadExtensionsForRuntime({ cwd, agentDir });

const customTools = [
  ...(codeSearchTool ? [codeSearchTool] : []),
  ...extensionsRuntime.customTools,
];

const { session: inner, extensionsResult } = await createAgentSession({
  cwd,
  agentDir,
  sessionManager,
  ...(extensionsRuntime.resourceLoader ? { resourceLoader: extensionsRuntime.resourceLoader } : {}),
  ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
  ...(customTools.length > 0 ? { customTools } : {}),
});
```

### 13.1 工具 allowlist 规则

当前 SDK 语义：

```ts
tools?: string[];
noTools?: "all" | "builtin";
customTools?: ToolDefinition[];
```

需要明确：

```txt
toolNames === undefined:
  使用 Pi 默认行为。

toolNames === []:
  关闭所有工具。

toolNames 非空:
  只启用 toolNames allowlist 中的工具。
```

扩展工具加入后，`availableToolNames` 应包含：

```txt
builtin tools
code_search
enabled MCP tools
enabled Pi extension tools
```

但最终仍应以 `inner.getAllTools()` 过滤，避免传入未知工具名。

### 13.2 活跃 session 生效规则

扩展配置变更后，已经创建的 `AgentSession` 不会自动注册新工具。

UI 需要提示：

```txt
扩展变更将在新会话或重启当前 Agent 后生效。
```

后续可提供“重启当前 Agent runtime”按钮，但不能影响正在 streaming 的 session。

---

## 14. ToolPanel 兼容

当前 `ToolPanel` 只有：

```ts
"none" | "default" | "full"
```

扩展工具加入后必须新增：

```ts
export type ToolPreset = "none" | "default" | "full" | "custom";
```

规则：

```txt
none:
  无 active tools

default:
  精确匹配 DeerHux 默认工具集合

full:
  精确匹配 DeerHux full 工具集合 + 当前已启用扩展工具

custom:
  任意非 preset 组合
```

注意：当前项目 default 是：

```txt
read, bash, edit, write
```

文档和 UI 必须保持一致。不要在文档中写成 `read, grep, find, ls`，除非同步修改 UI 和产品定义。

---

## 15. UI 方案

### 15.1 新增统一入口

设置菜单中新增：

```txt
扩展
```

或者整合现有：

```txt
设置
  模型
  MCP
  Skills
  角色
  扩展
```

### 15.2 新增组件

```txt
components/ExtensionsConfig.tsx
```

### 15.3 扩展总览

展示：

```txt
扩展总览

Skills       12 个，启用 8 个
MCP 服务      3 个，启用 1 个
MCP Tools    15 个，启用 6 个
Pi Extensions 2 个
角色          5 个
Diagnostics  1 个 warning
```

### 15.4 Skills Tab

字段：

- 名称
- 描述
- 来源
- 路径
- 启用状态
- disableModelInvocation
- 删除
- 打开文件
- 导入到 DeerHux
- diagnostics

### 15.5 MCP Tab

字段：

- server 名称
- transport
- 来源
- 启用状态
- 连接状态
- tools 数量
- env keys 脱敏展示
- 测试连接
- 编辑
- 删除
- 导入到 DeerHux

### 15.6 Pi Extensions Tab

初期只读展示：

- extension ID
- 来源
- 导出的 tools
- 导出的 slash commands
- diagnostics
- 启用状态，后续再做

---

## 16. API 方案

### 16.1 查询扩展

```txt
GET /api/extensions?cwd=<path>
```

返回 `LoadedExtensionsView`：

```json
{
  "skills": [],
  "mcpServers": [],
  "tools": [],
  "roles": [],
  "diagnostics": []
}
```

要求：

- 不返回 `execute` 函数
- 不返回明文 env value
- 不返回 package 内部 runtime object

### 16.2 修改扩展状态

```txt
PATCH /api/extensions
```

请求：

```json
{
  "cwd": "/path/to/project",
  "type": "skill",
  "id": "github-search",
  "enabled": false
}
```

注意：如果启用 `skills-state.json`，必须保证 runtime 也使用 DeerHux ResourceLoader overlay。

### 16.3 刷新扩展缓存

```txt
POST /api/extensions/reload
```

请求：

```json
{
  "cwd": "/path/to/project"
}
```

### 16.4 测试 MCP 连接

```txt
POST /api/extensions/mcp/test
```

请求：

```json
{
  "cwd": "/path/to/project",
  "serverId": "github"
}
```

---

## 17. 缓存方案

新增：

```txt
lib/extensions/cache.ts
```

缓存 key：

```txt
cwd + agentDir
```

缓存内容：

```ts
LoadedExtensionsView
```

建议 TTL：

```txt
30s - 60s
```

清缓存时机：

- 用户点击刷新扩展
- 修改扩展状态
- 修改 MCP 配置
- 安装 / 删除 skill
- 导入 `.pi` skill / MCP 到 `.deerhux`
- 新建 session 前可短 TTL 自动刷新

注意：清缓存不等于已运行 AgentSession 重新注册工具。

---

## 18. 安全方案

### 18.1 风险来源

扩展可能：

- 执行 shell
- 读取文件
- 写入文件
- 访问网络
- 读取环境变量
- 调用第三方服务
- 启动 MCP 子进程

### 18.2 基础策略

初期建议：

1. package / Pi extension 默认只读展示，不主动启用新执行能力
2. MCP server 默认需要显式启用
3. UI 显示来源路径
4. UI 显示 env keys，但不显示 token value
5. UI 显示风险提示
6. 不自动执行未知 package 的 activate
7. `.pi` 来源默认只读，不直接删除

### 18.3 路径安全

扩展 API 必须校验：

- filePath 必须落在允许目录内
- cwd 必须是有效路径
- 不允许任意绝对路径写入
- 删除操作只允许 DeerHux 可管理目录
- `.pi` 来源默认不可删除，只能导入 / 禁用

当前 `app/api/skills/route.ts` 的 DELETE 只判断 `filePath.endsWith("SKILL.md")`，后续应加强。

### 18.4 env 脱敏

API 默认只返回：

```json
{
  "envKeys": ["TOKEN_NAME"]
}
```

编辑界面可以显示 masked value：

```txt
GITHUB_TOKEN=********
```

保存时支持 preserve old value。

---

## 19. Legacy Migration 调整策略

当前 `lib/legacy-migration.ts` 和新方案存在冲突。

建议调整：

### 19.1 Sessions

继续迁移：

```txt
~/.pi/agent/sessions -> ~/.deerhux/agent/sessions
```

因为 DeerHux 已经使用自己的 session 浏览和管理。

### 19.2 Skills

不再默认持续同步：

```txt
~/.pi/agent/skills -> ~/.deerhux/agent/skills
<cwd>/.pi/skills -> <cwd>/.deerhux/skills
```

改为：

- 直接通过 facade / Pi ResourceLoader 展示 `.pi` 来源
- UI 标记 `global-pi` 或 `project-pi`
- 用户点击“导入到 DeerHux”时再复制

如果出于兼容必须保留 first-run copy，需要在 UI 和 docs 中明确，避免重复来源困惑。

### 19.3 MCP

不默认复制，改为：

- 合并读取 `.pi` 和 `.deerhux`
- `.deerhux` 优先
- 用户可手动导入

### 19.4 Models / Settings

现有逻辑可保持，但需要明确优先级。

### 19.5 `.agents`

当前 `.agents` roles / skills 会迁移到 `.deerhux`。

后续要决定：

- 继续作为 legacy migration；或
- 改为只读来源 + 手动导入。

如果保留迁移，应在扩展来源优先级中明确 `.agents` 是 legacy source。

---

## 20. Roles 兼容策略

当前 `lib/roles.ts` 行为：

- built-in roles
- global `.deerhux/agent/roles.json`
- project `<cwd>/.deerhux/roles.json`
- project `.agents/roles.json` 会迁移
- project role 当前不会覆盖 global / builtin 同 id role

因此不能简单套用：

```txt
project > global > builtin
```

需要单独定义 role 规则：

```txt
built-in role 可被 global custom 同 id增强 / 覆盖部分字段；
project role 默认作为项目级新增；
project role 不覆盖 global / builtin 同 id，除非后续明确支持 override。
```

如果要兼容 `.pi/agent/roles.json`，需要先确认 Pi role 格式是否与 DeerHux `roles.json` 一致。

MVP 阶段建议：

- roles 只在扩展总览中展示现有 `readRoles(cwd)` 结果；
- 暂不引入 `.pi` roles 覆盖；
- 暂不改变当前 role merge 规则。

---

## 21. 分阶段实现计划

### Phase 1：Facade View 层 MVP

目标：先不改 runtime，只实现统一展示。

新增：

```txt
lib/extensions/types.ts
lib/extensions/view.ts
lib/extensions/mcp.ts
lib/extensions/cache.ts
lib/extensions/index.ts
app/api/extensions/route.ts
```

实现：

- skills 使用 `DefaultResourceLoader.getSkills()`
- MCP 读取当前 DeerHux global mcp config
- roles 使用 `readRoles(cwd)`
- tools 展示当前内置工具 / code_search 状态可选
- `/api/extensions` 返回 `LoadedExtensionsView`
- 不返回明文 env
- 不接 MCP runtime
- 不支持 package tools

风险：低。

### Phase 2：UI 扩展总览

新增：

```txt
components/ExtensionsConfig.tsx
```

集成现有：

```txt
SkillsConfig
McpConfig
RoleConfig
```

产出：

- 设置中有“扩展”入口
- 可查看来源、启用状态、诊断信息
- 可看到 Pi ResourceLoader 返回的 skills
- MCP env 脱敏展示

风险：低到中。

### Phase 3：迁移策略调整 + MCP 多来源合并

修改：

```txt
lib/legacy-migration.ts
lib/mcp-config.ts
lib/extensions/mcp.ts
```

产出：

- 停止或弱化 `.pi` skills 自动复制
- 支持 `.pi` MCP 只读来源
- 支持 `servers[]` 和 `mcpServers` 两种 MCP 格式
- 支持导入到 DeerHux

风险：中。

### Phase 4：Skills State Overlay Runtime 生效

新增 / 修改：

```txt
lib/extensions/skills-overlay.ts
lib/extensions/runtime.ts
lib/rpc-manager.ts
app/api/extensions/route.ts
```

产出：

- `skills-state.json`
- DeerHux ResourceLoader wrapper
- UI toggle 不再直接改第三方 `SKILL.md`
- Agent Runtime 真正受 overlay 影响

风险：中。

### Phase 5：MCP Runtime 接入

新增 / 修改：

```txt
lib/extensions/mcp.ts
lib/extensions/runtime.ts
lib/rpc-manager.ts
components/ToolPanel.tsx
```

产出：

- MCP tools 转换为 Pi `ToolDefinition`
- Agent 可以调用 MCP tools
- session destroy 时关闭 MCP client
- ToolPanel 支持 custom preset

风险：中到高。

### Phase 6：Pi Extension Runtime 可视化

目标：消费 Pi `extensionsResult` / `discoverAndLoadExtensions` 结果，展示 package / extension 的 tools、commands、diagnostics。

风险：中。

### Phase 7：权限与安全增强

产出：

- 权限声明
- 风险提示
- 执行前确认
- 可选 allowlist
- local path 限制
- API 写操作路径校验

风险：中。

---

## 22. MVP 建议

最小可行版本建议只做：

1. 新增 `lib/extensions` facade view 层
2. 新增 `/api/extensions?cwd=`
3. skills 直接复用 `DefaultResourceLoader.getSkills()`
4. MCP 先读取当前 `~/.deerhux/agent/mcp.json`
5. roles 复用 `readRoles(cwd)`
6. UI 显示扩展总览
7. 不接 MCP runtime
8. 不实现 package tools
9. 不引入 `skills-state.json`
10. 不改变当前 Agent runtime 行为

这个版本风险最低，并能立刻给 DeerHux 一个统一扩展入口。

---

## 23. 推荐落地顺序

建议顺序：

```txt
1. Extension Facade View 层
2. /api/extensions
3. UI 扩展总览
4. MCP env 脱敏 + 多格式读取
5. legacy migration 策略调整
6. skills-state overlay + DeerHuxResourceLoader
7. ToolPanel custom preset
8. MCP runtime 注入
9. Pi Extension Runtime 可视化
10. 权限增强
```

---

## 24. 关键文件改造清单

### 新增

```txt
lib/extensions/types.ts
lib/extensions/view.ts
lib/extensions/runtime.ts
lib/extensions/skills-overlay.ts
lib/extensions/mcp.ts
lib/extensions/cache.ts
lib/extensions/config.ts
lib/extensions/index.ts
app/api/extensions/route.ts
app/api/extensions/reload/route.ts
components/ExtensionsConfig.tsx
```

### 修改

```txt
lib/rpc-manager.ts
lib/legacy-migration.ts
lib/mcp-config.ts
lib/roles.ts 可选
components/AppShell.tsx
components/SkillsConfig.tsx
components/McpConfig.tsx
components/ToolPanel.tsx
app/api/skills/route.ts
app/api/skills/install/route.ts
```

---

## 25. 风险评估

| 风险 | 等级 | 说明 | 应对 |
|---|---:|---|---|
| Pi 内部 API 变化 | 中 | `pi-coding-agent` 可能改 ResourceLoader / Extension Runtime API | Facade 隔离，集中适配 |
| UI 展示和 Runtime 不一致 | 中 | 如果手写 scanner，可能和 Pi Runtime 不一致 | skills 以 `DefaultResourceLoader` 为真源 |
| legacy migration 造成重复来源 | 中 | `.pi` 被复制到 `.deerhux` 后 UI 出现重复 | 调整 migration，UI 明确 source |
| MCP schema 转换复杂 | 中 | JSON Schema 到 TypeBox 不完整 | MVP 只支持常用 schema，复杂 schema diagnostics |
| 动态 import 安全风险 | 高 | package tools 可执行任意代码 | 优先复用 Pi Runtime，默认禁用 + 权限提示 |
| env token 泄露 | 高 | `/api/extensions` 可能返回 env | API DTO 只返回 envKeys / masked value |
| Runtime 生命周期泄漏 | 中 | MCP 子进程未关闭 | session cleanup callbacks |
| 工具名冲突 | 中 | 内置工具和扩展工具同名 | 强制 namespace + sanitize |
| 活跃 session 不生效 | 中 | 修改扩展后当前 Agent 不会注册新工具 | UI 提示新会话 / 重启 runtime 后生效 |

---

## 26. 最终结论

DeerHux 支持 Pi 扩展是现实且合理的，但不应自研一套完整扩展系统来替代 Pi。

推荐方案是：

```txt
DeerHux Extension Facade over Pi ResourceLoader / Extension Runtime
```

也就是：

```txt
Pi 负责真实加载和执行协议
DeerHux 负责 UI、状态、安全、来源、合并、导入、Runtime 编排
```

短期建议：

```txt
Extension Facade View + /api/extensions + UI 总览
```

中期建议：

```txt
skills-state overlay + DeerHuxResourceLoader + MCP 多来源合并
```

长期建议：

```txt
MCP runtime 注入 + Pi Extension Runtime 可视化 + 权限体系
```

这样 DeerHux 可以同时做到：

- 兼容 Pi
- 复用 Pi Runtime
- 避免重复插件系统
- 保持 DeerHux 自己的配置体系
- 支持 MCP
- 支持 Skills
- 支持未来 Pi extensions
- 降低后续维护成本
