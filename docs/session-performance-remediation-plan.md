# DeerHux Session 加载与左侧栏高负载失败整改方案

> 文档目的：给出一套**完整、可落地、可回滚**的整改方案，解决 DeerHux 在高负载下左侧栏 `/api/sessions` 容易加载失败、打开 session 耗时长的问题。  
> 设计原则：**最小化 TODO 拆分**，优先用较少的工程步骤建立稳定闭环；保留 JSONL 作为真实日志，不推翻现有 Agent/DeerLoop 架构。

---

## 0. 一句话结论

DeerHux 的问题不是“用了 JSONL”，而是当前把 JSONL 同时当作：

1. 真实会话日志；
2. 左侧栏查询数据库；
3. 打开 session 的完整历史数据源；
4. Agent Runtime 恢复源；
5. 高频 polling 数据源。

在高负载下，Agent 写入、Subagent 写入、UI 读取、watchdog/polling 读取全部竞争同一批 JSONL 文件和同一个 Node 进程，导致：

```txt
Agent 越忙
  → session 文件越频繁变化
  → cache 更容易失效
  → UI 请求越容易触发全量扫描/全量解析
  → Node 事件循环与文件 IO 被进一步压住
  → 左侧栏超时、打开 session 慗
```

整改方向：

```txt
JSONL 继续作为 source of truth
Session Index 作为左侧栏查询层
Session Message Page 作为打开 session 首屏加速层
Runtime State 与历史消息读取分离
```

---

## 1. 现状证据与问题定位

### 1.1 左侧栏链路

当前左侧栏入口：

- `components/SessionSidebar.tsx`
- `app/api/sessions/route.ts`
- `lib/session-reader.ts`

链路：

```txt
SessionSidebar.loadSessions()
  → fetch('/api/sessions')
  → app/api/sessions/route.ts
  → listAllSessions()
  → SessionManager.listAll()
  → 返回所有 SessionInfo
```

问题：

- 冷启动无 cache 时，`listAllSessions()` 必须等待 `SessionManager.listAll()` 完成。
- 高负载下，如果 Agent/Subagent 正在频繁写 JSONL，文件系统和 Node 事件循环被压住，左侧栏容易超过 30s timeout。
- 现有 stale-while-revalidate 只能缓解热 cache 场景，不能解决冷启动/cache miss/进程重启后的阻塞。

### 1.2 打开 session 链路

当前打开 session 入口：

- `hooks/useAgentSession.ts`
- `app/api/sessions/[id]/route.ts`
- `lib/session-reader.ts`

链路：

```txt
useAgentSession
  → loadSession(sessionId, true, true)
  → GET /api/sessions/:id?includeState
  → resolveSessionPath(id)
  → readSessionFileCached(filePath)
  → SessionManager.open(filePath)
  → getEntries()
  → buildSessionContext(entries, leafId)
  → 可选 getRpcSession(id).send({ type: 'get_state' })
  → 返回完整 context.messages
```

问题：

- 每次打开 session 都倾向于读取完整 JSONL、解析全部 entries、构建完整 UI context。
- `includeState=true` 会让历史消息加载额外依赖 Agent Runtime 状态查询。
- 大 session、工具调用多、图片/大 tool result 多、Subagent snapshot 多时，首屏加载时间明显变长。

### 1.3 当前已有优化

代码中已经存在一些补救机制：

- `lib/session-reader.ts`
  - `SESSION_LIST_TTL_MS = 30_000`
  - stale-while-revalidate
  - background refresh cooldown
  - invalidate debounce
  - per-file read cache
  - base64 image stripping
- `hooks/useAgentSession.ts`
  - foreground/background timeout
  - inflight dedupe
  - session switch abort
  - polling 限制
  - subagent live refresh 限制

这些优化方向正确，但它们仍然是在“JSONL 直读”模型上做缓解。核心架构仍需加查询层。

---

## 2. 整改目标

### 2.1 P0 目标：左侧栏稳定

高负载下，左侧栏必须做到：

```txt
只要 index 文件存在，就能快速返回旧数据
后台刷新失败不影响 UI 展示
首次无 index 时，不阻塞 30 秒等待全量扫描
```

### 2.2 P1 目标：打开 session 首屏变快

打开 session 时：

```txt
先显示可用首屏消息
runtime state 异步补齐
大历史分页懒加载
```

