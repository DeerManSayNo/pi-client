# DeerHux 自研 Agent Loop 引擎设计文档

> 版本：v1.0 · 调研日期：2026-06-21
> 调研对象：DeerHux 主仓库（Next.js 16 + Tauri 桌面 coding agent，基于 `@earendil-works/pi-coding-agent@0.75.5`）
> 本文所有结论均带 **文件路径 + 行号 + 代码片段** 证据，pi-agent-core 部分从 bun cache（`0.75.5@@@1`）的 `.d.ts` 实读，非反推。

---

## 〇、调研边界与可信度声明

| 调研项 | 来源 | 可信度 |
| --- | --- | --- |
| DeerHux 业务代码 | 本仓库 `lib/`、`app/`、`hooks/`（git worktree，只读） | ✅ 实读 |
| `pi-coding-agent@0.75.5` 的 `.d.ts` | `~/Documents/.../DeerHux/node_modules/@earendil-works/pi-coding-agent/dist/core/*.d.ts`（主仓库已装依赖） | ✅ 实读 |
| `pi-agent-core@0.75.5` 的 `.d.ts`（传递依赖） | `~/.bun/install/cache/@earendil-works/pi-agent-core/0.75.5@@@1/dist/*.d.ts` | ✅ 实读（非反推） |
| `pi-ai` 的 `.d.ts` | 主仓库 `node_modules/@earendil-works/pi-ai/dist/*.d.ts` | ✅ 实读 |
| pi 内部私有字段的**运行时行为** | 仅能从 `.d.ts`（无下划线即公开、有下划线即私有）+ DeerHux 的 hack 注释反推 | ⚠️ 行为级需运行时验证 |

> 注意：本 worktree 的 `node_modules` 为空（隔离环境），pi 类型定义均从主仓库与 bun cache 读取，行号引用以**本仓库业务文件**为准。

---

## 一、现状与耦合面

### 1.1 pi 三层架构（文字 + ASCII）

