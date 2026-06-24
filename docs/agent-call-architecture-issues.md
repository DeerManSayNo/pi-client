# DeerHux Agent 调用架构问题清单

> 调研范围：当前项目的 Agent 调用链路、DeerLoopEngine、自研 ToolExecutor、Subagent 编排、Session 持久化与事件契约。  
> 结论：项目已经从 `pi-coding-agent` 的 `AgentSession` 逐步迁移到自研 `DeerLoopEngine`，方向正确；但当前仍处在“自研 loop + 旧 wrapper/旧 pi 接口形状 + subagent 多层编排”的过渡态，主要问题集中在边界泄漏、session 身份、工具执行顺序、subagent 并发放大、事件契约和持久化一致性上。

---

## 1. 总体架构现状

当前主调用链路大致如下：

```txt
startRpcSession()
  → startDeerLoopSession()
    → new DeerLoopEngine(...)
    → new AgentSessionWrapper(engine)
      → wrapper.send({ type: "prompt" })
        → wrapper.commitAndTrackPromptTurn()
          → engine.prompt()
            → pi-ai streamSimple()
            → ToolExecutor.executeBatch()
              → coding tools / codegraph / MCP / subagent
```

Subagent 调用链路：

```txt
主 Agent 调用 subagent 工具
  → startCollaborationRun()
    → planSubagentTaskWithLlm()
    → executeCollaborationRun()
      → createSubagentWorkerSession()
        → startRpcSession()
          → DeerLoopEngine worker session
```

---

## 2. 核心问题清单

## P0-1：AgentEnginePort 边界没有真正收敛

### 问题描述

`AgentEnginePort` 继承了 `AgentSessionLike`：

```ts
export interface AgentEnginePort extends AgentSessionLike {
  setSystemPromptPersistent(prompt: string): void;
  applyToolExecutionModes(): void;
  installRetryHardening(): void;
  replaceCustomTools(...): void;
}
```

相关文件：

- `lib/engine/port.ts`
- `lib/deerhux-types.ts`

`AgentSessionLike` 仍然暴露大量 pi-coding-agent 风格字段：

- `sessionManager`
- `settingsManager`
- `modelRegistry`
- `agent.state`
- `navigateTree`
- `compact`
- `setThinkingLevel`
- `steer`
- `followUp`

这导致 `DeerLoopEngine` 虽然已经是自研 loop，但还必须伪装成旧的 `AgentSession`。

### 影响

当前架构不是：

```txt
业务层 → 稳定 AgentEnginePort → DeerLoopEngine
```

而是：

```txt
业务层 / AgentSessionWrapper
  → 仍然按照 pi AgentSession 形状调用
    → DeerLoopEngine 被迫兼容旧形状
```

后果：

1. 自研 loop 边界不干净。
2. wrapper 继续依赖 `agent.state.systemPrompt` 这类过渡字段。
3. 后续替换 session、compact、model registry 时容易继续打补丁。
4. 架构上还没有完成从 pi SDK 形状到 DeerHux 自有协议的收口。

### 建议

拆分 `AgentEnginePort`：

```txt
AgentRuntimePort
SessionPort
ModelPort
ToolPort
CompactionPort
QueuePort
```

不要继续让 `DeerLoopEngine` 直接伪装成 `AgentSessionLike`。

---

## P0-2：DeerLoopEngine.sessionFile 始终返回 undefined

### 问题描述

`DeerLoopEngine` 当前实现：

```ts
get sessionFile(): string | undefined {
  return undefined;
}
```

相关文件：

- `lib/engine/deer-loop.ts`

但外层逻辑依赖 `sessionFile`：

```ts
get sessionFile(): string {
  return this.inner.sessionFile ?? "";
}
```

以及 fork 逻辑：

```ts
const currentSessionFile = this.inner.sessionFile;
if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
```

相关文件：

- `lib/rpc-manager.ts`

实际上 `startDeerLoopSession()` 已经创建了真实 `SessionManager`：

```ts
const sessionManager = sessionFile
  ? SessionManager.open(sessionFile, undefined)
  : SessionManager.create(cwd, undefined);
```

但 `DeerLoopEngine.sessionFile` 没有透传 `sessionManager.getSessionFile()`。