### 2.3 P2 目标：可观测、可回滚

任何改造必须满足：

- 有 trace 能定位耗时；
- 有 feature flag 可回退旧逻辑；
- 保留 JSONL source of truth；
- 不破坏 fork、branch、compaction、subagent 现有能力。

---

## 3. 目标架构

```txt
┌─────────────────────────────────────┐
│ React UI                             │
│ - 左侧栏 SessionSidebar              │
│ - ChatWindow                         │
│ - Session Tabs                       │
└───────────────────┬─────────────────┘
                    │
┌───────────────────▼─────────────────┐
│ Next API 控制面                       │
│ - GET /api/sessions                  │
│ - GET /api/sessions/:id              │
│ - GET /api/sessions/:id/state        │
│ - GET /api/sessions/:id/messages     │
└───────────────────┬─────────────────┘
                    │
┌───────────────────▼─────────────────┐
│ Session Query Layer                  │
│ - session-index.json                 │
│ - stale-while-revalidate             │
│ - rebuild lock                       │
│ - per-session message page cache     │
└───────────────────┬─────────────────┘
                    │
┌───────────────────▼─────────────────┐
│ Agent Runtime / DeerLoopEngine        │
│ - prompt loop                         │
│ - tool execution                      │
│ - subagent                            │
│ - append jsonl                        │
└───────────────────┬─────────────────┘
                    │
┌───────────────────▼─────────────────┐
│ JSONL Session Files                   │
│ ~/.deerhux/agent/sessions/**/*.jsonl  │
└─────────────────────────────────────┘
```

核心原则：

```txt
JSONL 是日志，不是 UI 查询数据库。
```

---

## 4. 存储设计

### 4.1 保留 JSONL 作为 source of truth

继续保留：

```txt
~/.deerhux/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

JSONL 负责：

- 完整会话审计；
- 崩溃恢复；
- fork/branch；
- compaction；
- tool call/tool result；
- subagent snapshot；
- PI SDK / DeerLoop 兼容。

### 4.2 新增 Session Index

新增文件：

```txt
~/.deerhux/agent/session-index.json
```

第一版建议用 JSON 文件，不直接上 SQLite，原因：

- 改动小；
- 易调试；
- 不引入额外依赖；
- 足够验证架构收益；
- 后续可以平滑替换为 SQLite。

#### 4.2.1 Index 结构

```ts
export interface SessionIndexFile {
  version: 1;
  generatedAt: string;
  records: SessionIndexRecord[];
  lastRebuildError?: string;
}

export interface SessionIndexRecord {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  lastMessagePreview?: string;
  isSubagent?: boolean;
  parentSessionId?: string;
  parentSessionPath?: string;
  sizeBytes: number;
  mtimeMs: number;
  indexedAt: string;
  dirty?: boolean;
  missing?: boolean;
}
```

#### 4.2.2 Index 原子写

写入必须使用原子替换：

```txt
session-index.json.tmp
  → writeFile
  → rename session-index.json
```

避免应用崩溃时留下半写文件。

#### 4.2.3 Index 损坏处理

如果读取 index 失败：

```txt
session-index.json
  → rename session-index.corrupt.<timestamp>.json
  → 返回 [] + rebuilding=true
  → 后台 rebuild
```

---

## 5. API 契约设计

### 5.1 `/api/sessions`

#### 当前问题

当前接口同步依赖 `listAllSessions()`，冷启动时可能阻塞。

#### 目标契约

```ts
export interface SessionsResponse {
  sessions: SessionInfo[];
  stale?: boolean;
  rebuilding?: boolean;
  warning?: string;
  source?: "index" | "legacy";
}
```

#### 行为

```txt
如果 DEERHUX_SESSION_INDEX=0：
  走旧逻辑 listAllSessions()

如果 DEERHUX_SESSION_INDEX!=0：
  1. 尝试读取 session-index.json
  2. 读到 records：立即返回 records 映射的 SessionInfo
  3. 如果 index stale：后台 schedule rebuild，不阻塞响应
  4. 如果 index 不存在：返回 [] + rebuilding=true，并后台 rebuild
  5. 如果 index 损坏：隔离 corrupt 文件，返回 [] + rebuilding=true，并后台 rebuild
