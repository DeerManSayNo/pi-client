# LLM 服务商限流处置方案

> 目标：降低模型 API 触发服务商限流后的失败率，避免重试风暴，并在限流、过载、额度异常时给用户明确反馈和可恢复路径。

## 1. 背景与现状

当前 DeerHux 已具备一定模型调用容错能力：

- 主 Agent Loop 有自动重试机制：默认最多 3 次，退避约 `5s / 10s / 20s`。
- 流式断联、WebSocket 关闭、HTTP2 提前结束等错误会被识别为可重试。
- 已有 `auto_retry_start` / `auto_retry_end` 事件，前端可展示重试状态。
- 前端 watchdog 可检测模型无进展，并触发 recover：`abort + settle + 可选切模型 + 继续提示`。
- subagent worker 支持自动恢复模型，遇到 `rate limit`、`overloaded`、`timeout` 等错误可切备用模型重试。
- 已有上下文 token 粗略估算与手动压缩能力。

但当前对服务商限流仍偏弱：

- 没有统一 LLM 错误分类。
- 没有专门识别 `429`、`Retry-After`、TPM/RPM 限流。
- 没有 provider/model/API Key 级本地限流器。
- 没有 provider/model 熔断器。
- 主会话没有完整 fallback router。
- quota、auth、permission 等不可重试错误可能被普通重试误处理。

---

## 2. 需求生命周期解析

### 2.1 触发源

限流处置由以下事件触发：

1. **用户主会话发起模型请求**
   - 普通聊天
   - Agent 执行工具后的下一轮 LLM 调用
   - follow-up / steering 后的新一轮调用

2. **subagent / parallel-agent 发起模型请求**
   - worker session 执行子任务
   - planner / aggregator 辅助推理

3. **系统内部模型请求**
   - compact 会话压缩
   - watchdog recover 自动续跑
   - 未来可能的模型健康检查 / 能力探测

4. **服务商返回异常**
   - `429 Too Many Requests`
   - `rate_limit_exceeded`
   - `tokens_per_minute_exceeded`
   - `requests_per_minute_exceeded`
   - `overloaded`
   - `503 Service Unavailable`
   - `Retry-After` 响应头

---

### 2.2 输入契约

每一次 LLM 调用进入限流治理层时，应具备以下输入：

```ts
interface LlmRequestMeta {
  provider: string;
  modelId: string;
  apiKeyHash?: string;
  sessionId?: string;
  requestKind: "main" | "subagent" | "planner" | "aggregator" | "compaction" | "healthcheck";
  priority: "high" | "medium" | "low";
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  maxOutputTokens?: number;
  stream: boolean;
}
```

说明：

- `apiKeyHash` 只存 hash，不记录原始 API Key。
- `requestKind` 用于优先级调度和降级策略。
- `estimatedInputTokens` / `estimatedOutputTokens` 用于 TPM 控制。
- `priority` 决定排队时谁先执行。

---

### 2.3 核心状态机

一次请求的限流生命周期：

```text
Pending
  ↓
AcquirePermit
  ├─ 成功 → CallingProvider
  ├─ 队列满 → RejectedByLocalLimiter
  └─ 等待超时 → QueueTimeout

CallingProvider
  ├─ 成功 → Success
  ├─ 429/RPM/TPM → RateLimited
  ├─ overloaded/503 → ProviderOverloaded
  ├─ quota/auth/permission → NonRetryableFailure
  ├─ network/timeout → TransientFailure
  └─ unknown → UnknownFailure

RateLimited / ProviderOverloaded / TransientFailure
  ├─ 可重试且未超次数 → Backoff
  ├─ 连续失败达到阈值 → CircuitOpen
  ├─ 有 fallback → SwitchModel
  └─ 不可恢复 → Failed

Backoff
  ↓
AcquirePermit

SwitchModel
  ↓
AcquirePermit

CircuitOpen
  ├─ 主会话 → 提示用户 / 走备用模型
  ├─ subagent → 自动切恢复模型
  └─ 后台任务 → 延迟或取消
```

---

### 2.4 输出契约

限流治理层对上游输出统一结果：

```ts
type LlmGatewayResult<T> =
  | { ok: true; value: T; attempts: number; finalModel: ModelRef }
  | {
      ok: false;
      error: NormalizedLlmError;
      attempts: number;
      retryable: boolean;
      userMessage: string;
      suggestedAction?: "wait" | "switch_model" | "change_api_key" | "reduce_context" | "retry_later";
    };
```