### 影响

1. `fork` 可能失败。
2. `get_state` 返回空 sessionFile。
3. session 文件路径相关能力不稳定。
4. 架构状态不一致：底层已经持久化，但 Port 对外不承认 sessionFile。

### 建议

将：

```ts
get sessionFile(): string | undefined {
  return undefined;
}
```

改为透传：

```ts
get sessionFile(): string | undefined {
  return this._sessionManager?.getSessionFile?.() ?? undefined;
}
```

---

## P0-3：sessionId / realSessionId / tempKey 身份体系不统一

### 问题描述

`startRpcSession()` 先按传入的 `sessionId` 查 registry：

```ts
const existing = registry.get(sessionId);
if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };
```

但创建成功后注册的是 `realSessionId`：

```ts
getRegistry().set(realSessionId, wrapper);
```

而 `realSessionId` 来自：

```ts
const realSessionId = sessionManager.getSessionId();
```

相关文件：

- `lib/rpc-manager.ts`

subagent worker 又有临时 key：

```ts
const tempKey = existingSessionId ?? `__collab__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

相关文件：

- `lib/parallel-agent/subagent-runner.ts`

### 影响

如果调用方传入的是临时 id，而真实 session id 是另一个值，可能出现：

```txt
第一次调用：registry 查 tempId，未命中 → 创建 realId → registry 存 realId
第二次调用：registry 查 tempId，仍未命中 → 再次创建
```

可能导致：

1. 重复创建 session。
2. sidebar 出现重复会话。
3. subagent worker session 标记不稳定。
4. continue worker 时找不到对应 session。
5. EventStore、SessionReader、SubagentRegistry 之间 id 不一致。

### 建议

明确区分：

```txt
requestedSessionKey  调用方传入的临时 key
realSessionId        SessionManager 真实 session id
sessionFile          jsonl 文件路径
parentSessionId      父会话 id
workerSessionId      子 Agent 会话 id
```

可选方案：

1. registry 同时维护 alias：

```ts
registry.set(requestedSessionKey, wrapper);
registry.set(realSessionId, wrapper);
```

2. 或入口阶段立刻 resolve 成 realSessionId，后续全链路只使用 realSessionId。

---

## P1-1：默认工具激活逻辑中 subagent 可能未激活

### 问题描述

`subagent` 工具被注册：

```ts
const subagentTool = allowSubagentTool ? createSubagentTool(...) : null;
```

并加入 `customTools`：

```ts
...(subagentTool ? [subagentTool] : []),
```

但 `availableToolNames` 没有包含 `SUBAGENT_TOOL_NAME`：

```ts
const availableToolNames = [
  ...allCodingToolNames,
  ...(codeSearchTool ? ["code_search"] : []),
  ...codeGraphTools.map(t => t.name),
  ...(mcpRuntime?.toolNames ?? []),
];
```

只有显式传 `toolNames` 或 agent mode 时，才会补进去：

```ts
if (allowSubagentTool && activeToolNames.length > 0 && !activeToolNames.includes(SUBAGENT_TOOL_NAME)) {
  activeToolNames.push(SUBAGENT_TOOL_NAME);
}
```

相关文件：

- `lib/rpc-manager.ts`
- `lib/parallel-agent/subagent-tool.ts`

### 影响

会出现：

```txt
subagent 工具已注册
但默认 active tools 不包含 subagent
```

导致主 Agent 可能看不到 subagent 工具。

### 建议

如果产品预期默认允许 subagent，则 `availableToolNames` 应包含：

```ts
...(subagentTool ? [SUBAGENT_TOOL_NAME] : [])
```

如果产品预期默认不允许，则需要在 UI 和系统 prompt 中明确说明 subagent 是可切换工具。

---

## P1-2：ToolExecutor 改变了 LLM toolCall 的源序

### 问题描述

当前 `ToolExecutor` 逻辑：

```txt
sequential 组先执行
parallel 组后执行
```

相关文件：

- `lib/engine/tool-executor.ts`

代码注释中明确写了：

```txt
sequential 组先全跑完，再跑 parallel 组
```

### 风险示例

如果 LLM 同一轮发出：