```
┌─────────────────────────────────────────────────────────────────────────┐
│ DeerHux（本仓库）= Adapter + Enhancer 层                                │
│  Next.js UI / 子 agent 协作(worktree) / codegraph / 调度器 / 角色 / 微信bot│
│  lib/rpc-manager.ts: AgentSessionWrapper（1625 行，封装 pi 的 AgentSession）│
└───────────────▲─────────────────────────────────────────▲──────────────┘
                │ 公开 API（createAgentSession / defineTool）│ 私有属性 hack（_baseSystemPrompt 等）
┌───────────────┴─────────────────────────────────────────┴──────────────┐
│ 第 3 层：pi-coding-agent（@earendil-works/pi-coding-agent@0.75.5）       │
│   AgentSession（60+ 公开方法，封装 loop）                                 │
│   SessionManager（jsonl 持久化 + 树形分支 + fork）                        │
│   内置工具（read/bash/edit/write/grep/find/ls）                          │
│   extensions 框架（ToolDefinition / ExtensionRunner）                    │
│   compaction（自动压缩）/ settings-manager / auth-storage / model-registry│
└───────────────▲──────────────────────────────────────────────────────────┘
                │ 依赖（package.json 未直接列出，传递依赖）
┌───────────────┴──────────────────────────────────────────────────────────┐
│ 第 2 层：pi-agent-core（@earendil-works/pi-agent-core@0.75.5）           │
│   ★ Agent 类 = 真正的 Agent Loop 引擎（tool-calling 循环）                │
│   agent-loop.ts: agentLoop()/runAgentLoop()（低层流式 loop）             │
│   types.ts: AgentEvent / AgentTool / AgentLoopConfig / ToolExecutionMode │
│   harness/: session(jsonl-repo) / compaction / skills / system-prompt   │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ 依赖
┌───────────────┴──────────────────────────────────────────────────────────┐
│ 第 1 层：pi-ai（@earendil-works/pi-ai@0.75.5）= 统一 LLM 传输层【不碰】   │
│   streamSimple / complete（流式调用）                                    │
│   14+ provider（Anthropic/OpenAI/Google/Mistral/Bedrock/Vertex/...）     │
│   Model / Context / Transport / ThinkingLevel / 成本计算 / OAuth device  │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键事实**：DeerHux 在 `package.json`（本仓库根 `package.json` 第 6-7 行）只直接声明依赖 `pi-ai` 与 `pi-coding-agent`，**没有直接声明 `pi-agent-core`**——它是 `pi-coding-agent` 的传递依赖。这导致：

- `import ... from "@earendil-works/pi-agent-core"` 在 DeerHux 代码里**没有出现**（见 §1.3 统计，只有 `pi-coding-agent` 与 `pi-ai` 两种 import）；
- DeerHux 想动 loop 内部行为时，只能从 `pi-coding-agent` 的 `AgentSession`（它持有 `agent: Agent` 公开字段）**往下钻一层**去 monkey-patch `Agent` 的公开/私有字段，这正是 §二 全部 hack 的来源。

### 1.2 DeerHux 对 pi 的依赖统计

**import 分布**（`grep -rln "from \"@earendil-works/pi" lib app`）：

| 目录 | 文件数 |
| --- | --- |
| `lib/` | 19 |
| `app/api/` | 12 |
| **合计** | **31** |

**按符号清单（去重）**，分职责归组：

#### A. 会话/Loop 创建（耦合最深，自研 loop 的主替换目标）
| 符号 | 来源 | 用法位置 | 职责 |
| --- | --- | --- | --- |
| `createAgentSession` | `pi-coding-agent` | `lib/rpc-manager.ts:3,1501`；`app/api/models-config/test/route.ts:6` | 创建 `AgentSession` 实例（= loop + session + 工具全家桶） |

#### B. 会话持久化/分支（session 层，M6 解耦目标）
| 符号 | 用法位置 | 职责 |
| --- | --- | --- |
| `SessionManager` | `lib/rpc-manager.ts:3,1492,1538,1560`；`lib/session-reader.ts:1`；`lib/parallel-agent/collaboration-orchestrator.ts:3`；`app/api/sessions/[id]/context/route.ts:2`；`app/api/sessions/[id]/route.ts:4` | open/create/fork/getBranch/appendCustomEntry |
| `buildSessionContext`（`as piBuildSessionContext`） | `lib/session-reader.ts:1,344` | 把 jsonl entries 还原成 `SessionContext`（messages+entryIds+model） |
| `SessionEntry`/`SessionInfo`（`as Pi*`） | `lib/session-reader.ts:4` | 类型镜像（DeerHux 在 `lib/types.ts` 自己又复制了一份） |

#### C. 工具契约（ToolDefinition，M2 替换目标）
| 符号 | 用法位置 | 职责 |
| --- | --- | --- |
| `defineTool` | `lib/rpc-manager.ts:3`（code_search）、`lib/codegraph/tools.ts:1`、`lib/mcp-runtime.ts:5,468`、`lib/parallel-agent/subagent-tool.ts:1` | 工厂：生成 pi 的 `ToolDefinition`（name/parameters/execute/executionMode） |
| `type ToolDefinition` | `lib/rpc-manager.ts:3`；`lib/codegraph/tools.ts:1`；`lib/mcp-runtime.ts:5` | 工具类型契约（数组元素类型） |

#### D. 配置/资源/认证（大部分属 pi-ai 与配置层，不在 loop 自研范围）
| 符号 | 用法位置 | 职责 |
| --- | --- | --- |
| `getAgentDir` | `lib/*` 共 12 处（roles/memory/scheduler/extensions/...） | 返回 `~/.pi/agent`（DeerHux 复用为 `~/.deerhux/agent`） |
| `DefaultResourceLoader` | `lib/rpc-manager.ts:1513`；`lib/extensions/view.ts:2`；`app/api/system-prompt/route.ts:10`；`app/api/skills/route.ts:3` | 加载 skills/AGENTS.md/frontmatter/system prompt |
| `SettingsManager` | `lib/rpc-manager.ts:1507` | 读 retry/compaction/thinking 设置 |
| `AuthStorage` / `ModelRegistry` | `app/api/auth/*`、`app/api/models/*`、`lib/rpc-manager.ts:1141,1526` | OAuth/API key 存储 + 模型发现 |
| `parseFrontmatter` | `lib/extensions/view.ts:2`；`app/api/skills/route.ts:3` | 解析 skill frontmatter |
| `getSupportedThinkingLevels`（pi-ai） | `app/api/models/route.ts:2` | 模型支持的思考级别 |
| `AssistantMessage`/`ImageContent`（pi-ai） | `app/api/models-config/test/route.ts:5` | 类型 |

> **结论**：`getAgentDir` / `AuthStorage` / `ModelRegistry` / `DefaultResourceLoader` / `SettingsManager` 属**配置与认证层**，与 loop 无关，本文档**不在替换范围**（见 §三边界）。真正与 loop 强耦合、需要自研的是 **A（createAgentSession→AgentSession→Agent）** 和 **C（defineTool/ToolDefinition）**。

### 1.3 一句话定性

> **DeerHux 是 pi 的 Adapter + Enhancer：loop 的真实控制权在 pi-agent-core 的 `Agent` 类手里，DeerHux 只能通过 `AgentSession` 的公开方法「请求」loop 做事，遇到 pi 没开放的细粒度控制（system prompt 持久化、工具执行模式、重试策略、运行时工具热替换）就退回到 monkey-patch 私有字段。**

证据：`lib/rpc-manager.ts` 全文 1625 行里，对 `AgentSession`（`this.inner`）的**公开**方法调用集中在 `send()`（第 1077-1390 行）一个巨型 switch；而所有**私有字段写入**（`as unknown as {...}`）都散落在 `setEffectiveSystemPrompt` / `hardenAutoRetry` / `configureToolExecutionModes` / `installMcpRuntime` 四个函数里——这四个函数就是 DeerHux 与 pi 的「裂缝」。

---

## 二、痛点根因清单（私有属性 hack 穷举）

> 检索方法：`grep -rn "as unknown as" lib/` + 人工核对每个命中点。命中 9 处（`lib/rpc-manager.ts` 7 处 + `lib/session-reader.ts` 2 处 + `lib/agent-event-bus.ts` 1 处）。其中 `session-reader.ts` 与 `agent-event-bus.ts` 的 `as unknown as` 是**类型镜像**（DeerHux 的 `SessionEntry` 与 pi 的 `PiSessionEntry` 结构同构，做类型转换），**不是私有 hack**，不计入。真正的私有 hack 全部在 `rpc-manager.ts`，共 **9 个 hack 点**。

| # | hack 代码位置（文件:行） | 代码片段 | 用途 | pi 缺的公开 API | 根因 | 替换难度 |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | `lib/rpc-manager.ts:181-187` | `(session as unknown as { _baseSystemPrompt?: string })._baseSystemPrompt = prompt;` + `session.agent.state.systemPrompt = prompt;` | 设置**持久** system prompt（DeerHux 的角色/模式/turn_context 注入） | `AgentSession.setSystemPrompt(prompt: string)` 公开方法；或 `Agent.setBaseSystemPrompt()` | pi 每次 turn 在 `_rebuildSystemPrompt()` 里把 `agent.state.systemPrompt` 重置回私有 `_baseSystemPrompt`（`agent-session.d.ts` 注释 `_baseSystemPrompt` 私有）。DeerHux 改 `state.systemPrompt` 只是改了「当前一帧」，下一帧被覆盖 → 必须连私有字段一起改 | **低**（loop 自研后，systemPrompt 就是 loop 的一个可写状态字段） |
| H2 | `lib/rpc-manager.ts:302-310` | `settingsManager.getRetrySettings = () => ({ ...settings, baseDelayMs: Math.max(..., MIN_AUTO_RETRY_DELAY_MS) })` | 强制重试退避至少 5s（避免 provider 抖动时 0 退避连环重试） | `SettingsManager.setRetryOverride(fn)` 或构造期注入 `RetryPolicy` | pi 的 `getRetrySettings` 从磁盘 settings.json 读，DeerHux 想做运行时覆盖但没注入点 → 覆盖原型方法 | **中**（需把 RetryPolicy 提到 loop 构造期，见 §四） |
| H3 | `lib/rpc-manager.ts:313-336` | `rawSession._isRetryableError = (message) => { ... 原判断 && !(PREMATURE_STREAM_ERROR_RE.test(err) && contentLength>=20) }` | 抑制「假性流错误」重试（provider 在完整 assistant 消息后仍发 `connection lost`，重试会多发一次无意义 continue） | `AgentSession.setRetryPolicy({ isRetryable: (err, ctx) => boolean })` | pi 把「是否可重试」硬编码在 `_isRetryableError`（私有，`agent-session.d.ts` 第 `_isRetryableError` 行），DeerHux 的 premature-stream 启发式无法注入 | **中** |
| H4 | `lib/rpc-manager.ts:337-345` | `rawSession._prepareRetry = async (message) => { await sleepMs(1000); return originalPrepareRetry(message); }` | 给 retry 前加 1s quiet window，避免与 SSE/tool/agent-end 的异步清理竞争 | 同 H2/H3：`RetryPolicy` 里暴露 `beforeRetry` 钩子 | `_prepareRetry` 是 pi 决定「发 continue 还是放弃」的私有入口，DeerHux 想插一个 settle 延迟 | **中** |
| H5 | `lib/rpc-manager.ts:373` | `(session.agent as unknown as { toolExecution?: ... }).toolExecution = "sequential"` | `PI_DISABLE_PARALLEL_TOOLS=1` 时全局强制串行 | `Agent.setToolExecutionMode(mode)`（Agent 类已有 `toolExecution` 字段但只在构造期读，`Agent` 的 `set` 没暴露——见 `agent.d.ts` 第 `toolExecution: ToolExecutionMode` 行是**公开只读字段**，无 setter） | `Agent.toolExecution` 是 public field 但无 setter，`AgentSession` 也没转发 setter | **低**（loop 自研后直接 `loop.setToolExecutionMode()`） |
| H6 | `lib/rpc-manager.ts:377-381` | `registry = (session as unknown as { _toolRegistry?: Map<...> })._toolRegistry; for(...) tool.executionMode = mode;` | 按工具名设置**单工具**执行模式（read/grep/find/ls 并行，bash/edit/write 串行） | `AgentSession.setToolExecutionMode(name, mode)` 或 `ToolDefinition.executionMode` 在 register 时生效 | pi 的 `_toolRegistry`（私有 Map）+ `_toolDefinitions`（私有 Map）双写：runtime 把 `defineTool({executionMode})` 的值**没有透传**到注册后的 `AgentTool.executionMode`，DeerHux 定义时写了 executionMode 但运行时被忽略 → 必须三个地方都改 | **中**（要查清 pi 为何丢 executionMode） |
| H7 | `lib/rpc-manager.ts:383-386` | `definitions = (session as unknown as { _toolDefinitions?: Map<...> })._toolDefinitions; for(...) entry.definition.executionMode = mode;` | 同 H6，改 definition 层（与 registry 双写） | 同 H6 | 同 H6（pi 内部 registry/definitions 两份副本） | **中** |
| H8 | `lib/rpc-manager.ts:389-392` | `activeTools = session.agent.state.tools; for(...) tool.executionMode = mode;` | 同 H6，改已激活到 agent.state.tools 的第三份副本 | 同 H6 | pi 有 **三份**工具副本（`_toolRegistry` / `_toolDefinitions` / `agent.state.tools`），全要同步 | **中** |
| H9 | `lib/rpc-manager.ts:894-916` | `rawSession._customTools = [...]; rawSession._allowedToolNames.add(...); rawSession._refreshToolRegistry({...})` | **运行时热替换 MCP 工具**（用户改 mcp 配置后不重启 session 即生效） | `AgentSession.registerTools(defs)` / `unregisterTools(names)` / `reloadTools()` 公开方法 | pi 的工具集只在 `createAgentSession` / `reload()` 时固定，运行时增删 MCP server 必须直接改私有 `_customTools` 数组 + `_allowedToolNames` Set + 调私有 `_refreshToolRegistry()` | **高**（涉及工具注册表全生命周期，是 M2 最硬的骨头） |

**另有 1 处「半 hack」**（改公开字段但绕过 setter 语义）：

| # | 位置 | 代码 | 说明 |
| --- | --- | --- | --- |
| H10 | `lib/rpc-manager.ts:1252-1254` | `if (level === "xhigh" && model.compat.thinkingFormat === "deepseek") this.inner.agent.state.thinkingLevel = "xhigh";` | DeepSeek 模型的 xhigh 兼容：`setThinkingLevel` 会把 xhigh clamp 到 high，DeerHux 在 clamp 后手动改回。这是 pi 的 clamp 逻辑过严，**改的是公开 `agent.state`**（`AgentState.thinkingLevel` 在 `types.d.ts` 是 public 可写），但属于「绕过 SDK 的 clamp 保护」，风险中等。 |

**还有 `extractChangedFilePath` 的 schema 契约缺失**（`lib/rpc-manager.ts:158-172`）：

```ts
function extractChangedFilePath(event: AgentEvent): string | null {
  const toolName = extractToolName(event);
  if (toolName !== "write" && toolName !== "edit") return null;
  return getNestedString(event, ["filePath"])
    ?? getNestedString(event, ["path"])
    ?? getNestedString(event, ["file_path"])
    ?? getNestedString(event, ["args", "file_path"])
    ?? getNestedString(event, ["args", "path"])
    ?? getNestedString(event, ["input", "file_path"])
    ?? getNestedString(event, ["input", "path"])
    ?? getNestedString(event, ["result", "filePath"])
    ?? getNestedString(event, ["result", "path"])
    ?? getNestedString(event, ["result", "file_path"]);
}
```

10+ 种字段路径回退，根因是 `tool_execution_end` 事件的 `args`/`result` schema **没有契约**：pi 的 `tool_execution_end`（见 `pi-agent-core/dist/types.d.ts` 第 `tool_execution_end` 行）只承诺 `toolCallId/toolName/result/isError`，不承诺 `result.details` 的形状。DeerHux 想知道「这次 edit 改了哪个文件」只能猜字段。这是 loop 自研后必须用 `ToolExecutionEndEvent.changedFiles?: string[]` 显式契约解决的（见 §四 LoopEvent）。

### 2.1 hack 总数与分布

- **私有字段写入**（`as unknown as { _xxx }` 后赋值）：**9 处**（H1-H9），全部在 `lib/rpc-manager.ts`。
- **公开字段绕过 setter**：1 处（H10，thinkingLevel clamp 绕过）。
- **schema 猜测**：1 处（extractChangedFilePath，10+ 字段回退）。

> 这 11 个点就是「自研 loop 引擎」要一次性消灭的全部裂缝。消灭后 `lib/rpc-manager.ts` 的 `as unknown as` 将归零，SDK 升级告警也不再需要。

---

## 三、目标架构

### 3.1 定位（一句话）

> **保留 pi-ai（LLM 传输层，14+ provider 不动）；替换 pi-agent-core（loop 自研，成为 DeerHux 的 `@deerhux/agent-loop`）；渐进适配 session 层（pi-coding-agent 的 AgentSession/SessionManager 先包一层 Port，后续按里程碑逐步替换）。**

### 3.2 三层边界图

```
┌──────────────────────────────────────────────────────────────────────────┐
│ DeerHux 业务层（不动）：UI / 角色 / 调度器 / codegraph / 子agent / 微信bot  │
└───────────────▲────────────────────────────────────────────▲─────────────┘
                │ AgentSessionWrapper.send()（保留，改成调 Port）  │
┌───────────────┴────────────────────────────────────────────┴─────────────┐
│ ★ 新增：lib/engine/port.ts = AgentEnginePort 接口（M0 抽象层）            │
│   - 运行时探测：pi 实现存在性校验 → SDK 升级告警                          │
│   - 双实现并存：PiEngineAdapter（旧）↔ DeerLoopEngine（新，feature flag） │
└───────▲──────────────────────────────────────────▲───────────────────────┘
        │ M1-M5 逐步替换                            │ M6 适配
┌───────┴──────────────────────────┐  ┌────────────┴───────────────────────┐
│ 自研 @deerhux/agent-loop（新）   │  │ session 适配层（新 lib/session/）   │
│  AgentLoop / LoopEvent /         │  │  SessionStore 接口（jsonl/in-mem）  │
│  ToolDefinition / RetryPolicy    │  │  先复用 pi SessionManager，后替换   │
│  AgentLoopFactory                │  │                                     │
└───────▲──────────────────────────┘  └─────────────────────────────────────┘
        │ 复用
┌───────┴──────────────────────────────────────────────────────────────────┐
│ ✅ 保留：pi-ai（传输层，绝不碰）                                          │
│   streamSimple / Model / Context / Transport / 14+ provider / OAuth       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.3 明确「不碰」清单

| 不碰的 pi 能力 | 理由 | 证据 |
| --- | --- | --- |
| **pi-ai 全部**（streamSimple/provider/OAuth/Model） | 14+ provider 适配 + OAuth device flow + 成本计算是巨大工程，无收益 | `pi-ai/dist/stream.d.ts` `streamSimple` + `types.d.ts` `Model` |
| **AuthStorage / ModelRegistry** | 认证与模型发现，与 loop 无关 | `app/api/auth/*`、`app/api/models/*` 全量复用 |
| **SettingsManager 磁盘读写** | 只读它的 retry/compaction 配置，写入逻辑 pi 已完备 | `lib/rpc-manager.ts:1507` |
| **DefaultResourceLoader** | skills/AGENTS.md/frontmatter 加载，与 loop 无关 | `lib/rpc-manager.ts:1513` |
| **pi 内置工具的执行体**（read/bash/edit/write/grep/find/ls 的 `execute`） | 7 个工具的执行逻辑成熟稳定，自研 loop 直接**复用**它们的 execute，只换注册契约 | `pi-coding-agent/dist/core/tools/index.d.ts` `createReadTool` 等 |

> **关键决策**：自研 loop **不重写工具执行体**，只重写「工具注册 + 调度 + 事件契约」。read/bash/edit 等工具的 `execute(toolCallId, params, signal)` 可以原样挂到新的 `ToolDefinition.execute` 上。这把自研工作量从「重写整个 coding agent」降到「重写 loop 编排层」。

---

## 四、核心接口设计（TypeScript，可直接落地）

> 以下接口设计参考 pi-agent-core 的 `Agent`（`pi-agent-core/dist/agent.d.ts`）与 `types.ts`，但把所有私有能力提为**公开 API**，并把 DeerHux 实际用到的 hack（§二）逐一对映。接口放 `lib/engine/types.ts`。

### 4.1 `AgentLoop` 接口（loop 引擎主入口）

```ts
// lib/engine/types.ts
import type { AsyncIterable } from "./async-iterable";
import type { Model, Transport } from "@earendil-works/pi-ai";

/**
 * 自研 Agent Loop 引擎主接口。
 *
 * 设计原则：
 * 1. 所有 pi 私有能力（_baseSystemPrompt / _toolRegistry / _isRetryableError）
 *    在此全部提为公开方法，消灭 §二 的全部 hack。
 * 2. prompt() 返回 AsyncIterable<LoopEvent>，前端可直接 for-await 消费，
 *    也可经 AgentSessionWrapper 转成现有 subscribe() 回调（向后兼容）。
 * 3. 一个 AgentLoop 实例 = 一个会话上下文（transcript + tools + queues），
 *    对应 pi 的 Agent + AgentSession 的 loop 部分（不含 session 持久化）。
 *
 * 对应 pi 的私有能力映射见每个方法的 @maps 注释。
 */