```

#### 左侧栏 UX

- `rebuilding=true` 且有 sessions：显示旧列表 + 小提示“正在刷新会话索引”。
- `rebuilding=true` 且 sessions 为空：显示“正在建立会话索引”，不要显示致命错误。
- 只有接口 500/网络错误才显示加载失败。

---

### 5.2 `/api/sessions/:id`

短期保持兼容，但调整前端使用方式。

#### 当前契约

```txt
GET /api/sessions/:id?includeState
```

返回完整：

```ts
{
  sessionId,
  filePath,
  info,
  leafId,
  context,
  agentState?
}
```

#### 短期调整

前端打开 session 时先调用：

```txt
GET /api/sessions/:id
```

然后异步补 state：

```txt
GET /api/sessions/:id/state
```

或临时复用：

```txt
POST /api/agent/:id { type: "get_state" }
```

这样消息加载不再被 runtime state 阻塞。

---

### 5.3 新增 `/api/sessions/:id/state`

```ts
export interface SessionRuntimeStateResponse {
  running: boolean;
  state?: {
    isStreaming?: boolean;
    isCompacting?: boolean;
    isRunning?: boolean;
    contextUsage?: {
      percent: number | null;
      contextWindow: number;
      tokens: number | null;
    } | null;
    systemPrompt?: string;
    thinkingLevel?: string;
    agentMode?: AgentMode;
  };
}
```

实现逻辑：

```txt
getRpcSession(id)
  不存在：{ running: false }
  存在且 alive：rpc.send({ type: 'get_state' })
```

这个接口超时可更短，例如 5s。失败不影响历史消息展示。

---

### 5.4 新增 `/api/sessions/:id/messages`

这是第二阶段打开 session 优化。

```txt
GET /api/sessions/:id/messages?cursor=latest&limit=100
```

响应：

```ts
export interface SessionMessagesResponse {
  sessionId: string;
  messages: AgentMessage[];
  entryIds: string[];
  page: {
    cursor: string | null;
    nextCursor: string | null;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    limit: number;
  };
}
```

第一版限制：

- 只支持当前 leaf 的最近 N 条；
- fork/tree 高级分页后续增强；
- compaction summary 仍作为一条特殊消息处理；
- 保留旧 `/api/sessions/:id` 兼容路径。

---

## 6. 缓存与失效策略

### 6.1 Session Index cache

内存 cache：

```ts
interface SessionIndexMemoryCache {
  index: SessionIndexFile;
  loadedAt: number;
  mtimeMs: number;
}
```

策略：

- index 文件 mtime 未变则复用内存；
- API 响应优先读内存；
- 后台 rebuild 完成后更新内存。

### 6.2 Rebuild lock

全局只允许一个 rebuild：

```ts
globalThis.__deerhuxSessionIndexRebuildPromise
```

如果已有 rebuild：

```txt
不再启动新 rebuild
/api/sessions 返回 rebuilding=true
```

### 6.3 Rebuild 触发

触发点：

- index 不存在；
- index stale；
- session 新建；
- session 删除；
- session rename；
- force refresh；
- 手动 debug endpoint，可选。

### 6.4 Stale 判断

第一版简单判断：

```txt
Date.now() - generatedAt > 30_000
```

也可以结合 sessions 目录 mtime，但目录 mtime 在不同平台上语义不完全一致，第一版不强依赖。

### 6.5 Dirty 更新

短期：

```txt
invalidateSessionListCache()
  → mark index stale
  → debounce schedule rebuild
```

长期：

```txt
Agent append session
  → 单 session 增量更新 index record