前端/Agent Loop 需要拿到：

- 是否正在限流等待。
- 第几次重试。
- 还要等多久。
- 是否已切换模型。
- 是否需要用户处理，例如换 Key / 充值 / 降低上下文。

---

### 2.5 异常与边界

| 异常 | 处理原则 |
|---|---|
| `429 rate_limit_exceeded` | 可重试，优先使用 `Retry-After` |
| `tokens_per_minute_exceeded` | 可重试，但等待更久，并降低并发/上下文 |
| `requests_per_minute_exceeded` | 可重试，进入本地请求桶排队 |
| `insufficient_quota` | 不重试，提示额度不足 |
| `billing_hard_limit_reached` | 不重试，提示账单限制 |
| `401 invalid_api_key` | 不重试，提示 API Key 无效 |
| `403 permission_denied` | 不重试或切模型，提示权限不足 |
| `context_length_exceeded` | 不直接重试，先压缩/裁剪上下文 |
| `overloaded` / `503` | 可重试，连续失败后熔断 |
| 网络断联 | 可重试，已有内容较多时避免重复 |

---

### 2.6 非功能约束

1. **用户体验**
   - 限流时不能只显示“模型失败”。
   - 应显示：`服务商限流，正在等待 12 秒后重试…`。

2. **稳定性**
   - 不能因为多个请求同时重试导致重试风暴。
   - 必须加 jitter。

3. **成本控制**
   - 不可恢复错误不重试。
   - TPM 超限时应限制大上下文请求。

4. **安全**
   - 日志不能输出原始 API Key。
   - 只记录 provider/model/apiKeyHash。

5. **可观测性**
   - 需要记录按 provider/model 维度的限流次数、重试次数、熔断次数。

---

## 3. 架构设计

### 3.1 Agent Loop 选型

建议采用 **主 Agent Loop + LLM Gateway 限流治理层**。

对标范式：

- **Claude Code / Cursor**：主 loop 不直接处理所有 provider 差异，而是通过模型调用抽象层治理错误、上下文与恢复。
- **PI Agent**：保留现有 `DeerLoopEngine` 的事件契约，在 stream 调用外侧增加更强的策略层。

目标不是重写 Agent Loop，而是在现有调用路径前后增加：

```text
DeerLoopEngine
  → LlmGateway / RateLimitManager
  → pi-ai streamSimple / completeSimple
  → Provider
```

---

### 3.2 新增核心模块

建议新增目录：

```text
lib/llm-gateway/
  error-classifier.ts
  rate-limiter.ts
  retry-after.ts
  circuit-breaker.ts
  fallback-router.ts
  types.ts
  metrics.ts
```

#### 3.2.1 `error-classifier.ts`

负责把不同 provider 的错误统一成标准类型。

```ts
export type LlmErrorCode =
  | "RATE_LIMIT_REQUESTS"
  | "RATE_LIMIT_TOKENS"
  | "QUOTA_EXCEEDED"
  | "AUTH_ERROR"
  | "PERMISSION_DENIED"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "SERVER_OVERLOADED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "STREAM_INTERRUPTED"
  | "INVALID_REQUEST"
  | "CONTENT_FILTERED"
  | "UNKNOWN";

export interface NormalizedLlmError {
  code: LlmErrorCode;
  message: string;
  status?: number;
  retryAfterMs?: number;
  provider?: string;
  modelId?: string;
  retryable: boolean;
  rawType?: string;
}
```

分类规则示例：

| 匹配 | code | retryable |
|---|---|---:|
| HTTP 429 + requests | `RATE_LIMIT_REQUESTS` | true |
| HTTP 429 + tokens / TPM | `RATE_LIMIT_TOKENS` | true |
| `insufficient_quota` | `QUOTA_EXCEEDED` | false |
| HTTP 401 | `AUTH_ERROR` | false |
| HTTP 403 | `PERMISSION_DENIED` | false |
| `context_length_exceeded` | `CONTEXT_LENGTH_EXCEEDED` | false |
| `overloaded` | `SERVER_OVERLOADED` | true |
| HTTP 500/502/503/504 | `SERVER_ERROR` | true |
| `timeout` | `TIMEOUT` | true |

---

#### 3.2.2 `retry-after.ts`

负责解析响应头或错误对象里的等待时间。