export interface AgentLoop {
  // ─── 生命周期 ───────────────────────────────────────────────
  /** 发起一轮 prompt。返回流式事件迭代器。
   *  @maps pi Agent.prompt() —— 公开，无需 hack */
  prompt(message: string | AgentMessage | AgentMessage[], options?: PromptOptions): AsyncIterable<LoopEvent>;

  /** 从当前 transcript 继续（用于 retry / tool 结果回写后的下一轮）。
   *  @maps pi Agent.continue() —— 公开 */
  continue(options?: ContinueOptions): AsyncIterable<LoopEvent>;

  /** 中止当前运行。返回 promise 在运行真正停止后 resolve。
   *  @maps pi Agent.abort() + waitForIdle() —— 公开 */
  abort(): Promise<void>;

  /** 当前是否在运行（agent_start→agent_end 之间为 true，含 tool 执行间隙与 retry backoff）。
   *  @maps DeerHux 自创的 _isRunning（rpc-manager.ts:424）—— pi 只有 isStreaming，间隙期为 false，DeerHux 被迫自维护 */
  readonly isRunning: boolean;

  /** pi 的 isStreaming：仅在 LLM 流式输出期间为 true。
   *  @maps pi AgentState.isStreaming —— 公开 */
  readonly isStreaming: boolean;

  /** 释放底层资源（中止运行、清队列、解监听）。
   *  @maps pi AgentSession.dispose() —— 公开 */
  dispose(): void;

  // ─── 系统提示词（消灭 H1）──────────────────────────────────
  /** 设置【持久】系统提示词。下一次 turn 起生效，不会被 loop 内部重置。
   *  @maps pi 私有 _baseSystemPrompt（rpc-manager.ts:187 的 hack）—— 现在是公开 API */
  setSystemPrompt(prompt: string): void;
  /** 读取当前持久系统提示词。
   *  @maps pi 私有 _baseSystemPrompt（读） */
  getSystemPrompt(): string;

  // ─── 工具注册（消灭 H6/H7/H8/H9）──────────────────────────
  /** 注册一个工具。同名覆盖。
   *  @maps pi 私有 _customTools.push + _refreshToolRegistry（rpc-manager.ts:908-916 的 hack） */
  registerTool(tool: ToolDefinition): void;
  /** 批量注册。 */
  registerTools(tools: ToolDefinition[]): void;
  /** 注销工具（按名）。运行中注销会等待当前 tool_call 结束。
   *  @maps pi 无此能力 —— 新增 */
  unregisterTool(name: string): void;
  /** 设置当前激活工具集（白名单）。未在名单内的工具不暴露给 LLM。
   *  @maps pi AgentSession.setActiveToolsByName() —— 公开（rpc-manager.ts 多处调用） */
  setActiveTools(names: string[]): void;
  /** 查询所有已注册工具。 */
  getAllTools(): ToolInfo[];
  /** 查询当前激活工具名。
   *  @maps pi AgentSession.getActiveToolNames() —— 公开 */
  getActiveTools(): string[];

  // ─── 工具执行模式（消灭 H5/H6/H7/H8）──────────────────────
  /** 设置全局工具执行模式（parallel/sequential）。
   *  @maps pi 私有 Agent.toolExecution 无 setter（rpc-manager.ts:373 的 hack） */
  setToolExecutionMode(mode: ToolExecutionMode): void;
  /** 设置单工具执行模式（覆盖全局）。
   *  @maps pi 私有 _toolRegistry/definitions/state.tools 三处 hack（rpc-manager.ts:377-392） */
  setToolExecutionMode(name: string, mode: ToolExecutionMode): void;

  // ─── 重试策略（消灭 H2/H3/H4）──────────────────────────────
  /** 设置重试策略。传入 null 关闭自动重试。
   *  @maps pi 私有 settingsManager.getRetrySettings + _isRetryableError + _prepareRetry（rpc-manager.ts:302-345 三处 hack） */
  setRetryPolicy(policy: RetryPolicy | null): void;
  /** 查询当前重试状态（是否在重试、第几次）。 */
  readonly retryState: { isRetrying: boolean; attempt: number; maxAttempts: number };