```txt
1. read fileA
2. edit fileA
```

按当前策略：

```txt
edit fileA 先执行
read fileA 后执行
```

因为：

- `read` 是 parallel
- `edit` 是 sequential

### 影响

1. 工具副作用顺序可能和 LLM 预期不一致。
2. `read/edit/write/bash` 混合时可能产生竞态。
3. LLM 看到的 toolResult 顺序虽然被恢复为源序，但实际副作用已经乱序。
4. 对文件修改类任务风险较高。

### 建议

改成按源序分段执行：

```txt
parallel segment 并发
sequential tool 单独执行
parallel segment 并发
sequential tool 单独执行
```

示例：

```txt
read A
grep B
edit C
read D
write E
```

执行应为：

```txt
[read A, grep B] 并发
edit C 串行
read D 并发
write E 串行
```

---

## P1-3：subagent 工具本身是 parallel，存在并发放大风险

### 问题描述

`subagent` 工具定义：

```ts
executionMode: "parallel" as const
```

相关文件：

- `lib/parallel-agent/subagent-tool.ts`

如果 LLM 在同一轮生成多个 subagent toolCall，`ToolExecutor` 会并发执行多个 subagent run。

每个 subagent run 内部又可能：

```ts
await Promise.all(current.workers.map(...));
```

相关文件：

- `lib/parallel-agent/collaboration-orchestrator.ts`

### 并发放大结构

```txt
1 个主 Agent turn
  → N 个 subagent toolCall 并发
    → 每个 subagent run 里 M 个 worker 并发
      → 每个 worker 一个 AgentSession
        → 每个 AgentSession 多轮 LLM 调用
```

### 影响

1. LLM 请求数瞬间放大。
2. API 成本不可控。
3. worker session 暴增。
4. worktree 暴增。
5. 事件流暴增。
6. 主 Agent 等待时间不可控。
7. 本地资源、文件句柄、进程数量可能过高。

### 建议

至少增加四层限制：

```txt
单个主 turn 最大 subagent toolCall 数
单个 subagent run 最大 worker 数
全局 subagent worker 并发数
单项目 subagent worker 并发数
```

并在超限时返回明确工具错误，而不是继续创建。

---

## P1-4：subagent workers 缺少用户输入侧数量上限

### 问题描述

LLM planner 内部有 worker 数量限制：

```ts
if (workers.length >= 10) break;
```

相关文件：

- `lib/parallel-agent/llm-planner.ts`

但用户或主 Agent 直接传入 `params.workers` 时，`subagent-tool.ts` 只是过滤空值，没有限制数量：

```ts
const workers = Array.isArray(params.workers)
  ? params.workers
      .map(...)
      .filter(...)
  : undefined;
```

相关文件：

- `lib/parallel-agent/subagent-tool.ts`

### 影响

主 Agent 可以构造大量 workers，绕过 planner 的数量限制。

### 建议

在 `subagent-tool.ts` 增加硬限制：

```ts
const MAX_WORKERS_PER_RUN = 5;
```

或更保守：

```txt
ask/review: 3
parallel: 3
code: 1~3
```

---

## P1-5：subagent 终态清理和 continue worker 语义存在隐性依赖

### 问题描述

run 终态后会销毁 worker sessions：

```ts
for (const session of workerSessions) {
  try { session.destroy(); } catch { /* best effort */ }
}
```

但后续又支持：

```ts
continueCollaborationWorker(...)
```

它依赖：

```ts
if (!worker.sessionId) throw new Error("Worker session is not available yet");
```

然后尝试 reopen：

```ts
createSubagentWorkerSession(workerCwd, state.mode, worker.sessionId, ...)
```

相关文件：

- `lib/parallel-agent/collaboration-orchestrator.ts`
- `lib/parallel-agent/subagent-runner.ts`

### 影响

这个设计依赖几个条件同时成立：

1. worker.sessionId 必须是真实 session id。
2. sessionFile cache 必须可解析。
3. jsonl 文件不能提前被删除。
4. isolated worktree 在 continue 时仍然存在。
5. subagent registry 记录必须一致。

任一条件失败，continue worker 都会失败。

### 建议

把 worker session 生命周期显式化：