```ts
export function parseRetryAfterMs(value: unknown): number | null {
  // 支持：
  // Retry-After: 12
  // Retry-After: Wed, 21 Oct 2015 07:28:00 GMT
  // x-ratelimit-reset-requests
  // x-ratelimit-reset-tokens
}
```

退避优先级：

```text
1. provider 明确 Retry-After
2. x-ratelimit-reset-* 推算
3. 错误分类默认等待
4. 指数退避 + jitter
```

---

#### 3.2.3 `rate-limiter.ts`

本地限流器，避免请求直接打爆 provider。

维度：

```text
bucketKey = provider + modelId + apiKeyHash
```

控制项：

```ts
interface RateLimitConfig {
  maxConcurrency: number;
  requestsPerMinute: number;
  tokensPerMinute?: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}
```

默认建议：

```ts
const DEFAULT_RATE_LIMIT_CONFIG = {
  maxConcurrency: 2,
  requestsPerMinute: 20,
  tokensPerMinute: 80_000,
  maxQueueSize: 100,
  queueTimeoutMs: 120_000,
};
```

排队优先级：

| priority | 请求类型 |
|---|---|
| high | 主会话用户请求、watchdog recover |
| medium | subagent worker |
| low | planner、aggregator、compaction |

---

#### 3.2.4 `circuit-breaker.ts`

provider/model 级熔断。

```ts
interface CircuitBreakerConfig {
  failureThreshold: number;
  openMs: number;
  halfOpenMaxProbe: number;
}
```

默认建议：

```ts
const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5,
  openMs: 60_000,
  halfOpenMaxProbe: 1,
};
```

触发熔断的错误：

- `RATE_LIMIT_REQUESTS`
- `RATE_LIMIT_TOKENS`
- `SERVER_OVERLOADED`
- `SERVER_ERROR`
- `TIMEOUT`
- `NETWORK_ERROR`

不触发熔断的错误：

- `AUTH_ERROR`
- `PERMISSION_DENIED`
- `QUOTA_EXCEEDED`
- `INVALID_REQUEST`
- `CONTEXT_LENGTH_EXCEEDED`

---

#### 3.2.5 `fallback-router.ts`

主会话 fallback router。

当前项目已有自动恢复模型配置，建议复用：

```text
models.json -> autoRecoveryModels
```

fallback 顺序：

```text
1. 当前模型按 Retry-After 等待后重试
2. 同 provider 小模型，若配置了
3. autoRecoveryModels[0]
4. autoRecoveryModels[1]
5. autoRecoveryModels[2]
6. 失败并提示用户
```

注意：主会话自动切模型需要显式事件通知前端：

```ts
{
  type: "model_fallback_start",
  from: { provider, modelId },
  to: { provider, modelId },
  reason: "RATE_LIMIT_REQUESTS"
}
```

---

### 3.3 与现有 DeerLoopEngine 集成

当前主路径：

```ts
const stream = this._streamFn(this._model, context, streamOptions);
```

建议演进为：

```ts
const stream = await llmGateway.stream({
  model: this._model,
  context,
  options: streamOptions,
  meta: {
    provider: this._model.provider,
    modelId: this._model.id,
    sessionId: this._sessionId,
    requestKind: "main",
    priority: "high",
    stream: true,
    estimatedInputTokens,
    estimatedOutputTokens,
  },
});
```

短期可以先不改 pi-ai `streamSimple`，而是在 `consumeStreamWithRetry` 中增强：

1. 捕获错误。
2. 调 `classifyLlmError`。
3. 如果是限流，使用 `retryAfterMs` 或指数退避。
4. 如果是不可重试，直接停止。
5. 通过现有 `auto_retry_start` 通知 UI。

---

## 4. 具体处置策略

### 4.1 429 / RPM 限流

处理流程：

```text
识别 429 / rate_limit_exceeded
  ↓
读取 Retry-After
  ↓
本地 bucket 降速
  ↓
等待 retryAfterMs + jitter
  ↓
重试
  ↓
连续失败 → 熔断 / fallback
```

用户提示：

```text
当前模型请求过快，服务商限流。将在 12 秒后自动重试。
```

---

### 4.2 TPM token 限流

处理流程：

```text
识别 tokens_per_minute_exceeded
  ↓
延长等待时间
  ↓
降低同 bucket 并发
  ↓
后续请求进入 token bucket 排队
  ↓
必要时建议压缩上下文
```

用户提示：