  // ─── Hooks（消灭 H3/H4 的部分需求 + 新增可观测性）─────────
  /** 工具执行前钩子。返回 {block:true} 阻止执行。
   *  @maps pi AgentOptions.beforeToolCall —— 公开（pi-agent-core/dist/agent.d.ts） */
  onBeforeToolCall(hook: BeforeToolCallHook): () => void;
  /** 工具执行后钩子。可覆盖 content/details/isError/terminate。
   *  @maps pi AgentOptions.afterToolCall —— 公开 */
  onAfterToolCall(hook: AfterToolCallHook): () => void;
  /** 重试前钩子（每次重试触发，可改退避、可中止重试）。
   *  @maps pi 私有 _prepareRetry（rpc-manager.ts:339 的 hack） */
  onRetry(hook: RetryHook): () => void;

  // ─── Steering / FollowUp 队列（消灭隐式假设）──────────────
  /** 排队一条 steering 消息（当前 assistant turn 结束后注入）。
   *  @maps pi Agent.steer() —— 公开（pi-agent-core/dist/agent.d.ts） */
  steer(message: string | AgentMessage): void;
  /** 排队一条 follow-up 消息（agent 本要停止时才注入）。
   *  @maps pi Agent.followUp() —— 公开 */
  followUp(message: string | AgentMessage): void;
  /** steering 队列模式。
   *  @maps pi Agent.steeringMode setter —— 公开 */
  setSteeringMode(mode: QueueMode): void;
  /** follow-up 队列模式。
   *  @maps pi Agent.followUpMode setter —— 公开 */
  setFollowUpMode(mode: QueueMode): void;
  /** 清空所有排队消息。
   *  @maps pi Agent.clearAllQueues() —— 公开 */
  clearQueues(): { steering: string[]; followUp: string[] };

  // ─── 模型 / 思考级别（运行时切换，不重建 loop）────────────
  /** 切换模型。
   *  @maps pi AgentSession.setModel() —— 公开 */
  setModel(model: Model<any>): void;
  /** 设置思考级别。传入 clamp 后的实际值（loop 不二次 clamp，消灭 H10）。
   *  @maps pi AgentSession.setThinkingLevel() —— 公开，但 pi 会 clamp，DeerHux 被迫绕过（rpc-manager.ts:1254） */
  setThinkingLevel(level: ThinkingLevel): void;

  // ─── 订阅（兼容现有 subscribe 模式）────────────────────────
  /** 订阅事件（回调式，兼容 AgentSessionWrapper 现有实现）。
   *  @maps pi AgentSession.subscribe() —— 公开 */
  subscribe(listener: (event: LoopEvent) => void): () => void;
}
```

### 4.2 `LoopEvent` 事件模型（discriminated union）

> 基于 pi-agent-core 的 `AgentEvent`（`pi-agent-core/dist/types.d.ts` 第 `AgentEvent` 行）+ pi-coding-agent 的 `AgentSessionEvent` 扩展（`agent-session.d.ts` 第 `AgentSessionEvent` 行）+ DeerHux 自创事件（`agent_file_changed` / `agent_stale_warning`，见 `rpc-manager.ts:686` 合成 `agent_file_changed`、`rpc-manager.ts:757` 合成 `agent_stale_warning`）。**关键改进**：`tool_execution_end` 显式带 `changedFiles`，消灭 `extractChangedFilePath` 的 10+ 字段猜测。

```ts
// lib/engine/types.ts

/** Loop 事件总类型。前端 useAgentSession.ts 的 handleAgentEvent 逐分支对映。 */
export type LoopEvent =
  // ─── loop 级 ─────────────────────────────────────────────
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean; error?: string }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // ─── 消息流式 ────────────────────────────────────────────
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // ─── 工具执行（★ changedFiles 是新契约，消灭 extractChangedFilePath）★
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult<unknown>; isError: boolean; changedFiles?: string[] }
  // ─── 队列 ────────────────────────────────────────────────
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  // ─── 重试（消灭 H2/H3/H4 的同时给前端可见性）─────────────
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  // ─── 压缩 ────────────────────────────────────────────────
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result?: CompactionResult; aborted: boolean; willRetry: boolean; errorMessage?: string }
  // ─── DeerHux 业务事件（保留，loop 不发，由 wrapper 注入）──
  | { type: "agent_file_changed"; filePath: string; toolName: string }
  | { type: "agent_stale_warning"; idleMs: number; destroyInMs: number; isRunning: boolean; isStreaming: boolean; lastEventType: string };
```

> **契约说明**：
> - `agent_file_changed` / `agent_stale_warning` 在 pi 里不存在，是 DeerHux 在 `AgentSessionWrapper.start()`（subscribe 回调内，`rpc-manager.ts:653` 起；合成点 `rpc-manager.ts:686` 与 `757`）合成的。自研 loop **不发**这两个事件，仍由 wrapper 在 `tool_execution_end.changedFiles` 非空时合成 `agent_file_changed`，由 wrapper 的 idle timer 合成 `agent_stale_warning`——保持向后兼容。
> - `message_end.message.role === "user"` 的 user echo（`rpc-manager.ts:1044-1063`）也由 wrapper 合成，loop 只发 assistant/tool 的 message_end。

### 4.3 `ToolDefinition` 契约

> 兼容 pi-coding-agent 的 `ToolDefinition`（`extensions/types.d.ts:328`）与 pi-agent-core 的 `AgentTool`（`types.d.ts` 第 `AgentTool` 行），**复用现有工具的 execute 体**（read/bash/edit/...）。

```ts
// lib/engine/types.ts
import type { Static, TSchema } from "typebox";

/** 工具定义。与 pi defineTool() 产出的 ToolDefinition 同构，可直接互转。
 *  ★ executionMode 在 register 时即生效，消灭 H6/H7/H8 的三处补丁。 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** 工具名（LLM tool_call 里出现） */
  name: string;
  /** UI 显示标签 */
  label: string;
  /** 给 LLM 的描述 */
  description: string;
  /** system prompt「Available tools」段的一行摘要（可选） */
  promptSnippet?: string;
  /** system prompt「Guidelines」段的额外条目（可选） */
  promptGuidelines?: string[];
  /** 参数 schema（TypeBox） */
  parameters: TParams;
  /** 单工具执行模式覆盖（可选）。register 时生效。 */
  executionMode?: ToolExecutionMode;
  /** execute 体。★ 复用 pi 内置工具的 execute，签名一致。
   *  throw 表示失败（loop 转成 isError:true 的 tool result）。 */
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** 可选：原始 tool_call 参数预处理（schema 校验前）。 */
  prepareArguments?: (args: unknown) => Static<TParams>;
}

export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details: T;
  /** 显式声明本次执行修改了哪些文件（绝对路径）。★ 消灭 extractChangedFilePath。
   *  loop 把它透传到 tool_execution_end.changedFiles。 */
  changedFiles?: string[];
  /** 终止 hint：本批所有工具都 terminate=true 时 loop 提前停。 */
  terminate?: boolean;
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  executionMode?: ToolExecutionMode;
  source?: "builtin" | "custom" | "mcp" | "extension";
}
```

> **迁移策略**：现有 `defineTool({...})` 调用（code_search / codegraph_* / mcp__* / spawn_subagent）的参数对象与 `ToolDefinition` **字段完全兼容**，只需把 `defineTool` 换成直接传对象给 `loop.registerTool()`。execute 签名一致（都是 `(toolCallId, params, signal, onUpdate) => Promise<AgentToolResult>`），**无需改任何工具实现**。

### 4.4 `RetryPolicy` / `ToolExecutionMode` / `SteeringMode` 类型

```ts
// lib/engine/types.ts

export type ToolExecutionMode = "sequential" | "parallel";
export type QueueMode = "all" | "one-at-a-time";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** 重试策略。一次性消灭 H2/H3/H4 三处 hack。
 *  对应 rpc-manager.ts 的 hardenAutoRetry() 全部能力。 */
export interface RetryPolicy {
  /** 是否启用自动重试 */
  enabled: boolean;
  /** 最大重试次数 */
  maxRetries: number;
  /** 初始退避（ms）。DeerHux 要求 >= 5000（rpc-manager.ts:273 MIN_AUTO_RETRY_DELAY_MS） */
  baseDelayMs: number;
  /** 退避上限（ms）。对应 pi AgentOptions.maxRetryDelayMs */
  maxDelayMs?: number;
  /** ★ 自定义「是否可重试」判断。消灭 H3。
   *  入参：错误消息 + 助手消息上下文（含已产生内容长度）。 */
  isRetryable?: (ctx: { errorMessage: string; assistantMessage: AssistantLike; attempt: number }) => boolean;
  /** ★ 重试前钩子。可改退避、可记录、可中止。消灭 H4。
   *  返回 { abort: true } 则不重试。 */
  beforeRetry?: (ctx: { attempt: number; error: unknown; proposedDelayMs: number }) =>
    Promise<{ delayMs: number; abort?: boolean }> | { delayMs: number; abort?: boolean };
}

/** beforeToolCall 钩子签名。与 pi 一致。 */
export type BeforeToolCallHook = (
  ctx: { assistantMessage: AssistantMessage; toolCall: AgentToolCall; args: unknown; signal: AbortSignal },
) => Promise<{ block?: boolean; reason?: string } | undefined>;

/** afterToolCall 钩子签名。与 pi 一致。 */
export type AfterToolCallHook = (
  ctx: { assistantMessage: AssistantMessage; toolCall: AgentToolCall; args: unknown; result: AgentToolResult<unknown>; isError: boolean; signal: AbortSignal },
) => Promise<{ content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean; terminate?: boolean } | undefined>;

/** RetryHook：onRetry 注册的钩子。 */
export type RetryHook = (ctx: { attempt: number; maxAttempts: number; error: unknown; delayMs: number }) => void | Promise<void>;

