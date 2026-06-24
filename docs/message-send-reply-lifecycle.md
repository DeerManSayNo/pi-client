# DeerHux 消息发送回复全流程

> 梳理 DeerHux 中一条用户消息从发送到回复、再到会话销毁的**完整生命周期**。
> 覆盖三条核心通道、关键文件、端到端时序、8 个生命周期阶段、事件清单与多层恢复机制。

---

## 一、三条核心通道

整个交互建立在一发（命令）、一收（事件流）、一读（历史）三个独立通道上：

| 通道 | 端点 | 方法 | 用途 |
|------|------|------|------|
| 命令通道 | `/api/agent/[id]` | POST | 发消息 / 控制指令（abort、set_model…） |
| 事件通道 | `/api/agent/[id]/events` | GET (SSE) | 实时推送 agent 事件流 |
| 读取通道 | `/api/sessions/[id]` | GET | 只读拉取历史消息 + 运行态 |
| 新建通道 | `/api/agent/new` | POST | 创建全新 session（拿到 id 后再连 SSE） |

命令与事件**解耦**：POST `prompt` 立刻返回，真正的回复通过 SSE 异步推送。

---

## 二、关键文件定位

| 文件 | 角色 |
|------|------|
| `lib/rpc-manager.ts` | **后端大脑**：`AgentSessionWrapper` 类 + `startRpcSession`，封装 pi-coding-agent 的 `AgentSession`，管理生命周期/事件分发/idle 超时 |
| `lib/session-reader.ts` | 只读 session 解析（`buildSessionContext` / `readSessionFileCached` / `resolveSessionPath`），stale-while-revalidate 缓存 |
| `lib/agent-client.ts` | 前端 `sendAgentCommand` 封装（POST `/api/agent/[id]`） |
| `lib/agent-event-bus.ts` | 浏览器侧事件总线，解耦 SSE 与日志面板 |
| `hooks/useAgentSession.ts` | **前端状态机**（2220 行），管理 streaming / watchdog / 自动恢复 |
| `app/api/agent/[id]/route.ts` | POST=发命令 / GET=查状态 |
| `app/api/agent/[id]/events/route.ts` | SSE 流 |
| `app/api/agent/new/route.ts` | 新会话引导 |
| `app/api/sessions/[id]/route.ts` | GET=读历史 / PATCH=改名 / DELETE=删除 |

---

## 三、端到端时序图

```
浏览器(useAgentSession)          Next API Route           AgentSessionWrapper         pi-coding-agent SDK         LLM/Tool
   │                                │                          │                          │                        │
─── 1. 会话引导 ──────────────────────────────────────────────────────────────────────────────────────────────────────
   │ POST /api/agent/new {create}   │                          │                          │                        │
   │───────────────────────────────>│ startRpcSession(tempKey) │ createAgentSession       │                        │
   │                                │─────────────────────────>│─────────────────────────>│                        │
   │ < {sessionId} ─────────────────│<─────────────────────────│ registry.set(id,w)       │                        │
   │ connectEvents(id) [EventSource]│                          │                          │                        │
   │════════════════════════════════>│ session.onEvent(listener)│                          │                        │
   │  GET /events 返回 text/event-stream                        │                          │                        │
─── 2. 发送消息 ──────────────────────────────────────────────────────────────────────────────────────────────────────
   │ 乐观插入 user 消息到 UI         │                          │                          │                        │
   │ POST /api/agent/[id] {prompt}  │                          │                          │                        │
   │───────────────────────────────>│ existing.send(body)      │                          │                        │
   │                                │─────────────────────────>│                          │                        │
   │                                │                          │ prepareTurnContext       │                        │
   │                                │                          │ prepareImageFallback     │                        │
   │                                │                          │ appendDisplayUserMessage │                        │
   │                                │                          │ 补发 message_end/user ──┐│                        │
   │                                │                          │ trackTurn(inner.prompt)─>│───────────────────────>│
   │ < {success:true,data:null} ────│<─────────────────────────│                          │                        │
─── 3. 事件回流（异步） ──────────────────────────────────────────────────────────────────────────────────────────────
   │                                │                          │ inner.subscribe(event) <─│ <──────────────────────│
   │                                │                          │ recordEventStatus        │                        │
   │                                │                          │ resetIdleTimer           │                        │
   │                                │                          │ listeners.forEach(l=>l)  │                        │
   │ data: {type:agent_start…}      │<─────────────────────────│                          │                        │
   │<═══════════════════════════════│                          │                          │                        │
   │ data: {message_update…}        │<─────────────────────────│                          │                        │
   │<═══════════════════════════════│  (每 30s 发心跳 : \n\n)   │                          │                        │
   │ data: {tool_execution_start…}  │<─────────────────────────│                          │                        │
   │ data: {message_end…}           │<─────────────────────────│                          │                        │
   │ data: {agent_end}              │<─────────────────────────│                          │                        │
   │<═══════════════════════════════│                          │                          │                        │
─── 4. 收尾 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
   │ loadSession() GET /api/sessions/[id]?includeState                                         │                        │
   │───────────────────────────────>│ readSessionFileCached    │                          │                        │
   │                                │ getRpcSession.get_state  │                          │                        │
   │ < {context, agentState} ───────│<─────────────────────────│                          │                        │
   │ onAgentEnd(changedFiles)       │                          │                          │                        │
```