```txt
running
complete_memory_destroyed
reopenable_from_jsonl
expired
deleted
```

并在 UI/API 层明确返回：

```ts
canContinue: boolean;
continueUnavailableReason?: string;
```

---

## P1-6：事件契约仍然混用旧 schema 猜测逻辑

### 问题描述

`rpc-manager.ts` 为了识别文件变更，从多个字段猜路径：

```txt
filePath
path
file_path
args.file_path
args.path
input.file_path
input.path
result.filePath
result.path
result.file_path
```

相关文件：

- `lib/rpc-manager.ts`

但 `ToolExecutor` 已经支持标准化字段：

```ts
changedFiles?: string[];
```

并在 `tool_execution_end` 发出：

```ts
changedFiles: output.changedFiles
```

相关文件：

- `lib/engine/tool-executor.ts`

### 影响

1. 新 loop 已经有明确契约，但 wrapper 仍按旧字段猜测。
2. 多文件变更只能识别一个。
3. `agent_file_changed` 可能漏报。
4. 事件 schema 不清晰，前端和后端容易继续兼容历史字段。

### 建议

`agent_file_changed` 应优先消费：

```ts
event.changedFiles: string[]
```

并为每个文件发一个事件：

```ts
for (const filePath of changedFiles) {
  emit agent_file_changed;
}
```

旧字段猜测逻辑只作为 fallback。

---

## P1-7：modelRegistry 是空代理，set_model 依赖 wrapper fallback

### 问题描述

`DeerLoopEngine` 当前：

```ts
get modelRegistry() {
  return {
    find: () => undefined,
  };
}
```

相关文件：

- `lib/engine/deer-loop.ts`

`AgentSessionWrapper` 设置模型时先查：

```ts
const registry = this.inner.modelRegistry;
let model = registry.find(provider, modelId);
```

查不到再 fallback：

```ts
model = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
```

相关文件：

- `lib/rpc-manager.ts`

### 影响

功能上能跑，但架构语义不干净：

```txt
Engine Port 声称提供 modelRegistry
但实际不可用
Wrapper 自己兜底创建 registry
```

### 建议

二选一：

1. `DeerLoopEngine` 构造时注入真实 `modelRegistry`。
2. 从 `AgentEnginePort` 删除 `modelRegistry`，改成 wrapper 通过单独 `ModelService` 处理模型切换。

---

## P2-1：ToolResultMessage 没有回填 details

### 问题描述

工具执行结果里有：

```ts
result.details
```

但构造 `ToolResultMessage` 时只传：

```txt
role
toolCallId
toolName
content
isError
timestamp
```

相关文件：

- `lib/engine/deer-loop.ts`

### 影响

如果工具把结构化结果放在 `details` 中，下一轮 LLM 无法看到。

目前很多工具把主要内容放在 `content`，所以不是最高优先级，但这是契约损耗。

### 建议

构造 toolResult 时补上：

```ts
details: output?.result?.details
```

---

## P2-2：DeerLoopEngine 文件头注释和实际能力不一致

### 问题描述

文件头仍然写：

```txt
M1 不做：工具调用循环、工具注册、重试、steering/followUp 队列、session 持久化、压缩。
```

相关文件：

- `lib/engine/deer-loop.ts`

但当前实际已经实现：

- 工具调用循环
- 工具注册
- 自动重试
- steering/followUp 队列
- session 持久化
- compact

### 影响

1. 误导维护者。
2. 误导架构审查。
3. 增加后续迁移和排障成本。

### 建议

更新文件头注释，明确当前已实现能力和仍未完成能力。

---

## 3. 风险分级汇总

| 优先级 | 问题 | 主要影响 |
|---|---|---|
| P0 | AgentEnginePort 继承旧 AgentSessionLike | 自研 loop 边界不清，长期维护成本高 |
| P0 | sessionFile 返回 undefined | fork、get_state、continue worker 不稳定 |
| P0 | session identity 不统一 | 重复 session、sidebar 泄漏、worker 续跑失败 |
| P1 | subagent 默认未激活 | Agent 可能看不到 subagent 工具 |
| P1 | ToolExecutor 改变源序 | read/edit/write 时序错误 |
| P1 | subagent parallel 嵌套 parallel | 并发、成本、资源不可控 |
| P1 | workers 无硬上限 | 可绕过 planner 限制 |
| P1 | continue worker 依赖隐式 session 生命周期 | 终态后续跑不稳定 |
| P1 | changedFiles 没收敛 | 文件变更事件漏报 |
| P1 | modelRegistry 空代理 | set_model 边界不清 |
| P2 | ToolResultMessage 丢 details | 工具结构化结果损耗 |
| P2 | 注释过期 | 维护成本增加 |