type AssistantLike = { stopReason?: string; errorMessage?: string; content?: unknown };
```

### 4.5 `AgentLoopFactory` 工厂签名

```ts
// lib/engine/factory.ts
import type { Model, Transport, SimpleStreamOptions } from "@earendil-works/pi-ai";

/** 创建自研 loop 实例。
 *  ★ transport / streamFn 来自 pi-ai，不动 pi-ai。 */
export interface AgentLoopFactoryOptions {
  /** 初始模型（pi-ai 的 Model） */
  model: Model<any>;
  /** ★ LLM 传输函数。默认用 pi-ai 的 streamSimple。
   *  这样 loop 自研但 provider 适配仍走 pi-ai。 */
  streamFn?: StreamFn;
  /** 初始系统提示词 */
  systemPrompt?: string;
  /** 初始工具集（可后续 registerTool 增删） */
  tools?: ToolDefinition[];
  /** 初始激活工具名（白名单） */
  activeToolNames?: string[];
  /** 工作目录（工具执行用） */
  cwd: string;
  /** ★ 会话存储。可选——不传则纯内存（用于一次性 loop，如 models-config/test）。
   *  传了则走 SessionStore（M6，jsonl 或自研）。 */
  sessionStore?: SessionStore;
  /** 重试策略（消灭 H2/H3/H4） */
  retryPolicy?: RetryPolicy | null;
  /** 全局工具执行模式 */
  toolExecutionMode?: ToolExecutionMode;
  /** steering / followUp 队列模式 */
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  /** 思考级别 */
  thinkingLevel?: ThinkingLevel;
  /** ★ API key 解析器（短生命周期 OAuth token 用）。来自 pi-ai 思路，复用 DeerHux 的 AuthStorage。 */
  getApiKey?: (provider: string) => Promise<string | undefined>;
  /** ★ convertToLlm：把 AgentMessage[] 转 pi-ai Message[]。复用 pi-agent-core 现有实现。 */
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** ★ transformContext：上下文裁剪/注入（compaction 用）。复用 pi-agent-core 现有实现。 */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** 会话 id（透传给 provider 做 cache-aware） */
  sessionId?: string;
}