```text
当前模型 token 吞吐达到上限，正在等待额度恢复。建议减少上下文或稍后重试。
```

---

### 4.3 quota 额度耗尽

处理流程：

```text
识别 insufficient_quota / billing limit
  ↓
不重试
  ↓
提示用户更换 API Key / 充值 / 切模型
```

用户提示：

```text
当前 API Key 额度不足或账单达到上限，请更换 Key、充值，或切换其他模型。
```

---

### 4.4 provider overloaded

处理流程：

```text
识别 overloaded / 503
  ↓
短退避重试
  ↓
连续失败 → 熔断该 provider/model
  ↓
切 autoRecoveryModels
```

用户提示：

```text
当前模型服务繁忙，已尝试等待；如果仍失败，将切换备用模型继续。
```

---

### 4.5 上下文超限

处理流程：

```text
识别 context_length_exceeded
  ↓
不直接重试
  ↓
触发 compact / 裁剪工具输出 / 提示用户
```

用户提示：

```text
当前上下文超过模型窗口，请压缩会话或减少输入内容后重试。
```

---

## 5. 事件与前端展示

建议扩展事件：

```ts
type LlmThrottleEvent =
  | {
      type: "llm_throttle_wait";
      provider: string;
      modelId: string;
      reason: LlmErrorCode;
      delayMs: number;
      attempt: number;
      maxAttempts: number;
    }
  | {
      type: "llm_circuit_open";
      provider: string;
      modelId: string;
      reason: LlmErrorCode;
      openMs: number;
    }
  | {
      type: "model_fallback_start";
      from: { provider: string; modelId: string };
      to: { provider: string; modelId: string };
      reason: LlmErrorCode;
    };
```

也可以短期复用现有：

```ts
auto_retry_start.errorMessage
auto_retry_start.delayMs
```

但长期建议独立事件，避免前端无法区分普通网络重试和限流等待。

---

## 6. 可观测性指标

至少记录以下指标：

| 指标 | 维度 |
|---|---|
| `llm.requests.total` | provider, model, kind |
| `llm.requests.success` | provider, model, kind |
| `llm.errors.total` | provider, model, errorCode |
| `llm.rate_limited.total` | provider, model, limitType |
| `llm.retry.total` | provider, model, errorCode |
| `llm.retry.delay_ms` | provider, model |
| `llm.circuit.open.total` | provider, model |
| `llm.fallback.total` | fromProvider, fromModel, toProvider, toModel |
| `llm.queue.wait_ms` | provider, model, priority |
| `llm.tokens.estimated` | provider, model, kind |

本地桌面应用可以先用内存统计 + debug panel，不一定一开始接 Prometheus。

---

## 7. 分阶段落地 TODO

### P0：最小可用，优先解决频繁限流

#### TODO 1：新增统一错误分类

文件建议：

```text
lib/llm-gateway/types.ts
lib/llm-gateway/error-classifier.ts
```

验收标准：

- 能识别：429、quota、401、403、context length、overloaded、timeout、network。
- 单测覆盖常见错误字符串。
- 不可重试错误不会进入自动重试。

风险：

- provider 错误格式不统一，初期只能基于 message/status 正则。

---

#### TODO 2：支持 Retry-After + jitter

文件建议：

```text
lib/llm-gateway/retry-after.ts
lib/engine/retry-policy.ts
```

验收标准：

- 如果错误对象/headers 中包含 `Retry-After`，优先使用。
- 没有 Retry-After 时继续用现有 5s/10s/20s。
- 所有重试 delay 加入 jitter。

风险：

- 当前 pi-ai stream 抛出的错误对象是否带 headers 需要验证；没有 headers 时只能 fallback 到 message 分类。

---

#### TODO 3：前端明确展示限流等待

文件建议：

```text
hooks/useAgentSession.ts
components/ChatWindow.tsx
```

验收标准：

- 429 时显示：`服务商限流，正在等待 X 秒后重试`。
- quota/auth 错误显示明确处理建议。

风险：

- 现有 `retryInfo.errorMessage` 可能包含底层英文错误，需要转换为用户友好文案。

---

### P1：本地限流与队列

#### TODO 4：实现 provider/model/API Key 级并发限制

文件建议：

```text
lib/llm-gateway/rate-limiter.ts
```

第一版只做：

```ts
maxConcurrency: 2
maxQueueSize: 100
queueTimeoutMs: 120_000
```

验收标准：