```

---

## 7. 可观测性设计

### 7.1 Trace 开关

新增环境变量：

```txt
DEERHUX_SESSION_TRACE=1
```

默认关闭。

### 7.2 Trace 输出格式

左侧栏：

```txt
[session-trace] listSessions total=12ms source=index count=51 stale=true rebuilding=true
[session-trace] rebuildIndex total=840ms files=51 ok=true
```

打开 session：

```txt
[session-trace] openSession id=xxx total=1240ms resolve=1ms stat=0ms open=80ms entries=300ms build=760ms serialize=99ms size=2.8MB messageCount=1032
```

state：

```txt
[session-trace] sessionState id=xxx total=23ms running=true
```

### 7.3 重点观测指标

| 指标 | 目的 |
|---|---|
| `/api/sessions` total | 左侧栏总耗时 |
| index read 耗时 | 判断 index 是否有效 |
| rebuild 耗时 | 判断后台重建成本 |
| session file size | 判断大 session |
| getEntries 耗时 | 判断 JSONL parse 成本 |
| buildSessionContext 耗时 | 判断 CPU 重建成本 |
| JSON response size | 判断网络/序列化成本 |
| state query 耗时 | 判断 runtime 是否拖慢打开 |

---

## 8. 高可用机制

### 8.1 左侧栏永远优先可用

原则：

```txt
有旧 index 就返回旧 index
没有 index 才返回空 + rebuilding
不要因为 rebuild 失败让 /api/sessions 失败
```

### 8.2 后台任务失败不影响前台

后台 rebuild 出错：

- 写入 `lastRebuildError`；
- console error；
- 下次请求继续返回旧 index；
- 响应带 `warning`。

### 8.3 回滚开关

```txt
DEERHUX_SESSION_INDEX=0
```

关闭后恢复旧逻辑。

```txt
DEERHUX_SESSION_PAGING=0
```

关闭后恢复完整 session 加载。

```txt
DEERHUX_SESSION_TRACE=0
```

关闭 trace。

### 8.4 并发保护

- index rebuild 单飞；
- index 原子写；
- session 删除时 remove index record；
- session rename 时 upsert；
- force refresh 不阻塞 UI。

---

## 9. 最小化 TODO 拆分

为了避免 TODO 过碎，整改只拆成 **3 个大 TODO**。

---

# TODO 1：建立 Session Control Plane 基础设施

## 目标

一次性完成：

1. session trace；
2. session-index.json 读写；
3. index rebuild；
4. `/api/sessions` 接入 index；
5. 左侧栏兼容 stale/rebuilding。

这是最关键的闭环，优先解决：

```txt
高负载时左侧栏特别容易加载失败
```

## 涉及文件

新增：

```txt
lib/session/session-trace.ts
lib/session/session-index.ts
```

修改：

```txt
lib/session-reader.ts
app/api/sessions/route.ts
components/SessionSidebar.tsx
```

## 实现细节

### A. `session-trace.ts`

提供：

```ts
export function isSessionTraceEnabled(): boolean;
export function traceSession(label: string, fields: Record<string, unknown>): void;
export async function timeSessionStep<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }>;
export function timeSessionStepSync<T>(label: string, fn: () => T): { value: T; ms: number };
```

### B. `session-index.ts`

提供：

```ts
export async function readSessionIndex(): Promise<SessionIndexFile | null>;
export async function listSessionsFromIndex(): Promise<{ sessions: SessionInfo[]; stale: boolean; rebuilding: boolean; warning?: string }>;
export function scheduleSessionIndexRebuild(reason: string): void;
export async function rebuildSessionIndex(): Promise<SessionIndexFile>;
export function invalidateSessionIndex(reason: string): void;
export async function removeSessionIndexRecord(sessionId: string): Promise<void>;
```

### C. `/api/sessions` 行为

伪代码：

```ts
export async function GET() {
  if (process.env.DEERHUX_SESSION_INDEX === "0") {
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, source: "legacy" });
  }

  const result = await listSessionsFromIndex();
  return NextResponse.json({
    sessions: result.sessions,
    stale: result.stale,
    rebuilding: result.rebuilding,
    warning: result.warning,
    source: "index",
  });
}
```

### D. 左侧栏兼容

`components/SessionSidebar.tsx` 读取：

```ts
const data = await res.json() as {
  sessions: SessionInfo[];
  stale?: boolean;
  rebuilding?: boolean;
  warning?: string;
};
```

行为：

- `sessions.length > 0`：正常显示。
- `rebuilding=true`：显示非阻塞提示。
- `sessions.length === 0 && rebuilding=true`：显示“正在建立会话索引”。
- 不把 `rebuilding=true` 当 error。

## 验收标准

1. 设置 `DEERHUX_SESSION_TRACE=1` 后，控制台能看到 `/api/sessions` 与 rebuild 耗时。
2. 存在 `~/.deerhux/agent/session-index.json` 后，`/api/sessions` 不再阻塞等待 `SessionManager.listAll()`。
3. 删除 index 后首次打开，左侧栏不 30s 卡死，而是显示 rebuilding 状态。
4. 高负载下，旧 index 可继续返回，后台 rebuild 失败不导致左侧栏失败。
5. 设置 `DEERHUX_SESSION_INDEX=0` 后可恢复旧逻辑。

## 风险

| 风险 | 处理 |
|---|---|
| index 与 JSONL 不一致 | 返回 stale 标识，后台 rebuild |
| index 文件损坏 | rename corrupt，重建 |
| rebuild 期间重复触发 | global rebuild lock |
| 初次启动空列表 | UI 明确显示“正在建立索引” |

---

# TODO 2：拆分打开 session 的历史加载与 runtime state

## 目标

解决打开 session 时被 runtime state 拖慢的问题。

当前：

```txt
loadSession(sessionId, true, true)
  → /api/sessions/:id?includeState