---

## 四、全生命周期 8 个阶段详解

### 阶段 1 · 会话引导（Bootstrap）

两条路径汇入同一个 `startRpcSession`：

**新建会话**（`app/api/agent/new/route.ts`）
- 前端 `handleSend` 走 `isNew` 分支：先 `POST /api/agent/new {type:"create"}` 仅创建不发送
- `startRpcSession(tempKey, "", cwd, ...)` → `SessionManager.create` → `createAgentSession`（注入自定义工具：`code_search`、`codegraph`、`subagent`、MCP 工具）
- 返回 `realSessionId`，前端拿到后 `connectEvents(id)` 建好 SSE，**再** `POST /api/agent/[id] {prompt}` 发首条消息（保证 SSE 不错过 `agent_start`）

**冷启动已有会话**（`app/api/agent/[id]/route.ts:11-40`）
- `getRpcSession(id)` miss 时走 cold-start：`readSessionFileCached(filePath)` 拿 `cwd/roleId/agentMode` → `startRpcSession`
- 同一个 per-file 缓存让并发的 cold-start POST 与 `GET /api/sessions/[id]` 共享一次解析

> `startRpcSession` 内有 `locks` Map 保证同一 sessionId 并发冷启动只跑一次。

### 阶段 2 · 前端发送（`handleSend`）

1. `agentRunningRef.current = true` 立即锁防重复（不等 React 重渲染）
2. `resetTurnTracking()` + `autoRecoveryAttemptsRef = 0`，开新 turn
3. `awaitingAgentStartRef = true` + `scheduleAwaitingAgentStartGuard`（60s 兜底）
4. **乐观插入** user 消息到 `messages`，UI 立即可见
5. 新会话：先 create 拿 id → `connectEvents` → `waitForEventsReady` → `sendAgentCommand({type:"prompt"})`
6. 已有会话：`ensureEventsConnected` → `sendAgentCommand({type:"prompt"})`
7. 失败：回滚乐观消息、解锁、关掉孤儿 EventSource

### 阶段 3 · 后端命令分发（`AgentSessionWrapper.send`）

`app/api/agent/[id]/route.ts` 拿到 `existing` → `session.send(body)`，进入 `switch(type)`：

**`case "prompt"`（`lib/rpc-manager.ts` ~L990）核心 6 步：**
1. `setRole` 若传了 roleId
2. `prepareTurnContext`：
   - 解析 `/skill:xxx` 命令、用户引用文件
   - 加载技能文件内容（项目技能 → 内置 `lib/builtin-skills`）
   - 拼装 `<turn_context>` 块（mode + references + selected_skill）
3. `prepareImageFallback`：
   - 磁盘 `filePath` → base64
   - 当前模型不支持 image 输入时，**MCP 视觉降级**：调 `mcpRuntime.describeImages` 把图片转成文字描述塞进 message