---

## 4. 建议修复顺序

## 第一阶段：快速修稳定性问题

### 1. 修复 `DeerLoopEngine.sessionFile`

目标：

```txt
DeerLoopEngine.sessionFile === SessionManager.getSessionFile()
```

涉及文件：

- `lib/engine/deer-loop.ts`

---

### 2. 修复 changedFiles 事件消费

目标：

```txt
tool_execution_end.changedFiles[]
  → agent_file_changed × N
```

涉及文件：

- `lib/rpc-manager.ts`
- `lib/engine/tool-executor.ts`
- `lib/engine/loop-event.ts`

---

### 3. 限制 subagent workers 数量

目标：

```ts
MAX_WORKERS_PER_RUN = 3 或 5
```

涉及文件：

- `lib/parallel-agent/subagent-tool.ts`
- `lib/parallel-agent/llm-planner.ts`

---

## 第二阶段：修执行语义问题

### 4. 调整 ToolExecutor 执行顺序

目标：

```txt
按源序执行，parallel 只在连续无副作用段内并发
```

涉及文件：

- `lib/engine/tool-executor.ts`

---

### 5. 控制 subagent fan-out

目标：

```txt
单 turn 最大 subagent run 数
单 run 最大 worker 数
全局 worker 并发池
```

涉及文件：

- `lib/parallel-agent/subagent-tool.ts`
- `lib/parallel-agent/collaboration-orchestrator.ts`
- `lib/llm-gateway`

---

## 第三阶段：收敛架构边界

### 6. 统一 session identity

目标：

```txt
requestedSessionKey → realSessionId → sessionFile
```

涉及文件：

- `lib/rpc-manager.ts`
- `lib/session-reader.ts`
- `lib/parallel-agent/subagent-runner.ts`
- `lib/parallel-agent/subagent-registry.ts`

---

### 7. 重构 AgentEnginePort

目标：

```txt
去掉对 AgentSessionLike 的继承
拆分成 DeerHux 自有 Port
```

涉及文件：

- `lib/engine/port.ts`
- `lib/deerhux-types.ts`
- `lib/rpc-manager.ts`
- `lib/engine/deer-loop.ts`

---

## 5. 推荐目标架构

当前：

```txt
AgentSessionWrapper
  → AgentEnginePort extends AgentSessionLike
    → DeerLoopEngine 模拟 pi AgentSession
```

建议演进为：

```txt
AgentSessionWrapper
  → AgentRuntimePort
  → SessionStorePort
  → ToolRegistryPort
  → ModelService
  → CompactionService
  → SubagentOrchestrator
```

其中：

```txt
DeerLoopEngine 只负责：
- prompt loop
- LLM stream
- tool call loop
- retry
- abort
- queue
- event emit
```

不应该继续承担：

```txt
- 伪造 pi AgentSession
- 伪造 modelRegistry
- 伪造 settingsManager
- 伪造 sessionManager
```

---

## 6. 总结

当前项目的 Agent 调用架构已经完成了最关键的一步：

> 自研 `DeerLoopEngine` 已经接管主 Agent loop。

但目前最大问题是：

```txt
执行核心已经自研，
调用边界仍然像 pi AgentSession，
subagent 又在这个过渡边界上做多层 fan-out。
```

因此短期应优先修：

1. `sessionFile` 透传。
2. session identity 统一。
3. ToolExecutor 源序执行。
4. subagent 并发上限。
5. changedFiles 事件契约收敛。

中长期应推进：

```txt
AgentEnginePort 去 pi 化
SessionStore 独立化
ModelService 独立化
SubagentOrchestrator 限流化
事件协议显式化
```