export type AgentLoopFactory = (options: AgentLoopFactoryOptions) => AgentLoop;
```

> **`StreamFn` 直接复用 pi-ai**：`type StreamFn = (...args: Parameters<typeof streamSimple>) => ReturnType<typeof streamSimple> | Promise<...>`（见 `pi-agent-core/dist/types.d.ts` 第 `StreamFn` 行）。自研 loop 调 `streamFn(model, context, options)` 拿到 `AssistantMessageEventStream`，自己跑 tool-calling 循环。**pi-ai 的 14+ provider 一行不用改。**

### 4.6 `SessionStore` 接口（M6 解耦 jsonl）

```ts
// lib/session/store.ts
/** 会话存储抽象。M6 先用 pi SessionManager 适配，后可换自研 jsonl/in-mem。 */
export interface SessionStore {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  isPersisted(): boolean;
  appendMessage(message: AgentMessage): string;        // 返回 entryId
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCompaction(result: CompactionResult): string;
  getBranch(): SessionEntry[];                          // 当前分支路径
  getEntry(id: string): SessionEntry | undefined;
  createBranchedSession(leafId: string): string | undefined;
  // ... 其余按 pi SessionManager 公开方法补
}
```

---

## 五、能力对齐表（AgentSession 公开方法 ↔ 自研 loop 承接）

> 基于读 `pi-coding-agent/dist/core/agent-session.d.ts` 的全部公开成员 + `grep -no "this\.inner\.[a-zA-Z]*" lib/rpc-manager.ts` 统计 DeerHux 实际调用点。

### 5.1 公开方法（methods）

| pi `AgentSession` 方法/属性 | DeerHux 是否用到（文件:行） | 自研 loop 是否承接 | 归属 |
| --- | --- | --- | --- |
| `prompt(text, options?)` | ✅ `rpc-manager.ts:1077,1321`（commitAndTrackPromptTurn + follow_up 降级） | ✅ `loop.prompt()` | **loop** |
| `abort()` | ✅ `rpc-manager.ts:872,1405`（abortAndSettle + destroy） | ✅ `loop.abort()` | **loop** |
| `subscribe(listener)` | ✅ `rpc-manager.ts:653`（start 里订阅转发） | ✅ `loop.subscribe()` | **loop** |
| `steer(text, images?)` | ✅ `rpc-manager.ts:1292` | ✅ `loop.steer()` | **loop** |
| `followUp(text, images?)` | ✅ `rpc-manager.ts:1311` | ✅ `loop.followUp()` | **loop** |
| `setActiveToolsByName(names)` | ✅ `rpc-manager.ts:468,479,482,511,1331,1343,1355`（高频） | ✅ `loop.setActiveTools()` | **loop** |
| `getActiveToolNames()` | ✅ `rpc-manager.ts:476,892,1010,1332` | ✅ `loop.getActiveTools()` | **loop** |
| `getAllTools()` | ✅ `rpc-manager.ts:474,1331` | ✅ `loop.getAllTools()` | **loop** |
| `setModel(model)` | ✅ `rpc-manager.ts:1144,1204`（set_model + recover） | ✅ `loop.setModel()` | **loop** |
| `setThinkingLevel(level)` | ✅ `rpc-manager.ts:1249` | ✅ `loop.setThinkingLevel()`（不 clamp，消灭 H10） | **loop** |
| `compact(customInstructions?)` | ✅ `rpc-manager.ts:1275` | ✅ `loop.compact()`（调 SessionStore + convertToLlm） | **loop** |
| `setAutoCompactionEnabled(b)` | ✅ `rpc-manager.ts:1280` | ✅ `loop` 配置项 | **loop** |
| `abortCompaction()` | ✅ `rpc-manager.ts:1381` | ✅ `loop.abortCompaction()` | **loop** |
| `setAutoRetryEnabled(b)` | ✅ `rpc-manager.ts:1386` | ✅ `loop.setRetryPolicy(null)` | **loop** |
| `navigateTree(targetId, opts?)` | ✅ `rpc-manager.ts:1243` | ❌ 不承接 | **session 层**（SessionStore） |
| `getContextUsage()` | ✅ `rpc-manager.ts:1162` | ✅ `loop.getContextUsage()` | **loop** |
| `dispose()` | ✅ `rpc-manager.ts:1405`（destroy 内） | ✅ `loop.dispose()` | **loop** |
| `executeBash(...)` | ❌ DeerHux 未用（走 bash 工具） | ❌ 不承接 | **保留 pi 或废弃** |
| `exportToHtml(path?)` | ❌ 未用 | ❌ | **保留 pi / 后续** |
| `exportToJsonl(path?)` | ❌ 未用 | ❌ | **保留 pi / 后续** |
| `getSessionStats()` | ❌ 未用 | ❌ | **保留 pi / 后续** |
| `cycleModel(direction?)` | ❌ 未用（DeerHux 用 setModel） | ❌ | 废弃 |
| `cycleThinkingLevel()` | ❌ 未用 | ❌ | 废弃 |
| `getAvailableThinkingLevels()` | ❌ 未用（走 `/api/models`） | ❌ | 废弃 |
| `supportsThinking()` | ❌ 未用 | ❌ | 废弃 |
| `sendCustomMessage(...)` | ❌ 未用 | ❌（如需可加 loop.sendCustomMessage） | 可选 |
| `sendUserMessage(...)` | ❌ 未用（走 prompt） | ❌ | 废弃 |
| `clearQueue()` | ❌ 未用 | ✅ `loop.clearQueues()` | **loop** |
| `getUserMessagesForForking()` | ❌ 未用 | ❌ | **session 层** |
| `bindExtensions(...)` / `reload()` / `hasExtensionHandlers()` / `extensionRunner` | ❌ 未用（DeerHux 不用 pi extensions 框架） | ❌ | 废弃 |
| `recordBashResult(...)` / `abortBash()` | ❌ 未用 | ❌ | 废弃 |
| `createReplacedSessionContext()` | ❌ 未用 | ❌ | **session 层** |
| `getLastAssistantText()` | ❌ 未用 | ❌（wrapper 自己取） | 废弃 |

### 5.2 公开属性（getters）

| pi getter | DeerHux 用法（文件:行） | 归属 |
| --- | --- | --- |
| `sessionId` | ✅ `rpc-manager.ts` 共 20+ 处 | **session 层** |
| `sessionFile` | ✅ `rpc-manager.ts:639,1165,1210` | **session 层** |
| `isStreaming` | ✅ `rpc-manager.ts:769,818,854,863,1001,1307` 等 12 处 | **loop** |
| `isCompacting` | ✅ `rpc-manager.ts:769,819,1001,1167` | **loop** |
| `autoCompactionEnabled` | ✅ `rpc-manager.ts:1168` | **loop** |
| `autoRetryEnabled` | ✅ `rpc-manager.ts:1169` | **loop** |
| `retryAttempt` | ❌ 未用（DeerHux 从事件取） | loop 内部 |
| `isRetrying` | ❌ 未用 | loop 内部 |
| `model` | ✅ `rpc-manager.ts:970,1161,1253` | **loop** |
| `thinkingLevel` | ✅ `rpc-manager.ts:1178`（取 state） | **loop** |
| `systemPrompt` | ✅ `rpc-manager.ts` 多处（取 `agent.state.systemPrompt`） | **loop** |
| `messages` | ❌（DeerHux 走 session-reader 读 jsonl） | session 层 |
| `steeringMode` / `followUpMode` | ❌ 未读 | loop |
| `pendingMessageCount` | ❌ 未用 | loop |
| `sessionName` | ❌ 未用 | session 层 |
| `scopedModels` | ❌ 未用 | 废弃 |
| `promptTemplates` | ❌ 未用 | 废弃 |
| `resourceLoader` | ❌ 未用（DeerHux 自己 new） | 废弃 |
| `agent`（公开字段，指向 pi Agent） | ✅ `rpc-manager.ts` 40+ 处取 `agent.state` | **loop**（loop 自身即 state 持有者） |
| `sessionManager`（公开字段） | ✅ `rpc-manager.ts` 20+ 处（getCwd/getBranch/appendCustomEntry） | **session 层** |
| `settingsManager`（公开字段） | ✅ `rpc-manager.ts:1264`（getCompactionSettings）+ `302` hack | **保留 pi / 降级为只读** |
| `modelRegistry`（公开字段） | ✅ `rpc-manager.ts:1137,1189`（find model） | **保留 pi**（AuthStorage/ModelRegistry 不动） |
| `extensionRunner` | ❌ 未用 | 废弃 |

### 5.3 归属统计

| 归属 | 方法/属性数 | 说明 |
| --- | --- | --- |
| **loop 承接** | ~18 | prompt/abort/subscribe/steer/followUp/工具集/模型/思考级别/重试/压缩/contextUsage 等 |
| **session 层承接**（SessionStore） | ~8 | sessionId/sessionFile/navigateTree/getBranch/appendCustomEntry/createBranchedSession |
| **保留 pi**（AuthStorage/ModelRegistry/Settings 只读） | ~3 | modelRegistry/settingsManager(只读)/AuthStorage |
| **废弃**（DeerHux 不用） | ~25 | extensions 框架、executeBash、exportHtml、cycle* 等 |

> **结论**：60+ 公开方法里，DeerHux **实际用到 ~25 个**，其中 ~18 个属 loop 核心（自研承接），~8 个属 session 层（M6 适配），其余可废弃。这证明「自研 loop + 适配 session」的切分是**收敛的**，不是无底洞。

---

## 六、渐进迁移路线图

> 原则：每个里程碑**不破坏现有功能**、**可与 pi 并存**（feature flag）、**可回退**（删 flag 即回旧实现）。每个里程碑都可独立 ship。

### M0：抽象 `AgentEnginePort`，收敛所有 pi 调用（基础设施）

**目标**：把 `AgentSessionWrapper` 对 `this.inner`（AgentSession）的全部访问，收敛到一个 `AgentEnginePort` 接口（`lib/engine/port.ts`），加运行时探测（SDK 升级告警）。**此里程碑不改任何运行时行为**，纯重构。

**改哪些文件**：
- 新增 `lib/engine/port.ts`：定义 `AgentEnginePort` 接口（= §四 AgentLoop 的子集 + session 字段），定义 `PiEngineAdapter`（把现有 AgentSession 包成 Port）。
- 改 `lib/rpc-manager.ts`：`AgentSessionWrapper.inner: AgentSessionLike` → `inner: AgentEnginePort`；所有 `this.inner.xxx` 调用不变（Port 接口同构）。
- 新增 `lib/engine/sdk-guard.ts`：启动时探测 pi 私有字段是否存在（`_baseSystemPrompt`/`_toolRegistry`/`_isRetryableError`/`_customTools`/`_refreshToolRegistry`），缺失则 `console.warn` 并设置 `process.env.DEERHUX_PI_SDK_DRIFT=1`。

**验收标准**：
- [ ] `npm run build` 通过，`npm run lint` 通过。
- [ ] 现有所有 hack 函数（`setEffectiveSystemPrompt`/`hardenAutoRetry`/`configureToolExecutionModes`/`installMcpRuntime`）迁移到 `PiEngineAdapter` 的方法里，行为不变。
- [ ] 单测：`sdk-guard.test.ts` —— mock 一个缺 `_baseSystemPrompt` 的假 session，断言告警触发。
- [ ] 端到端冒烟：发一条 prompt，确认事件流、工具执行、MCP 加载全部正常（与迁移前 diff 为空）。

**风险**：类型重构面广（40+ 处 `this.inner`），但 Port 与 AgentSessionLike 同构，风险低。
**回退**：`git revert`，无运行时影响。
**估时**：1.5 人周。

### M1：自研 loop 骨架（prompt 流式 + abort + 基本事件流），灰度在只读路径

**目标**：实现 `lib/engine/deer-loop.ts` 的 `AgentLoop` 最小可用版本——`prompt()` 返回 `AsyncIterable<LoopEvent>`，支持 `agent_start/message_start/update/end/agent_end` + `abort()`。**先不接工具、不接重试、不接队列**。在一条只读命令路径上灰度（feature flag `DEERHUX_LOOP_ENGINE=deer`）。

**改哪些文件**：
- 新增 `lib/engine/deer-loop.ts`：`DeerLoopEngine implements AgentLoop`。核心是调 pi-ai 的 `streamSimple`（`import { streamSimple } from "@earendil-works/pi-ai"`），自己跑流式 + 事件发射。
- 新增 `lib/engine/factory.ts`：`createAgentLoop(options)`。
- 改 `lib/rpc-manager.ts`：`startRpcSession` 末尾加 `if (process.env.DEERHUX_LOOP_ENGINE === "deer") { inner = wrapDeerLoop(...); }`。
- 灰度入口：`app/api/agent/[id]/route.ts` 的只读命令（如 `get_state`）或新增 `/api/agent/[id]/test-loop` 调试端点。

**验收标准**：
- [ ] 单测：`deer-loop.test.ts` —— mock streamFn 返回固定 AssistantMessageEventStream，断言事件序列正确（agent_start → message_start → message_update*N → message_end → agent_end）。
- [ ] 单测：`deer-loop-abort.test.ts` —— 流到一半 abort，断言 `message_end.stopReason === "aborted"` 且 `agent_end` 触发。
- [ ] 灰度：手动 `DEERHUX_LOOP_ENGINE=deer` 跑一个纯文本对话（无工具），前端正常显示流式。
- [ ] 回退：flag 默认 off，生产零影响。

**风险**：流式中断/错误处理细节多（pi 的 stream 契约见 `pi-ai/dist/types.d.ts` 第 `AssistantMessageEvent` 行：`start/partial/done/error`）。先覆盖 happy path + abort。
**回退**：删 flag 分支。
**估时**：2 人周。

### M2：工具注册 + 并行/串行执行（消灭 H5/H6/H7/H8/H9）

**目标**：自研 loop 支持工具调用循环（`toolCall` → `execute` → `toolResult` → 下一轮 LLM），支持 `registerTool/unregisterTool/setActiveTools/setToolExecutionMode`，**复用 pi 内置工具的 execute 体**。

**改哪些文件**：
- 扩展 `lib/engine/deer-loop.ts`：实现 tool-calling 循环（参考 pi-agent-core `agent-loop.ts` 的 `runAgentLoop` 逻辑）。
- 新增 `lib/engine/tool-registry.ts`：`ToolRegistry` 类（单一数据源，消灭 pi 的三份副本）。
- 新增 `lib/engine/tool-executor.ts`：并行/串行执行器（参考 pi `ToolExecutionMode` 语义：sequential 逐个、parallel 预检后并发）。
- 复用工具：新增 `lib/engine/builtin-tools.ts`，从 `pi-coding-agent` 的 `createReadTool/createBashTool/...`（`tools/index.d.ts`）拿到 `AgentTool`，转成 `ToolDefinition` 注册。
- 迁移 DeerHux 自定义工具：`code_search`/`codegraph_*`/`mcp__*`/`spawn_subagent` 的 `defineTool({...})` 对象**原样**传给 `loop.registerTool()`。

**验收标准**：
- [ ] 单测：`tool-registry.test.ts` —— register 覆盖、unregister、setActiveTools 白名单过滤。
- [ ] 单测：`tool-executor-parallel.test.ts` —— 3 个 parallel 工具并发执行，完成顺序与发射顺序正确。
- [ ] 单测：`tool-executor-sequential.test.ts` —— bash 后 edit 后 write 严格串行。
- [ ] 单测：`tool-execution-mode.test.ts` —— `setToolExecutionMode("bash","sequential")` 后该工具串行，其他并行（消灭 H6/H7/H8）。
- [ ] 单测：`mcp-hot-reload.test.ts` —— 运行中 `unregisterTool("mcp__old")` + `registerTool(mcpNew)`，下一轮 tool_call 用新工具（消灭 H9）。
- [ ] 灰度：`DEERHUX_LOOP_ENGINE=deer` 跑一个「读文件+改文件+grep」混合任务，工具正常。
- [ ] `extractChangedFilePath` 可删除：改用 `tool_execution_end.changedFiles`（工具 execute 返回 `changedFiles`）。

**风险**：工具并行执行的错误隔离（一个工具 throw 不能拖垮整批）；AbortSignal 在并行工具里的传播。
**回退**：flag off。
**估时**：3 人周（最重里程碑）。

### M3：system prompt 公开设置（消灭 H1）

**目标**：自研 loop 的 `setSystemPrompt()` 持久生效，DeerHux 的角色/模式/turn_context 注入直接调它。

**改哪些文件**：
- 扩展 `lib/engine/deer-loop.ts`：`setSystemPrompt(prompt)` 写入 loop 内部 `_baseSystemPrompt`（私有但 loop 自己拥有，不再 hack 外部），每次 turn 用它构建 context。
- 改 `lib/rpc-manager.ts`：`setEffectiveSystemPrompt()` 内部判断 `if (engine instanceof DeerLoopEngine) engine.setSystemPrompt(prompt); else /* 旧 pi hack */`。
- 迁移 `withTemporarySystemPrompt`（`rpc-manager.ts:599`）： DeerLoopEngine 下直接 `setSystemPrompt` + `finally setSystemPrompt(restore)`。

**验收标准**：
- [x] 单测：`scripts/test-system-prompt-persistence.mjs` —— setSystemPromptPersistent 后连发 3（实际 5）个 prompt，每个 turn 的 context.systemPrompt 都是设置的值（不被重置）。
- [x] 单测：`scripts/test-turn-context-block.mjs` —— withTemporarySystemPrompt 注入 `<turn_context>` 块，turn 结束后恢复，无泄漏。
- [ ] 灰度验证角色切换：切角色 → 发消息 → 系统提示词含角色段落（待默认 on 后端到端验）。
- [x] `npx tsc --noEmit` 通过 / `npm run lint` 通过（0 errors）。
- [x] M1+M2 回归全过（test-deer-loop / test-deer-loop-tools / test-tool-registry / test-tool-executor / test-sdk-guard）。

**★ M3 完成注记（实际落地与原计划差异）**：

1. **M1 已做完 M3 的活**：M1 的 `DeerLoopEngine.setSystemPromptPersistent`（`lib/engine/deer-loop.ts:729`）已双写 `_baseSystemPrompt` + `_agentState.systemPrompt`；`consumeStream` 的 while 循环**每轮在循环内**重新构造 context（`systemPrompt: this._baseSystemPrompt || undefined`，`:316`），不缓存到循环外。所以「setSystemPromptPersistent 后连发 N prompt 值恒定」是天然成立的——**DeerLoopEngine 自持 `_baseSystemPrompt`，没有 pi 那种「外部 `_rebuildSystemPrompt` 把 state.systemPrompt 覆盖回私有字段」的 H1 bug**。M3 仅验证 + 补注释，无逻辑改动。

2. **不新增 Port 方法**：wrapper 读 system prompt 全部走 `this.inner.agent.state?.systemPrompt`（rpc-manager.ts 17 处），DeerLoopEngine 的 `get agent()` 返回的 `_agentState` 已与 `_baseSystemPrompt` 双写同步。加 `Port.getSystemPrompt()` 是接口膨胀、无收益，**刻意不加**。

3. **turn_context strip 责任分工（关键决策）**：`setSystemPromptPersistent` 是**纯透传**（set 什么，context 就用什么），**不**自动 `stripTurnContextBlock`。strip 是 wrapper 的职责（rpc-manager.ts 的 `stripTurnContextBlock` + `applyRolePrompt` + `withTemporarySystemPrompt.finally`）。理由：若 loop 也 strip，会与 wrapper 的 strip 重叠，且改变 set 的语义（set X 不一定得 X），破坏可预测性。DeerLoopEngine 不知道 turn_context 是什么，只负责「值精确透传 + 持久」。见 `scripts/test-turn-context-block.mjs` 用例 4。

4. **rpc-manager.ts 零改动**：原计划「`setEffectiveSystemPrompt` 内部 `instanceof DeerLoopEngine` 分发」**不需要**——M0 的 Port 多态已让 `inner.setSystemPromptPersistent()` 自动分发到 DeerLoopEngine（公开 state 写）或 PiEngineAdapter（私有字段 hack）。`applyRolePrompt` / `withTemporarySystemPrompt` 走 Port 接口即可，无需 instanceof。这是 M0 的红利。

5. **PiEngineAdapter 零改动**：H1 hack（`pi-engine-adapter.ts:221-229`）保留，pi 路径稳定。feature flag 默认 off，生产行为不变。

**风险**：低（自研 loop 自己管状态，无外部覆盖）。
**回退**：flag off。
**估时**：1 人周（实际：验证 + 测试 + 注释，远小于 1pw）。

### M4：重试策略公开 API（消灭 H2/H3/H4）

**目标**：自研 loop 的 `setRetryPolicy(policy)` 支持 `isRetryable`/`beforeRetry` 钩子，DeerHux 的 `hardenAutoRetry` 逻辑迁入。

**改哪些文件**：
- 扩展 `lib/engine/deer-loop.ts`：实现 retry 循环（捕获 stream error → 判 `policy.isRetryable` → `policy.beforeRetry` → sleep → `continue()`），发射 `auto_retry_start/end` 事件。
- 迁移 `lib/rpc-manager.ts:272-345` 的 `hardenAutoRetry` 常量与逻辑（`MIN_AUTO_RETRY_DELAY_MS`/`PREMATURE_STREAM_ERROR_RE`/`AUTO_RETRY_SETTLE_MS`）到 `RetryPolicy` 默认值。
- 删除 `hardenAutoRetry()` 调用（DeerLoopEngine 路径）。

**验收标准**：
- [ ] 单测：`retry-policy.test.ts` —— 模拟 500 错误，断言重试 3 次、退避递增、最终 `auto_retry_end{success:false}`。
- [ ] 单测：`retry-isRetryable.test.ts` —— `isRetryable` 返回 false 时不重试（覆盖 H3 的 premature-stream 启发式：完整消息+connection lost → 不重试）。
- [ ] 单测：`retry-beforeRetry.test.ts` —— `beforeRetry` 返回 `{abort:true}` 中止重试（覆盖 H4）。
- [ ] 灰度：故意配一个会 500 的模型，观察前端 retryInfo 显示。

**风险**：retry 与 abort 的竞争（abort 时 retry 应立即停）；retry 期间的事件顺序（agent_end.willRetry=true → auto_retry_start → ...）。
**回退**：flag off。
**估时**：1.5 人周。

### M5：steering/followUp 队列

**目标**：自研 loop 支持 `steer()`/`followUp()`/`setSteeringMode()`/`clearQueues()`，发射 `queue_update` 事件。

**改哪些文件**：
- 扩展 `lib/engine/deer-loop.ts`：实现两个队列（参考 pi `Agent` 的 `steeringQueue`/`followUpQueue`，`agent.d.ts`）。drain 点：turn 结束后（steering）、agent 本要停止时（followUp）。
- 改 `lib/rpc-manager.ts`：`steer`/`follow_up` 命令在 DeerLoopEngine 路径下调 `loop.steer/followUp`。

**验收标准**：
- [ ] 单测：`steering-queue.test.ts` —— agent 跑工具时 steer 一条消息，turn 结束后注入，下一轮 LLM 看见。
- [ ] 单测：`followup-queue.test.ts` —— agent 停止后 followUp 触发新 turn。
- [ ] 单测：`queue-mode.test.ts` —— `one-at-a-time` 模式只注入最老一条。
- [ ] 灰度：前端「补充说明」输入框（steer）+「继续」按钮（followUp）正常。

**风险**：队列 drain 时机与 tool 执行的交错。
**回退**：flag off。
**估时**：1.5 人周。

### M6：与 SessionStore 适配（解耦 jsonl 依赖）

**目标**：把 DeerHux 对 pi `SessionManager` 的直接依赖收敛到 `SessionStore` 接口，先用 `PiSessionStoreAdapter`（包 pi SessionManager）保持 jsonl 不变，后续可换自研实现。

**改哪些文件**：
- 新增 `lib/session/store.ts`：`SessionStore` 接口（§4.6）。
- 新增 `lib/session/pi-session-store.ts`：`PiSessionStoreAdapter implements SessionStore`，内部委托 pi `SessionManager`。
- 改 `lib/rpc-manager.ts`：所有 `this.inner.sessionManager.xxx` → `this.sessionStore.xxx`。
- 改 `lib/session-reader.ts`：`piBuildSessionContext` 调用收敛到 adapter（仍用 pi 实现，但 DeerHux 业务代码不直接 import pi SessionManager）。

**验收标准**：
- [ ] 单测：`pi-session-store-adapter.test.ts` —— appendMessage/getBranch/createBranchedSession 委托正确。
- [ ] 端到端：fork/navigateTree/compact 全部正常。
- [ ] `grep "SessionManager" lib/rpc-manager.ts` 命中数下降（业务代码不再直接 new SessionManager，只通过 factory）。

**风险**：`buildSessionContext`（pi 的 jsonl→messages 还原）逻辑复杂，M6 先**继续用 pi 实现**，不重写。
**回退**：adapter 内部就是 pi，行为不变。
**估时**：2 人周。

### 里程碑汇总

| 里程碑 | 目标 | 消灭的 hack | 估时 | 可独立 ship |
| --- | --- | --- | --- | --- |
| M0 | Port 抽象 + SDK 探测 | （0，纯重构） | 1.5pw | ✅ |
| M1 | loop 骨架（流式+abort） | （0，灰度基础） | 2pw | ✅ |
| M2 | 工具注册+并行/串行 | H5/H6/H7/H8/H9 | 3pw | ✅ |
| M3 | system prompt 公开 | H1 | 1pw | ✅ |
| M4 | 重试策略公开 | H2/H3/H4 | 1.5pw | ✅ |
| M5 | steering/followUp 队列 | （契约明确） | 1.5pw | ✅ |
| M6 | SessionStore 适配 | （解耦 jsonl） | 2pw | ✅ |
| **合计** | | **9 个 hack + 1 半 hack** | **12.5pw** | |

> H10（thinkingLevel clamp 绕过）在 M1 的 `setThinkingLevel` 不 clamp 即自然消灭。`extractChangedFilePath` 在 M2 的 `changedFiles` 契约后删除。

---

## 七、风险与回退策略

### 7.1 最容易出隐蔽 bug 的地方

| 风险点 | 具体场景 | 规避 |
| --- | --- | --- |
| **并发：工具并行执行** | 3 个 parallel 工具并发，一个 throw，其他结果如何发射？AbortSignal 如何传播？ | 严格按 pi 的 `ToolExecutionMode` 语义（`types.d.ts` 第 `ToolExecutionMode` 行注释）：parallel 模式「preflight 串行 → execute 并行 → tool_execution_end 按完成序 → tool-result 按源序」。单测必须覆盖「一个 throw 不影响其他」。 |
| **中断：abort 时机** | abort 在 stream 中途、tool 执行中途、retry backoff 期间分别会发生什么？ | 明确契约：abort 立即发 AbortSignal，loop 等当前 in-flight 操作（stream chunk / tool execute）抛出 AbortError 后发 `agent_end`。`abort()` 返回的 promise 在 agent 真正 idle 后 resolve（对映 pi `waitForIdle`）。 |
| **事件顺序：agent_end 的 willRetry** | retry 期间 agent_end.willRetry=true，前端（`useAgentSession.ts:1018`）据此保持 `agentRunning=true`。顺序错乱会导致 UI 卡在 streaming。 | 自研 loop 必须严格复刻 pi 的事件序：`agent_end{willRetry:true}` → `auto_retry_start` → `auto_retry_end{success}` → `agent_start`（成功）或 `auto_retry_end{success:false}`（失败）。单测用快照断言事件序列。 |
| **tool 结果回写时机** | tool 执行完 → `tool_execution_end` → tool-result message → 下一轮 LLM。回写早了模型看不到完整结果，晚了 UI 卡顿。 | 复刻 pi：`afterToolCall` hook 应用后 → 发 `tool_execution_end` → 追加 ToolResultMessage 到 transcript → 检查 steering queue → 决定下一轮。 |
| **system prompt 泄漏** | `<turn_context>` 块泄漏到 `_baseSystemPrompt`，第一轮的 context 冻结到每轮（DeerHux 已踩过，见 `rpc-manager.ts:190 TURN_CONTEXT_BLOCK_RE`）。 | `setSystemPrompt` 时强制 `stripTurnContextBlock`；withTemporarySystemPrompt 用 try/finally 恢复。单测覆盖「连续两轮 turn_context 不同」。 |
| **MCP 热替换竞态** | 运行中 reload MCP，正好有 tool_call 在用旧工具。 | `unregisterTool` 标记 pendingRemoval，等当前 tool_call 结束才真删（契约写明）。 |
| **OAuth token 过期** | 长工具执行期间 GitHub Copilot token 过期。 | `getApiKey` 每次 LLM 调用前调（pi-agent-core `AgentLoopConfig.getApiKey` 已有此设计，复用）。 |

### 7.2 保证 loop 自研期间 DeerHux 仍可发布

**Feature flag 双实现并存**：

```ts
// lib/rpc-manager.ts startRpcSession 末尾
const useDeerLoop = process.env.DEERHUX_LOOP_ENGINE === "deer";
let inner: AgentEnginePort;
if (useDeerLoop) {
  inner = await createDeerLoopEngine({ ... });  // 自研
} else {
  ({ session: inner } = await createAgentSession({ ... }));  // 旧 pi
  inner = new PiEngineAdapter(inner);
}
```

- **每个里程碑**都通过 `DEERHUX_LOOP_ENGINE=deer` 开关，默认 off（生产用 pi）。
- **灰度策略**：先内部 dogfood（开发者本地 flag on）→ 单个只读端点灰度（M1）→ 完整 prompt 路径灰度（M2+）→ 默认 on（M6 后）。
- **回退**：任何时候 `DEERHUX_LOOP_ENGINE` 设回 falsy 即回旧 pi 实现，**无需改代码、无需发版**。
- **SDK 升级告警**（M0 的 sdk-guard）：pi 升级后若私有字段改名/删除，`PiEngineAdapter` 的 hack 会失效，sdk-guard 启动告警，避免线上静默故障。

### 7.3 测试策略（必须先有单测的纯函数清单）

> 优先级：M0/M1 的纯函数必须**先有单测再实现**（TDD），否则 loop 行为不可证伪。

| 函数 | 文件 | 测试用例 |
| --- | --- | --- |
| `sdk-guard.detectPiPrivateFields(session)` | `lib/engine/sdk-guard.ts` | ① 全部字段存在→无告警；② 缺 `_baseSystemPrompt`→告警 + 设 env；③ 缺 `_toolRegistry`→告警 |
| `streamFn` 事件归一化 `normalizeStreamEvent(e)` | `lib/engine/deer-loop.ts` | ① `start`→noop；② `partial`→透传；③ `done`→收尾；④ `error`→带 errorMessage |
| `ToolRegistry.register/unregister/setActive` | `lib/engine/tool-registry.ts` | ① 同名覆盖；② 白名单过滤未知工具；③ unregister 后 getAllTools 不含 |
| `ToolExecutor.runParallel(calls, mode)` | `lib/engine/tool-executor.ts` | ① 全成功按完成序；② 一个 throw 其余继续；③ abort 全部取消 |
| `ToolExecutor.runSequential(calls)` | 同上 | ① 严格串行；② 中途 abort 后续不执行 |
| `RetryPolicy.computeDelay(attempt, base, max)` | `lib/engine/retry.ts` | ① 指数退避；② 不超 maxDelay；③ base<5000 时 clamp 到 5000 |
| `isRetryablePrematureStream(err, contentLen)` | 同上 | ① 完整消息+connection lost→false；② 空消息+500→true |
| `stripTurnContextBlock(prompt)` | `lib/engine/system-prompt.ts` | ① 有块→去除；② 无块→原样；③ 多块全去 |
| `queueDrain(messages, mode)` | `lib/engine/queues.ts` | ① `all`→全注入；② `one-at-a-time`→只最老一条 |

**集成测试**（M2 后）：
- `e2e-loop.test.ts`：mock streamFn + mock 工具，跑一个「read→edit→done」完整 loop，断言事件序列快照。
- `e2e-abort.test.ts`：中途 abort，断言资源释放。
- `e2e-retry.test.ts`：stream 前两次 500 第三次成功，断言重试事件。

**回归测试**：M0 完成后，录制一组「pi 实现下」的端到端事件流快照（发固定 prompt），每个里程碑后用 DeerLoopEngine 跑同样 prompt，diff 事件序列。**事件序列不一致 = 行为回归**。

---

## 附录 A：关键文件速查

| 文件 | 行数 | 角色 |
| --- | --- | --- |
| `lib/rpc-manager.ts` | 1625 | AgentSessionWrapper + 全部 hack + session 注册表 |
| `lib/deerhux-types.ts` | 50 | `AgentSessionLike` 接口（DeerHux 对 AgentSession 的最小契约） |
| `lib/agent-runtime/event-store.ts` | 110 | `EventStore`（SSE 回放，seq 编号） |
| `lib/agent-runtime/types.ts` | 18 | `SequencedAgentEvent` |
| `lib/types.ts` | 200 | DeerHux 镜像的 session/message 类型 |
| `lib/parallel-agent/subagent-runner.ts` | 170 | worker session（复用 startRpcSession） |
| `lib/parallel-agent/subagent-tool.ts` | 160 | spawn_subagent 工具（defineTool） |
| `lib/parallel-agent/collaboration-orchestrator.ts` | 320 | 子 agent 编排 |
| `hooks/useAgentSession.ts` | 2200 | 前端消费 loop 事件（上帝 hook） |
| `lib/session-reader.ts` | 540 | jsonl 读取 + buildSessionContext |

## 附录 B：pi 关键类型定义文件位置

| 类型 | 文件（主仓库 node_modules） |
| --- | --- |
| `Agent`（loop 引擎） | `~/.bun/install/cache/@earendil-works/pi-agent-core/0.75.5@@@1/dist/agent.d.ts` |
| `AgentEvent/AgentTool/AgentLoopConfig/ToolExecutionMode` | 同上 `dist/types.d.ts` |
| `agentLoop/runAgentLoop`（低层 loop 函数） | 同上 `dist/agent-loop.d.ts` |
| `AgentSession`（60+ 方法） | `pi-coding-agent/dist/core/agent-session.d.ts` |
| `createAgentSession/CreateAgentSessionOptions` | `pi-coding-agent/dist/core/sdk.d.ts` |
| `ToolDefinition`（extensions） | `pi-coding-agent/dist/core/extensions/types.d.ts:328` |
| `SessionManager` | `pi-coding-agent/dist/core/session-manager.d.ts` |
| `SettingsManager.getRetrySettings` | `pi-coding-agent/dist/core/settings-manager.d.ts:192` |
| `streamSimple/Context/Model/Transport` | `pi-ai/dist/stream.d.ts` + `types.d.ts` |

---

**文档结束。** 核心设计决策见下方汇报。