4. `appendDisplayUserMessage` + `appendTurnContextMetadata` 持久化到 `.jsonl`（便于 fork/重载）
5. **补发一条 `message_end/user` 事件**：解决远程触发（微信 bot）时前端没有乐观插入的场景；本地发送有去重不会重复
6. `trackTurn(withTemporarySystemPrompt(turnBlock, () => inner.prompt(msg, {images})))`
   - `withTemporarySystemPrompt`：把 turn 块拼到 base 系统提示后，执行完 `.finally(applyRolePrompt)` 恢复
   - `trackTurn`：跟踪 promise，reject 时合成 `agent_end{error}`，finally 兜底补 `agent_end`

其他命令：`steer`（运行中插入）/ `follow_up`（排队或开新 turn）/ `abort` / `set_model` / `set_mode` / `compact` / `fork` / `set_tools` / `set_subagent_enabled` / `mcp_reload` / `get_state` / `get_tools`。

### 阶段 4 · 事件流转（`AgentSessionWrapper.start`）

构造时 `wrapper.start()` 调 `inner.subscribe(callback)`，SDK 每个事件进入回调：

```
event → recordEventStatus(event)     // 维护 _isRunning / eventCount / lastContentAt / sawAssistantEventInTurn
      → resetIdleTimer()             // 重置空闲/超时计时
      → listeners.forEach(l => l(event))   // 推给 SSE listener
      → liveIsland.handleEvent(...)        // AIControls 实时岛
      → 文件变更检测：tool_execution_end 合并 pendingToolEvents
                    → extractChangedFilePath → 补发 agent_file_changed
```

`recordEventStatus` 关键状态机（`lib/rpc-manager.ts:768`）：
- `agent_start` → `_isRunning = true`
- `agent_end{willRetry:false}` → `_isRunning = false`（willRetry=true 保留运行态）
- `auto_retry_end{success:false}` → `_isRunning = false`

### 阶段 5 · SSE 推送（`events/route.ts`）

- 先发 `{type:"connected", sessionId}`
- `session.onEvent` 注册 listener，每个 event `JSON.stringify` 后 `data: ...\n\n` 推送
- **30s 心跳** `:\n\n` 防 Next.js/代理 120-150s 超时
- `req.signal.addEventListener("abort", cleanup)` 监听客户端断开 → `unsubscribe + clearInterval + controller.close`
- 收到 `agent_file_changed` 时 `addAllowedRoot(dirname)` 动态放开文件访问白名单

### 阶段 6 · 前端事件处理（`handleAgentEvent`）

`EventSource.onmessage` → `JSON.parse` → `agentEventBus.emit`（广播给日志面板）+ `handleAgentEventRef`：

| 事件 | 处理 |
|------|------|
| `agent_start` | `turnId++`、`resetTurnTracking`、`setAgentRunning(true)`、`phase=waiting_model`、`dispatch(start)` |
| `message_start/update` | 归一化 toolCalls、更新 `streamingMessage`、刷新 `lastContentChangedAt`（喂给 watchdog） |
| `message_end` | 追加到 `messages`，user 消息多重去重（content key / skill / SDK 注入前缀），`phase=waiting_model` |
| `tool_execution_start/end` | `phase=running_tools` 增减工具列表 |
| `auto_retry_start/end` | 更新 `retryInfo`；失败时 `setLastModelError`、停止 |
| `compaction_*` | `setIsCompacting`，完成后 `loadSession` |
| `agent_end` | willRetry 时保持 running；否则 `setAgentRunning(false)`、`loadSession(includeState)` 拉最新消息+contextUsage+systemPrompt、`onAgentEnd(changedFiles)` |

### 阶段 7 · 持久化与读取

**写**：SDK `inner.prompt` 内部把每条 user/assistant/tool 消息 append 到 `~/.deerhux/agent/sessions/*.jsonl`；`AgentSessionWrapper` 额外写 `display_user_message` / `turn_context` / `role_profile` / `agent_mode` 等 custom entry。

