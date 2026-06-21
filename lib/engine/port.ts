import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "@/lib/deerhux-types";

/**
 * AgentEnginePort —— DeerHux 与 Agent 引擎之间的稳定边界。
 *
 * 设计意图：把 DeerHux 对 pi SDK 的全部依赖（含 9 个私有字段 hack）收敛到这一个接口后面。
 * - M0 的唯一实现是 {@link PiEngineAdapter}（包 pi 的 AgentSession）。
 * - 后续 M1+ 会有 DeerLoopEngine（自研 loop）实现同一接口；那时下面的 hack 方法走公开
 *   state 字段，无需 hack。
 *
 * 本接口是 AgentSession 公开 API 的子集 —— 只包含 DeerHux 实际调用的成员。
 * 判断依据：`grep "this\.inner\." lib/rpc-manager.ts` 去重后共 27 个成员，全部已由
 * {@link AgentSessionLike} 定义。因此这里通过 `extends AgentSessionLike` 复用既有结构化
 * 类型，保证 wrapper 现有调用点零改动。
 *
 * 过渡暴露字段：`agent` / `sessionManager` / `settingsManager` / `modelRegistry` 继承自
 * AgentSessionLike。rpc-manager.ts 里有 40+ 处 `this.inner.agent.state.xxx`、20+ 处
 * `this.inner.sessionManager.xxx`，M0 不收敛这些访问（那是 M3/M6 的事），先用 getter 透传，
 * 保证编译通过、行为不变。后续里程碑再逐步内化。
 */
export interface AgentEnginePort extends AgentSessionLike {
  // ==========================================================================
  // ★ Hack 能力（M0 把 9 个 hack 收敛到这里）
  //
  // 这些方法在 PiEngineAdapter 里走私有字段 hack（行为与迁移前逐字一致），
  // 在未来的 DeerLoopEngine 里走公开 state 字段（无需 hack）。
  // 这就是 Port 的价值：把"裂缝"集中到一处，SDK 升级时只需改 adapter。
  // ==========================================================================

  /**
   * 设置持久 system prompt。消灭 H1。
   *
   * 同时写入 `agent.state.systemPrompt`（当前轮生效）和私有 `_baseSystemPrompt`
   * （后续每轮 prompt() 重置时的基准），否则下一轮会静默回退到内置 prompt。
   */
  setSystemPromptPersistent(prompt: string): void;

  /**
   * 应用工具执行模式（全局 sequential 开关 + 单工具 parallel/sequential 预设）。
   * 消灭 H5/H6/H7/H8。
   *
   * 模式表（read/grep/find/ls/code_search/spawn_subagent 并行，bash/edit/write 串行）
   * 与 `PI_DISABLE_PARALLEL_TOOLS` 开关的实现细节封装在 PiEngineAdapter 内部，
   * 保证迁移前后行为逐字一致。
   */
  applyToolExecutionModes(): void;

  /**
   * 安装自动重试加固。消灭 H2/H3/H4。
   *
   * - 抬高 `getRetrySettings().baseDelayMs` 下限（H2）
   * - 给 `_isRetryableError` 加“早夭流错误且已有有效内容则不重试”规则（H3）
   * - 给 `_prepareRetry` 加 settle 静默窗口（H4）
   *
   * 相关常量（最小延迟、错误正则、settle 毫秒）封装在 adapter 内部。
   */
  installRetryHardening(): void;

  /**
   * 运行时热替换自定义工具（MCP 工具集）。消灭 H9。
   *
   * 把对 pi 私有字段 `_customTools` / `_allowedToolNames` / `_refreshToolRegistry` 的
   * 直接操作收敛到 adapter；wrapper 只负责“哪些工具要保留 / 激活哪些”的编排决策。
   *
   * 不支持运行时重载的 AgentSession 会抛
   * "Current AgentSession does not support runtime MCP reload"（与迁移前一致）。
   */
  replaceCustomTools(options: {
    /**
     * 要从现有 _customTools 中移除的工具名（通常等于上一轮 MCP 工具名集合）。
     * 注意：任何 `mcp__` 前缀的工具都会被无条件移除，与迁移前行为一致。
     */
    removeNames: readonly string[];
    /** 追加的新自定义工具。 */
    addTools: ToolDefinition[];
    /** 需要加入 _allowedToolNames 白名单的工具名（仅当白名单非空时生效）。 */
    extraAllowedNames: readonly string[];
    /** 传给 _refreshToolRegistry 的激活工具名列表。 */
    activeToolNames: readonly string[];
  }): void;
}