- 同一 bucket 同时最多 N 个请求。
- 超过并发进入队列。
- 队列超限返回本地错误，不打 provider。

风险：

- stream 请求生命周期较长，需要确保完成/失败/abort 都能 release permit。

---

#### TODO 5：接入主会话 stream 调用

文件建议：

```text
lib/engine/deer-loop.ts
```

验收标准：

- `consumeStream` 发起 provider 调用前先 acquire permit。
- stream done/error/abort 后 release permit。
- 不改变现有 `message_start/update/end` 事件顺序。

风险：

- 若 release 处理不严谨，会造成 permit 泄漏，后续请求全部卡住。

---

#### TODO 6：接入 subagent / planner / aggregator

文件建议：

```text
lib/parallel-agent/llm-call.ts
lib/parallel-agent/subagent-runner.ts
```

验收标准：

- subagent worker 可按中优先级排队。
- planner / aggregator 可按低优先级排队，超时后走 fallback。

风险：

- 不能让低优先级任务阻塞主会话。

---

### P2：TPM token bucket

#### TODO 7：请求前 token 估算

文件建议：

```text
lib/llm-gateway/token-estimator.ts
```

验收标准：

- 使用现有 `estimateTokens` 思路先粗估。
- 每次请求消耗：`estimatedInputTokens + estimatedOutputTokens`。
- 超过 TPM 时排队等待。

风险：

- 粗估不准，但仍比完全没有控制更好。

---

#### TODO 8：上下文超限前置保护

文件建议：

```text
lib/engine/deer-loop.ts
```

验收标准：

- 请求前发现上下文使用率过高时，提示压缩。
- `context_length_exceeded` 不进入普通重试。

风险：

- 自动压缩可能改变上下文，需要用户可控。

---

### P3：熔断与 fallback router

#### TODO 9：provider/model 级熔断器

文件建议：

```text
lib/llm-gateway/circuit-breaker.ts
```

验收标准：

- 连续 5 次限流/过载后熔断 60s。
- 熔断期间请求不直接打 provider。
- 冷却后 half-open 放 1 个探测请求。

风险：

- 本地桌面多进程/多窗口状态不同步，第一版可只做进程内。

---

#### TODO 10：主会话 fallback router

文件建议：

```text
lib/llm-gateway/fallback-router.ts
lib/rpc-manager.ts
lib/engine/deer-loop.ts
```

验收标准：

- 当前模型多次限流失败后可切 `autoRecoveryModels`。
- 前端显示已切模型。
- 用户可关闭自动切模型。

风险：

- 主会话自动换模型会影响输出质量，需要明确提示。

---

## 8. 推荐优先级

最建议先做：

```text
P0-1 错误分类
P0-2 Retry-After + jitter
P0-3 限流友好提示
P1-4 provider/model 级 maxConcurrency
P1-5 主会话接入 limiter
```

原因：

- 成本低。
- 对频繁 429 改善最大。
- 不需要一开始就实现复杂 TPM 和熔断。

---

## 9. 回滚方案

每个能力都应支持开关：

```env
DEERHUX_LLM_GATEWAY_ENABLED=1
DEERHUX_LLM_RATE_LIMITER_ENABLED=1
DEERHUX_LLM_CIRCUIT_BREAKER_ENABLED=1
DEERHUX_LLM_FALLBACK_ENABLED=0
```

回滚策略：

1. 发现 limiter 卡死：关闭 `DEERHUX_LLM_RATE_LIMITER_ENABLED`。
2. 发现错误分类误判：关闭 gateway，回到原始 `DefaultRetryPolicy`。
3. 发现 fallback 输出质量不可控：关闭 `DEERHUX_LLM_FALLBACK_ENABLED`。
4. 发现熔断误伤：关闭 circuit breaker。

---

## 10. 最终目标效果

限流前：

```text
多个请求并发打 provider
→ provider 返回 429
→ 固定退避重试
→ 继续撞限流
→ 用户看到模型失败
```

限流后：

```text
请求进入本地 limiter
→ 超并发自动排队
→ provider 返回 429 时读取 Retry-After
→ 等待 + jitter
→ 连续失败则熔断/切备用模型
→ UI 显示明确状态
→ quota/auth 等不可重试错误直接提示用户处理
```

目标指标：

- 429 后最终成功率提升。
- 重试风暴减少。
- 用户感知从“模型失败”变成“限流等待/已切模型/需要换 Key”。
- subagent 并发导致主会话被限流的概率下降。