**读**（`GET /api/sessions/[id]`）：
- `resolveSessionPath(id)` 定位 `.jsonl`
- `readSessionFileCached(filePath)`：按 `(path, mtimeMs, size)` 缓存，避免每次并发刷新都重跑 CPU 密集的 `buildSessionContext`
- `?includeState=1` 时额外 `getRpcSession(id).send({type:"get_state"})` 取实时运行态（contextUsage、systemPrompt、thinkingLevel、isRunning、mcp 状态）
- `listAllSessions` 用 stale-while-revalidate（30s TTL + 8s 冷却的后台刷新 + 2s 防抖 invalidate）

### 阶段 8 · 恢复与保护机制（多层兜底）

这是项目最厚的部分，四道防线：

1. **SDK 内置自动重试**（`hardenAutoRetry`，`lib/rpc-manager.ts:300`）
   - 模型 API 失败自动重试，发 `auto_retry_start/end`，`willRetry=true` 期间 UI 保持 streaming

2. **前端 Watchdog**（`useAgentSession.ts`）
   - `setInterval` 检测 `eventIdleMs` / `contentIdleMs` 超阈值 → `executeRecovery`（`abort` + `follow_up`）
   - 熔断器：`MAX_AUTO_RECOVERIES_PER_TURN = 3`

3. **后端 Stale Warning**（`emitStaleWarning`，`lib/rpc-manager.ts:728`）
   - destroy 前 2 分钟发 `agent_stale_warning`，SSE 不受 tab 节流，补前端 watchdog 错过的窗口

4. **连接兜底**
   - `EventSource.onerror`：指数退避重连（1s→30s，最多 10 次）；重连后 `GET /api/agent/[id]` 核对 running 态，必要时合成 `agent_end`
   - `scheduleAwaitingAgentStartGuard`：POST 成功但 60s 没收到 `agent_start`，主动探测后端 + 必要时 abort 解锁 UI

### 阶段 9 · 销毁（Destroy）

`AgentSessionWrapper.destroy()`（`lib/rpc-manager.ts:1308`）触发条件：
- **空闲超时**（`resetIdleTimer`）：
  - 无活动 turn：`IDLE_TIMEOUT_MS = 10min`
  - turn 运行中：`ACTIVE_TURN_IDLE_TIMEOUT_MS = 30min`
  - 工具执行中：`TOOL_EXEC_IDLE_TIMEOUT_MS = 30min`
- `fork` 分叉时销毁当前
- `DELETE /api/sessions/[id]` 删除会话

destroy 动作：`_alive=false` → 清 idle/stale timer → `unsubscribe` → `inner.abort()`（释放 WebSocket/子进程）→ `mcpRuntimeLease.release()` → `onDestroyCallback`（从 registry 删除）。

---

## 五、完整事件类型清单

**生命周期**：`connected` · `agent_start` · `agent_end{willRetry,error}`
**消息流**：`message_start` · `message_update` · `message_end`
**工具**：`tool_execution_start` · `tool_execution_end` · `agent_file_changed`
**重试/压缩**：`auto_retry_start` · `auto_retry_end{success,finalError}` · `compaction_start` · `auto_compaction_start` · `compaction_end` · `auto_compaction_end`
**保护**：`agent_stale_warning{idleMs,destroyInMs}`

---

## 六、设计亮点小结

1. **命令/事件/读取三通道彻底解耦** → POST 不阻塞、SSE 单向推、读取走独立缓存
2. **乐观 UI + 去重**：user 消息先显示再发送，`message_end` 回流时多重去重避免重复
3. **冷启动单飞**：`locks` Map + per-file 缓存，并发请求共享一次解析
4. **图片多级降级**：磁盘引用 → base64 → MCP 视觉转文字
5. **turn 上下文隔离**：`withTemporarySystemPrompt` 每轮重拼 `<turn_context>`，finally 恢复 base prompt
6. **四层恢复防线**：SDK 重试 / 前端 watchdog / 后端 stale warning / SSE 重连，每层都有熔断
7. **registry + idle destroy**：进程内常驻 + 自动回收，避免内存泄漏
