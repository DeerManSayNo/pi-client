# DeerHux 并发搜索与编辑改造方案

> 基于当前 `DeerHux` Web 项目与 `@earendil-works/pi-coding-agent` SDK 的可落地方案。
>
> 并行化分四个阶段推进：代码索引 → SDK 只读并行 → 只读并行 Agent → 隔离编辑 Agent。每个阶段独立可交付。

> ## ⚠️ 文档状态：部分已过时（2026-06 更新）
>
> 本提案的 Phase 3（只读并行 Agent）与 Phase 4（隔离编辑 Agent）所描述的独立 orchestrator 架构（`orchestrator.ts` / `isolated-orchestrator.ts` / `parallel-runs` / `isolated-runs`）已在后续重构中删除。
>
> **当前实际实现**为 collaboration 模式（多 worker 在共享 worktree 中协作），见 `lib/parallel-agent/collaboration-orchestrator.ts` 与 `app/api/agent-runs/`。Phase 1（代码索引）与 Phase 2（SDK 只读工具并行）仍有效。
>
> 下文保留原始设计内容作为历史参考。

---

## 目录

- [当前架构](#当前架构)
- [目标架构](#目标架构)
- [Phase 1：代码索引 MVP + code_search](#phase-1代码索引-mvp--code_search)
- [Phase 2：SDK 只读工具并行](#phase-2sdk-只读工具并行)
- [Phase 3：只读并行 Agent](#phase-3只读并行-agent)
- [Phase 4：隔离编辑 Agent](#phase-4隔离编辑-agent)
- [实施路线图](#实施路线图)
- [风险与对策](#风险与对策)

---

## 当前架构

```txt
Browser ── POST /api/agent/[id] ──▶ Next.js API
                                        │
                                        ▼
                               AgentSessionWrapper (lib/rpc-manager.ts)
                                        │
                                        ▼
                          @earendil-works/pi-coding-agent SDK
                               createAgentSession()
                               AgentSession.prompt()
                                        │
                                        ▼
                               LLM 推理 + SDK 内部工具执行
```

**Web 层职责**：创建 / 复用 `AgentSessionWrapper`，转发命令到 SDK，通过 `subscribe()` 接收 SSE 事件推给浏览器，维护 session registry。Web 层不执行任何工具，`tool_execution_start` / `tool_execution_end` 是通知事件，不是执行请求。

**SDK 能力**：`createAgentSession` 接受 `customTools?: ToolDefinition[]`，可注入自定义工具。`ToolDefinition` 已内置 `executionMode?: "sequential" | "parallel"` 字段，只读工具可标记为并行执行。

**关键文件**：

```txt
lib/rpc-manager.ts                    AgentSessionWrapper + registry + startRpcSession
app/api/agent/[id]/route.ts           命令转发
app/api/agent/[id]/events/route.ts    SSE 流
app/api/agent/new/route.ts            新建会话
components/ChatWindow.tsx             消息渲染 + 流式处理
components/ToolPanel.tsx              工具预设
```

---

## 目标架构

### Phase 1-2：索引 + 并行工具

```txt
Browser
  │
  ▼
Next.js API
  ├─ /api/agent/*          现有 agent API
  ├─ /api/index/*           新增：索引管理 + 搜索 API
  │
  ▼
AgentSessionWrapper
  │
  ▼
createAgentSession({
  tools: [...builtInTools, "code_search"],
  customTools: [codeSearchTool]       // executionMode: "parallel"
})
  │
  ▼
SDK 内部执行
  ├─ read(A)  ──┐
  ├─ read(B)  ──┤ 并行（executionMode: parallel）
  ├─ grep(C)  ──┤
  └─ edit(D)  ─── 串行（executionMode: sequential）
```

### Phase 3-4：并行 Agent

```txt
Parallel Orchestrator
  ├─ Worker Session 1 (只读)   独立 AgentSession
  ├─ Worker Session 2 (只读)   独立 AgentSession
  ├─ Worker Session 3 (只读)   独立 AgentSession
  └─ Aggregator                汇总结果

Phase 4 额外：
  Git Worktree / Temp Dir
  ├─ worker-1/    独立工作目录
  ├─ worker-2/    独立工作目录
  └─ diff review + apply patch
```

---

## Phase 1：代码索引 MVP + code_search

### 目标

构建代码索引，通过 `code_search` 工具让 agent 一次调用完成搜索，减少反复 `find` / `grep` / `read` 的轮次。独立于 SDK，Web 层可单独交付。

### 索引存储

```txt
~/.deerhux/agent/indexes/<cwd-hash>.sqlite
```

不放项目目录内，避免污染用户仓库。`cwd-hash` 用 `crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12)` 生成。

### 索引内容

| 字段 | 说明 |
|---|---|
| `path` | 相对于 cwd 的文件路径 |
| `mtime` | 文件修改时间 |
| `size` | 文件大小 |
| `hash` | 内容 hash（用于增量刷新） |
| `content` | FTS5 全文索引的文件内容 |

**扫描规则**：排除 `node_modules`、`.git`、`.next`、`dist`、`build`、`__pycache__`、lockfile、二进制文件、大于 512KB 的文件。支持 `.gitignore` 规则。

**增量刷新**：比较 `mtime` + `size` + `hash`，只重建变化的文件。

### 新增文件

```txt
lib/code-index/
  config.ts       // 索引路径、忽略规则、大小限制常量
  paths.ts        // cwd → sqlite 路径映射
  scanner.ts      // 文件扫描 + 忽略规则
  database.ts     // SQLite schema + FTS5 + CRUD 操作
  indexer.ts       // 全量 / 增量索引逻辑
  search.ts       // 搜索接口
```

### 新增 API

```txt
GET  /api/index/status?cwd=...          索引状态（是否存在、文件数、最后刷新时间）
POST /api/index/refresh                 { cwd } 触发索引构建 / 增量刷新
POST /api/index/search                  { cwd, query, path?, limit? } 搜索
```

**搜索请求**：

```json
{ "cwd": "/path/to/project", "query": "SessionManager fork", "limit": 20 }
```

**搜索响应**：

```json
{
  "results": [
    {
      "path": "lib/rpc-manager.ts",
      "startLine": 280,
      "endLine": 330,
      "score": 0.82,
      "snippet": "case \"fork\": { ... }"
    }
  ]
}
```

### 注册 `code_search` 工具

在 `startRpcSession` 中，当索引存在时自动注入 `code_search` custom tool：

```ts
// lib/rpc-manager.ts — startRpcSession 中
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchIndex } from "./code-index/search";

const codeSearchTool = defineTool({
  name: "code_search",
  label: "Code Search",
  description: "Search the codebase using a pre-built index. Returns file paths, line ranges, and code snippets.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query (keywords)" }),
    path: Type.Optional(Type.String({ description: "Restrict to files under this path" })),
    limit: Type.Optional(Type.Number({ description: "Max results, default 20" })),
  }),
  executionMode: "parallel",  // 只读，可与其他只读工具并行
  execute: async (_toolCallId, params, signal) => {
    const results = await searchIndex(cwd, params.query, {
      path: params.path,
      limit: params.limit ?? 20,
      signal,
    });
    return {
      type: "text" as const,
      text: results.map(r => `${r.path}:${r.startLine}-${r.endLine}\n${r.snippet}`).join("\n\n"),
    };
  },
});

const { session: inner } = await createAgentSession({
  cwd,
  agentDir,
  sessionManager,
  tools: [...allCodingToolNames, "code_search"],
  customTools: [codeSearchTool],
  ...(toolsOption !== undefined ? { tools: toolsOption.concat("code_search") } : {}),
});
```

### 工具预设适配

```ts
// components/ToolPanel.tsx
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls", "code_search"];
```

`PRESET_DEFAULT` 保持不变（不含 `code_search`），`PRESET_FULL` 加入。`getPresetFromTools()` 的匹配逻辑同步更新。

### 验收标准

- [ ] 能对当前项目建立索引，不污染项目目录
- [ ] 能搜索 `SessionManager`、`fork`、`model config` 等关键词，返回 path + line range + snippet
- [ ] 增量刷新：只修改一个文件后 rebuild 该文件
- [ ] agent 在新 session 中可调用 `code_search` 工具
- [ ] `code_search` 结果精简，不污染上下文

---

## Phase 2：SDK 只读工具并行

### 目标

让 LLM 一次返回多个只读工具调用时，SDK 并行执行。

**前置验证**：先确认 SDK 内置工具（`read`、`grep`、`find`、`ls`）的 `executionMode` 设置。

```bash
grep -R "executionMode" node_modules/@earendil-works/pi-coding-agent/dist/core/tools/
```

**三种可能结果**：

| 结果 | 行动 |
|---|---|
| 内置只读工具已标记 `parallel` | 只做集成测试 + UI 验证 |
| 内置工具未标记，但 SDK 执行循环支持 | 给内置工具补充 `executionMode` 标记 |
| SDK 执行循环不支持并行分组 | 需要在 core 层实现分组执行逻辑 |

### 工具分类

```ts
const TOOL_CHARACTERISTICS = {
  // 只读，并行
  read:        { readOnly: true,  parallel: true },
  grep:        { readOnly: true,  parallel: true },
  find:        { readOnly: true,  parallel: true },
  ls:          { readOnly: true,  parallel: true },
  code_search: { readOnly: true,  parallel: true },

  // 有副作用，串行
  bash:        { readOnly: false, parallel: false },
  edit:        { readOnly: false, parallel: false },
  write:       { readOnly: false, parallel: false },
};
```

`bash` 不做简单的"只读判断"（`grep foo file && rm -rf tmp` 之类的组合无法安全检测），默认串行。

### 执行规则

1. 同一 assistant message 中的多个 toolCall 按 `executionMode` 分组
2. 连续只读工具并行执行
3. 遇到 `edit` / `write` / `bash` 时切断并发组，串行执行
4. tool result 写入 session 时保持原始 toolCall 顺序
5. 所有并行任务共享同一个 abort signal
6. 并发数可配置，默认 4

### Web 层配合

当前 `AgentSessionWrapper` 已经按 `toolCallId` 跟踪 pending tool events：

```ts
// rpc-manager.ts
private pendingToolEvents = new Map<string, AgentEvent>();
```

SDK 并行执行时会发出多个 `tool_execution_start` / `tool_execution_end` 事件（各自带不同的 `toolCallId`），Web 层无需改动即可接收和转发。

**UI 层面**：`ChatWindow.tsx` 中的 `MessageView` 已经按 `toolCallId` 渲染工具调用状态，并行工具会自然地同时显示为 `running`。需要验证 UI 在多个工具同时 running 时的视觉效果，可能需要微调样式。

### 验收标准

- [ ] 多个 `read` / `grep` / `find` 能并行执行，总耗时接近最慢单个工具
- [ ] `edit` / `write` / `bash` 仍然串行
- [ ] session jsonl 中 toolResult 顺序与 toolCall 顺序一致
- [ ] abort 能取消所有并行中的工具
- [ ] Web SSE 正确显示多个同时 pending 的工具
- [ ] 配置开关可禁用并行（回退到全串行）

---

## Phase 3：只读并行 Agent

### 目标

多个 worker agent 并行分析不同子任务，由 orchestrator 汇总结果。适合大型项目分析、多模块调查、并行 code review。

### 适用场景

- ✅ 分析大型项目架构（拆模块并行调查）
- ✅ 同时调查多个代码路径
- ✅ 并行生成候选方案
- ✅ 多维度 code review

### 不适用场景

- ❌ 多 worker 同时编辑同一工作区（Phase 4 解决）

### Worker Session 管理

每个 worker 必须是独立 session，不能复用 `AgentSessionWrapper`。

原因：`AgentSessionWrapper` 是 one-per-session-id 设计，`globalThis.__deerhuxSessions` 维护长生命周期 wrapper。多 worker 共用会破坏状态和事件流。

```ts
// lib/parallel-agent/worker-session.ts
async function createWorkerSession(cwd: string, task: string): Promise<WorkerHandle> {
  const sessionManager = SessionManager.create(cwd);
  const { session: inner } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    tools: ["read", "grep", "find", "ls", "code_search"],  // 只读工具
    // 不含 edit / write / bash
  });

  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  registry.set(inner.sessionId, wrapper);

  return {
    sessionId: inner.sessionId,
    prompt: (msg: string) => wrapper.send({ type: "prompt", message: msg }),
    onEvent: (listener: (event: AgentEvent) => void) => wrapper.onEvent(listener),
    destroy: () => wrapper.destroy(),
  };
}
```

### Orchestrator

```ts
// lib/parallel-agent/orchestrator.ts
interface ParallelRun {
  runId: string;
  cwd: string;
  workers: WorkerHandle[];
  status: "running" | "complete" | "aborted";
  results: Map<string, string>;
}

async function startParallelRun(config: {
  cwd: string;
  message: string;
  workers: Array<{ name: string; task: string }>;
}): Promise<ParallelRun> {
  const runId = generateId();
  const handles = await Promise.all(
    config.workers.map(w => createWorkerSession(config.cwd, w.task))
  );

  // 启动所有 worker
  const results = new Map<string, string>();
  await Promise.all(handles.map(async (h, i) => {
    const workerName = config.workers[i].name;
    const taskPrompt = `你的任务是：${config.workers[i].task}\n\n用户问题：${config.message}`;
    await h.prompt(taskPrompt);
    // 等待完成，收集最终 assistant 消息作为结果
    // ...
    results.set(workerName, collectedResult);
  }));

  // 所有 worker 完成后，销毁 session
  handles.forEach(h => h.destroy());

  return { runId, cwd: config.cwd, workers: handles, status: "complete", results };
}
```

### API

```txt
POST /api/parallel-runs                     创建并启动
GET  /api/parallel-runs/[runId]             查询状态
GET  /api/parallel-runs/[runId]/events      SSE 事件流
POST /api/parallel-runs/[runId]/abort       中止全部 worker
```

**创建请求**：

```json
{
  "cwd": "/path/to/project",
  "message": "分析 session、model config、file explorer 三块架构",
  "workers": [
    { "name": "session", "task": "分析 session 读取、分支和 fork 逻辑" },
    { "name": "model", "task": "分析模型配置和默认模型逻辑" },
    { "name": "files", "task": "分析文件浏览和文件查看逻辑" }
  ]
}
```

**事件流**：

```json
{ "type": "worker_start", "runId": "...", "workerId": "session" }
{ "type": "worker_event", "runId": "...", "workerId": "session", "event": { "type": "message_update" } }
{ "type": "worker_complete", "runId": "...", "workerId": "session", "result": "..." }
{ "type": "run_complete", "runId": "...", "summary": "..." }
```

### UI

轻量 UI 起步：

- Chat 中显示一个 "Parallel Run" 消息块
- 展示 worker 列表和各自状态（running / complete / error）
- 每个 worker 可展开查看日志
- 完成后显示汇总结果
- Abort 按钮

后续迭代再做多流并行 UI。

### 新增文件

```txt
lib/parallel-agent/
  orchestrator.ts       并行调度 + 汇总
  worker-session.ts     worker session 创建 / 销毁
  run-store.ts          运行状态存储（内存或文件）
  prompts.ts            worker prompt 模板
  types.ts              类型定义
```

### 验收标准

- [ ] 一个用户问题可拆成多个只读 worker 并行分析
- [ ] worker 只有 read / grep / find / ls / code_search，不能写文件
- [ ] 可 abort 全部 worker，abort 后 session 被销毁
- [ ] worker 完成后 session 立即 destroy，不依赖 idle timeout
- [ ] SSE 事件流实时展示每个 worker 的进度
- [ ] 汇总结果正确包含所有 worker 的输出

---

## Phase 4：隔离编辑 Agent

### 目标

多个 worker 并行在隔离目录中尝试不同编辑方案，用户 review diff 后选择应用。

### 隔离机制

优先使用 git worktree：

```txt
git worktree add /tmp/deerhux-runs/<run-id>/worker-1 HEAD
git worktree add /tmp/deerhux-runs/<run-id>/worker-2 HEAD
```

非 git 项目回退到临时目录复制。

```txt
/tmp/deerhux-runs/<run-id>/
  worker-1/    # git worktree 或复制的仓库
  worker-2/
  worker-3/
```

### Worker 执行

每个 worker 在自己的目录中执行全功能工具：

```ts
const { session: inner } = await createAgentSession({
  cwd: workerDir,  // worktree 目录，不是主 cwd
  agentDir,
  sessionManager,
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "code_search"],
});
```

### Diff 生成 + Review

worker 完成后生成 diff：

```ts
const diff = execSync(`git -C ${workerDir} diff`, { encoding: "utf-8" });
```

UI 需要支持：

- 查看每个 worker 的 diff
- accept / reject 单个 worker 的变更
- cherry-pick 文件级或 hunk 级变更
- 冲突提示
- apply patch 到主 cwd（`git apply`）

### 安全要求

- worker 目录与主 cwd 隔离，不能写主 cwd
- apply patch 必须由用户确认
- abort 时清理 worktree：`git worktree remove <dir>`
- 异常退出时的清理由 run-store 的 cleanup 逻辑处理

### 验收标准

- [ ] 多 worker 在隔离目录中独立编辑
- [ ] 主工作区不会被 worker 直接修改
- [ ] 用户可查看每个 worker 的 diff
- [ ] 用户确认后可应用 patch 到主 cwd
- [ ] 冲突有明确提示
- [ ] abort 和异常退出时 worktree 被清理

---

## 实施路线图

### M1：索引基础设施

- [ ] `lib/code-index/config.ts`：索引路径、忽略规则常量
- [ ] `lib/code-index/paths.ts`：cwd hash → sqlite 路径
- [ ] `lib/code-index/scanner.ts`：文件扫描 + .gitignore 支持
- [ ] `lib/code-index/database.ts`：SQLite schema + FTS5 + CRUD
- [ ] `lib/code-index/indexer.ts`：全量 / 增量索引
- [ ] `lib/code-index/search.ts`：搜索接口
- [ ] `app/api/index/status/route.ts`：索引状态 API
- [ ] `app/api/index/refresh/route.ts`：索引刷新 API
- [ ] `app/api/index/search/route.ts`：搜索 API

### M2：`code_search` 工具

- [ ] 在 `startRpcSession` 中注入 `code_search` custom tool
- [ ] `code_search` 标记 `executionMode: "parallel"`
- [ ] 搜索结果包含 path、line range、snippet
- [ ] 更新 `ToolPanel.tsx` 预设，`PRESET_FULL` 加入 `code_search`
- [ ] 更新 `getPresetFromTools()` 匹配逻辑

### M3：SDK 只读工具并行验证与适配

- [ ] 验证 SDK 内置工具的 `executionMode` 设置
- [ ] 根据验证结果决定是否需要补充标记
- [ ] 集成测试：多个 read/grep/find 并行执行
- [ ] 验证 toolResult 顺序与 toolCall 顺序一致
- [ ] 验证 abort 可取消并行工具
- [ ] UI 验证：多个工具同时 running 时的显示效果
- [ ] 添加配置开关：禁用并行（回退全串行）

### M4：只读并行 Agent

- [ ] `lib/parallel-agent/orchestrator.ts`：调度逻辑
- [ ] `lib/parallel-agent/worker-session.ts`：worker session 创建 / 销毁
- [ ] `lib/parallel-agent/run-store.ts`：运行状态管理
- [ ] `lib/parallel-agent/prompts.ts`：worker prompt 模板
- [ ] `app/api/parallel-runs/route.ts`：创建 / 查询 API
- [ ] `app/api/parallel-runs/[runId]/route.ts`：状态查询
- [ ] `app/api/parallel-runs/[runId]/events/route.ts`：SSE 事件流
- [ ] `app/api/parallel-runs/[runId]/abort/route.ts`：中止 API
- [ ] Chat 中 Parallel Run 消息块 UI

### M5：隔离编辑 Agent

- [ ] git worktree 创建 / 管理 / 清理
- [ ] worker diff 生成
- [ ] diff review UI（查看、accept、reject）
- [ ] cherry-pick 文件级 / hunk 级变更
- [ ] `git apply` 应用 patch
- [ ] 冲突检测与提示
- [ ] abort 时 worktree 清理
- [ ] 异常退出清理兜底

---

## 风险与对策

### 1. Tool result 顺序错乱

**风险**：并行执行后结果按完成时间写入，破坏上下文顺序。

**对策**：执行可以并行，持久化和回传必须按原 toolCall 顺序。SDK 的 `executionMode` 机制应已处理此问题，集成测试重点验证。

### 2. bash 只读判断不可靠

**风险**：简单命令白名单容易被 shell 组合绕过（`grep foo file && rm -rf tmp`）。

**对策**：`bash` 默认不并行。如需开放，只支持极保守的 allowlist，或引入 shell AST 解析。MVP 阶段不做。

### 3. 并行 worker 占用 registry

**风险**：worker 完成后不销毁，占用 `globalThis.__deerhuxSessions` 直到 10 分钟 idle timeout。

**对策**：worker 完成后立即调用 `wrapper.destroy()`，orchestrator 在 `finally` 块中保证清理。

### 4. 索引污染仓库

**风险**：索引文件误放项目目录。

**对策**：统一放 `~/.deerhux/agent/indexes/<cwd-hash>.sqlite`，代码中硬编码路径规则。

### 5. 并行编辑覆盖用户改动

**风险**：worker 直接写主 cwd，互相覆盖或覆盖用户本地修改。

**对策**：编辑型并行必须使用 git worktree 或临时目录。apply patch 前检查主 cwd 工作区状态（`git status --porcelain`）。

### 6. Next.js hot reload 导致 registry 泄漏

**风险**：开发态热更新时 module-level 状态不可靠。

**对策**：并行 run registry 放 `globalThis`，与现有 session registry 同策略，实现 idle timeout 和 abort cleanup。