```

调整为：

```txt
第一步：GET /api/sessions/:id
第二步：GET /api/sessions/:id/state
```

历史消息先显示，runtime state 后补。

## 涉及文件

新增：

```txt
app/api/sessions/[id]/state/route.ts
```

修改：

```txt
hooks/useAgentSession.ts
app/api/sessions/[id]/route.ts
```

## 实现细节

### A. 新增 state route

```ts
export async function GET(_req, { params }) {
  const { id } = await params;
  const rpc = getRpcSession(id);
  if (!rpc?.isAlive()) {
    return NextResponse.json({ running: false });
  }
  const state = await rpc.send({ type: "get_state" });
  return NextResponse.json({ running: true, state });
}
```

建议加 5s 内部 timeout，避免 runtime 卡住。

### B. 前端打开 session 改造

`hooks/useAgentSession.ts` 当前打开：

```ts
loadSession(sessionId, true, true)
```

改为：

```ts
loadSession(sessionId, true, false).then(() => {
  void loadSessionState(sessionId);
});
```

或者：

```ts
const contentPromise = loadSession(sessionId, true, false);
const statePromise = loadSessionState(sessionId);
```

但 UI 上必须保证：

- content 成功即可显示消息；
- state 失败只影响运行态按钮/状态，不影响消息展示。

## 验收标准

1. 打开 session 时，即使 runtime 忙，历史消息也能先显示。
2. `/api/sessions/:id/state` 失败不会把整个 session 加载标记为失败。
3. 正在运行的 session 仍能正确恢复 `agentRunning`、`isCompacting`、`contextUsage`、`systemPrompt`。
4. 旧 `/api/sessions/:id?includeState` 暂时保留兼容。

## 风险

| 风险 | 处理 |
|---|---|
| state 晚到导致 UI 状态短暂不准 | 默认显示未知/恢复中 |
| running session 未及时连 SSE | content 加载后仍按原逻辑 connectEvents |
| 老调用方依赖 includeState | 保留旧参数兼容 |

---

# TODO 3：Session Messages 首屏分页

## 目标

解决大 session 每次打开都全量解析/全量返回导致首屏慢的问题。

第一版做“最近 N 条消息”分页，默认 N=100。

## 涉及文件

新增：

```txt
app/api/sessions/[id]/messages/route.ts
lib/session/session-messages.ts
```

修改：

```txt
hooks/useAgentSession.ts
components/ChatWindow.tsx 或消息容器相关逻辑
```

## 实现细节

### A. 新增 message page API

```txt
GET /api/sessions/:id/messages?cursor=latest&limit=100
```

返回：

```ts
{
  sessionId: string;
  messages: AgentMessage[];
  entryIds: string[];
  page: {
    cursor: string | null;
    nextCursor: string | null;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    limit: number;
  }
}
```

### B. 第一版实现方式

为降低风险，第一版可以仍然复用 `readSessionFileCached()` 和 `buildSessionContext()`，但在返回前只截取最近 N 条：

```ts
const context = readSessionFileCached(filePath).context;
const messages = context.messages.slice(-limit);
const entryIds = context.entryIds.slice(-limit);
```

这不能完全消除后端 parse 成本，但能先减少：

- HTTP response size；
- JSON serialization；
- 前端 JSON parse；
- React render；
- 首屏 setMessages 成本。

第二版再优化为真正基于 entries/path 的局部构建。

### C. 前端首屏加载

打开 session 时改为：

```txt
GET /api/sessions/:id       // summary/context meta，或旧接口轻量化
GET /api/sessions/:id/messages?cursor=latest&limit=100
GET /api/sessions/:id/state // 异步
```

如果为了兼容最小改造，也可以先：

- 保留 `/api/sessions/:id`；
- 增加 feature flag `DEERHUX_SESSION_PAGING=1`；
- 开启时前端使用 messages API；
- 关闭时仍走旧完整接口。

### D. 历史加载

第一版可以先不做无限滚动，只做首屏最近 100 条，并显示：

```txt
上方有更早消息，点击加载完整历史
```

点击后可以回退调用旧完整接口。

这样最小风险地验证收益。

## 验收标准

1. 开启 `DEERHUX_SESSION_PAGING=1` 后，大 session 首屏返回 payload 明显变小。
2. 前端首屏只渲染最近 100 条，打开速度提升。
3. 用户仍可通过“加载完整历史”访问旧历史。
4. 关闭 feature flag 后恢复旧行为。

## 风险

| 风险 | 处理 |
|---|---|
| branch/leaf 下分页复杂 | 第一版只处理当前 leaf 的最近 N 条 |
| 用户需要全文搜索历史 | 保留加载完整历史入口 |
| compaction summary 显示异常 | 复用现有 buildSessionContext，先保证一致性 |

---

## 10. 推荐执行顺序

虽然 TODO 只有 3 个，但执行顺序必须固定：

```txt
1. TODO 1：Session Control Plane 基础设施
   先解决左侧栏高负载失败，并建立 trace。

2. TODO 2：拆 runtime state
   让打开 session 不被 Agent Runtime 卡住。

3. TODO 3：消息首屏分页
   进一步降低大 session 首屏成本。
```

不建议一开始就做 Agent Runtime 进程隔离，因为：

- 改动更大；
- IPC 契约复杂；
- 即使拆进程，如果 UI 仍然全量扫 JSONL，左侧栏冷启动仍然慢；
- 当前最直接收益来自 session query layer。

---

## 11. 验证计划

### 11.1 本地功能验证

```bash
npm run lint
npm run build
```

如果 build 太慢，至少跑：

```bash
npx tsc --noEmit
```

### 11.2 手工验证

#### 场景 A：首次无 index

```txt
删除 ~/.deerhux/agent/session-index.json
启动 DeerHux
打开左侧栏
```

期望：

- UI 显示“正在建立会话索引”；
- 不 30s 卡死；
- rebuild 完成后列表出现。

#### 场景 B：已有 index，高负载

```txt
开启一个长 Agent 任务
同时打开左侧栏
```

期望：

- `/api/sessions` 快速返回旧 index；
- 后台 rebuild 不影响 UI。

#### 场景 C：打开大 session

```txt
打开 2MB+ jsonl session
```

期望：

- TODO 2 后：历史消息先显示，state 后补；
- TODO 3 后：首屏只渲染最近 N 条。

#### 场景 D：回滚

```bash
DEERHUX_SESSION_INDEX=0 npm run dev
DEERHUX_SESSION_PAGING=0 npm run dev
```

期望：

- 恢复旧逻辑；
- 不影响已有功能。

---

## 12. 未来增强，不纳入本轮 TODO

这些是后续优化，不建议本轮一起做：

1. SQLite session index；
2. message offset index；
3. tool result blob 外置；
4. Agent Runtime child process 隔离；
5. session 全文搜索；
6. subagent run 独立事件数据库；
7. 真正基于 JSONL offset 的增量分页。

原因：

- 当前最痛的是左侧栏失败和打开慢；
- 本轮要最小改动建立稳定架构边界；
- 过早引入 SQLite/IPC 会扩大风险。

---

## 13. 最终判断

本整改方案的核心不是“抛弃 JSONL”，而是把 JSONL 放回它最适合的位置：

```txt
JSONL = append-only source of truth
Index = UI query layer
Paging = 首屏体验层
Runtime State = 独立运行态
```

按 3 个 TODO 落地后，DeerHux 会从当前的：

```txt
文件日志直读型架构
```

升级为：

```txt
日志 + 索引 + 分页视图 + 运行态分离
```

这会直接缓解：

1. 高负载时左侧栏加载失败；
2. 每次打开 session 慢；
3. Agent 运行态拖慢历史加载；
4. session cache miss 时 UI 阻塞；
5. 后续性能问题不可观测。

建议优先执行 TODO 1，形成第一轮闭环。