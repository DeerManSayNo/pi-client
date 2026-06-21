/**
 * DeerLoopEngine —— DeerHux 自研 Agent Loop 引擎（M1 最小骨架）。
 *
 * 设计文档 §四 / §六.M1 的产出。实现 {@link AgentEnginePort} 的最小子集：
 * - ✅ prompt() 流式（消费 pi-ai 的 AssistantMessageEventStream，转成 LoopEvent emit）
 * - ✅ abort() 中止当前 in-flight stream
 * - ✅ subscribe() / dispose() 事件订阅与释放
 * - ✅ 基本只读属性（sessionId / isStreaming / model / thinkingLevel ...）
 *
 * M1 不做：工具调用循环、工具注册、重试、steering/followUp 队列、session 持久化、
 * 压缩。这些方法按文档 §五 能力对齐表 throw "not implemented in M1"。
 *
 * ★ 关键依赖：复用 pi-ai 的 streamSimple（14+ provider 适配不动），DeerLoopEngine
 * 只负责 loop 编排与事件契约。streamFn 可注入，便于单测 mock。
 *
 * ★ 事件顺序契约（文档 §7.1）：严格
 *   agent_start → message_start → message_update*N → message_end → agent_end
 * abort 时：message_end{message.stopReason:"aborted"} → agent_end{willRetry:false}
 * 错误时：agent_end{error: message}
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentEnginePort } from "./port.ts";
import type { AgentMessage, LoopEvent } from "./loop-event.ts";
import { ToolRegistry, type AnyToolDefinition } from "./tool-registry.ts";
import { ToolExecutor, toPiAiTool, type ToolExecOutput } from "./tool-executor.ts";
import {
  createMinimalExtensionContext,
} from "./extension-context.ts";
import {
  DefaultRetryPolicy,
  getAssistantContentLength,
  type RetryPolicy,
} from "./retry-policy.ts";

/**
 * 不限定具体 Api 的 Model 类型别名。
 * pi-ai 的 Model<TApi extends Api> 要求一个 Api 类型实参；自研 loop 不关心具体 provider 的
 * Api 形状（交给 streamSimple 内部处理），这里用 Model<Api> 作为“任意 model”的类型。
 */
export type AnyModel = Model<Api>;

// ===========================================================================
// 类型定义
// ===========================================================================

/**
 * Stream 函数签名。默认用 pi-ai 的 streamSimple。
 * 抽象出来便于测试注入 mock（避免真实 LLM 调用）。
 */
export type StreamFn = (
  model: AnyModel,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * DeerLoopEngine 构造选项（文档 §4.5 的子集，M1 只保留流式必需字段）。
 */
export interface DeerLoopOptions {
  /** pi-ai 的 Model 实例。 */
  model: AnyModel;
  /** 初始系统提示词。 */
  systemPrompt?: string;
  /** 工作目录（sessionManager 代理的 getCwd 返回它）。 */
  cwd: string;
  /** 会话 id（透传给 provider 做 cache-aware；也用作 sessionId 属性）。 */
  sessionId?: string;
  /** 思考级别（pi-ai 的 ThinkingLevel，不含 "off"；off 时传 undefined）。 */
  thinkingLevel?: ThinkingLevel;
  /** ★ 可注入的 stream 函数，默认 streamSimple。测试用。 */
  streamFn?: StreamFn;
  /** API key 解析器（OAuth 短 token 用）。每次 LLM 调用前调。 */
  getApiKey?: (provider: string) => Promise<string | undefined>;

  // ─── M2：工具注册 ───────────────────────────────────────
  /** ★ 初始工具集（defineTool / createCodeGraphTools 等产物，直接喂给 registry）。 */
  tools?: AnyToolDefinition[];
  /** ★ 初始激活工具白名单（仅这些工具暴露给 LLM）。未传则激活全部已注册工具。 */
  activeToolNames?: string[];
  /** ★ 单工具 executionMode 覆盖表（消灭 H6/H7/H8）。 */
  toolExecutionModes?: Record<string, "sequential" | "parallel">;
  /** ★ 工具调用循环最大轮数（防 LLM 死循环；默认 20）。 */
  maxToolRounds?: number;
  /** ★ M4：注入自定义重试策略（测试用极小 delay/settle；不传则 installRetryHardening 时建 DefaultRetryPolicy）。 */
  retryPolicy?: RetryPolicy;
}

/** 标记当前处于未实现的里程碑路径抛出的错误。 */
function notImplemented(method: string, milestone: string): Error {
  return new Error(
    `DeerLoopEngine.${method}: not implemented (see ${milestone})`,
  );
}

/** ★ M2：工具调用循环最大轮数（防 LLM 无限调工具死循环）。与 pi 默认行为对齐。 */
const DEFAULT_MAX_TOOL_ROUNDS = 20;

/** consumeStream 的返回值（一轮 LLM 调用的状态快照）。 */
interface ConsumedStream {
  /** 本轮的最终 AssistantMessage（done/error 的 message 或 lastPartial 或合成）。 */
  endMessage: AssistantMessage;
  /** 是否已 emit 过 message_start（用于补发逻辑）。 */
  started: boolean;
  /** 是否被 abort。 */
  aborted: boolean;
  /** 错误消息（非 abort）。 */
  errorMessage: string | undefined;
  /** stream 的 stopReason（done.reason 或 error.reason）。 */
  stopReason: string | undefined;
}

/**
 * ★ M2：内置工具默认执行模式表（与 PiEngineAdapter.TOOL_EXECUTION_MODES 对齐）。
 *
 * read/grep/find/ls/code_search/spawn_subagent = parallel（无副作用，可并发）。
 * bash/edit/write = sequential（有副作用，必须串行防竞态）。
 *
 * 这是应用层预设，rpc-manager 调 applyToolExecutionModes() 时写入 registry 覆盖表。
 * 自定义工具（codegraph_* / mcp__*）自带 executionMode 字段，不在这里枚举。
 */
const DEFAULT_TOOL_EXECUTION_MODES: Record<string, "parallel" | "sequential"> = {
  read: "parallel",
  grep: "parallel",
  find: "parallel",
  ls: "parallel",
  code_search: "parallel",
  spawn_subagent: "parallel",
  bash: "sequential",
  edit: "sequential",
  write: "sequential",
};

// ===========================================================================
// DeerLoopEngine
// ===========================================================================

/**
 * 自研 Agent Loop 引擎（M1 最小骨架）。
 *
 * 一个实例 = 一个会话上下文（transcript + systemPrompt + model）。
 * 不持有 pi 的 AgentSession / SessionManager / SettingsManager——这些在 M1
 * 灰度路径上要么不需要（get_state/prompt），要么由 wrapper 层用最小代理满足类型。
 */
export class DeerLoopEngine implements AgentEnginePort {
  /** 事件订阅者集合。emit 时遍历调用。 */
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  /** 当前 in-flight stream 的 AbortController。null 表示空闲。 */
  private abortController: AbortController | null = null;

  /** loop 级运行标记：agent_start → agent_end 之间为 true。 */
  private _isRunning = false;

  /** LLM 流式输出标记：仅在 stream for-await 期间为 true。 */
  private _isStreaming = false;

  /** 会话 transcript（pi-ai Message[]，= AgentMessage[]）。 */
  private readonly _messages: AgentMessage[] = [];

  /** 持久系统提示词（loop 自持，天然免疫 H1——见 {@link DeerLoopEngine#setSystemPromptPersistent}）。
   *
   *  M3 已验证（scripts/test-system-prompt-persistence.mjs）：每轮 consumeStream
   *  都读这里的值构建 context，且不被任何外部逻辑重置（pi 的 _baseSystemPrompt
   *  私有字段覆盖 bug 在自研 loop 路径上不存在）。 */
  private _baseSystemPrompt: string;

  /** 当前思考级别（pi-ai ThinkingLevel | undefined）。 */
  private _thinkingLevel: ThinkingLevel | undefined;

  /** 当前模型。 */
  private readonly _model: AnyModel;

  /** stream 函数（默认 streamSimple，可注入）。 */
  private readonly _streamFn: StreamFn;

  /** 会话 id。 */
  private readonly _sessionId: string;

  /** 工作目录。 */
  private readonly _cwd: string;

  /** API key 解析器。 */
  private readonly _getApiKey?: (provider: string) => Promise<string | undefined>;

  /** ★ M2：工具注册表（单一数据源，消灭 pi 三份副本）。 */
  private readonly registry: ToolRegistry;

  /** ★ M2：工具执行器（并行/串行调度 + 错误隔离）。 */
  private readonly toolExecutor: ToolExecutor;

  /** ★ M2：工具调用循环最大轮数（防 LLM 死循环）。 */
  private readonly _maxToolRounds: number;

  /** ★ M4：当前重试策略（null = 未安装，不重试）。
   *
   *  installRetryHardening() 安装 DefaultRetryPolicy（封装 H2/H3/H4）。
   *  自研 loop 不再依赖 pi 的 `_isRetryableError` / `_prepareRetry` / `getRetrySettings`
   *  三处私有 hack——重试判定与退避全部在 RetryPolicy 里，由 consumeStreamWithRetry 驱动。 */
  private _retryPolicy: RetryPolicy | null = null;

  /** ★ M4：是否启用自动重试。installRetryHardening 后默认 true；setAutoRetryEnabled 可运行时关闭。 */
  private _autoRetryEnabled = false;

  /**
   * agent.state 的最小代理对象。
   *
   * Port 接口要求 `agent: { state?: { systemPrompt?; thinkingLevel? } }`。
   * wrapper 构造时会读 agent.state.systemPrompt，applyRolePrompt 会写。
   * get_state 命令也读这两个字段。这里维护一个真实的最小 state 对象。
   */
  private readonly _agentState: {
    systemPrompt: string;
    thinkingLevel: string;
  };

  constructor(options: DeerLoopOptions) {
    if (!options?.model) {
      throw new Error("DeerLoopEngine: options.model is required");
    }
    if (!options?.cwd) {
      throw new Error("DeerLoopEngine: options.cwd is required");
    }
    this._model = options.model;
    this._cwd = options.cwd;
    this._sessionId = options.sessionId ?? `deer-loop-${Date.now()}`;
    this._baseSystemPrompt = options.systemPrompt ?? "";
    this._thinkingLevel = options.thinkingLevel;
    this._streamFn = options.streamFn ?? defaultStreamFn;
    this._getApiKey = options.getApiKey;
    this._agentState = {
      systemPrompt: this._baseSystemPrompt,
      thinkingLevel: this._thinkingLevel ?? "off",
    };

    // M2：初始化工具注册表与执行器。
    this.registry = new ToolRegistry();
    this.toolExecutor = new ToolExecutor(this.registry);
    this._maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    // M4：可选注入自定义重试策略（测试用极小 delay/settle）。未传时为 null，
    // 等 installRetryHardening() 安装 DefaultRetryPolicy（生产路径）。
    if (options.retryPolicy) {
      this._retryPolicy = options.retryPolicy;
      this._autoRetryEnabled = true;
    }
    if (options.tools && options.tools.length > 0) {
      this.registry.registerAll(options.tools);
      // 未传 activeToolNames 时激活全部已注册工具（方便灰度：传工具即启用）。
      if (options.activeToolNames !== undefined) {
        this.registry.setActive(options.activeToolNames);
      } else {
        this.registry.setActive(options.tools.map((t) => t.name));
      }
    }
    if (options.toolExecutionModes) {
      this.registry.setExecutionModes(options.toolExecutionModes);
    }
  }

  // -------------------------------------------------------------------------
  // ★ M1 核心方法：prompt 流式
  // -------------------------------------------------------------------------

  /**
   * 发起一轮 prompt。消费 pi-ai 的 AssistantMessageEventStream，转成 LoopEvent emit。
   *
   * ★ M2 改造为工具调用循环（设计文档 §4「核心实现要点」#3）：
   *   while (true) {
   *     consume stream → 得到 finalMessage + stopReason
   *     abort/error → emit message_end + agent_end, break
   *     push assistant message to transcript
   *     if (stopReason !== toolUse || 无 toolCall) → emit message_end, break
   *     emit message_end（本轮 assistant 结束）
   *     executeBatch(toolCalls) → emit tool_execution_*
   *     abort 期間 → break
   *     push ToolResultMessage × N to transcript
   *     continue（下一轮 LLM 看到工具结果）
   *   }
   *
   * 事件顺序（单轮无工具）：
   *   agent_start → message_start → message_update*N → message_end → agent_end
   * 事件顺序（一轮有工具，工具后不再调）：
   *   agent_start → message_start → message_update*N → message_end
   *     → tool_execution_start → tool_execution_update? → tool_execution_end(×N)
   *     → message_start(第二轮) → ... → message_end → agent_end
   *
   * abort 行为：stream 或工具执行期间 abort，发 message_end{stopReason:"aborted"}
   * + agent_end{willRetry:false}。
   * 错误行为：stream 抛非 abort 错误，发 message_end{stopReason:"error"} +
   * agent_end{error}。工具执行错误被错误隔离（不中断 loop，结果回填给 LLM）。
   * 防死循环：连续 maxToolRounds 轮仍要工具 → 强制 break + agent_end{error}。
   */
  async prompt(
    text: string,
    options?: {
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
    },
  ): Promise<void> {
    if (this._isRunning) {
      throw new Error(
        "DeerLoopEngine.prompt: a prompt is already running (不支持并发 prompt)",
      );
    }

    // 1. 把用户输入包成 UserMessage，追加到 transcript。
    const userContent = this.buildUserContent(text, options?.images);
    const userMessage: UserMessage = {
      role: "user",
      content: userContent,
      timestamp: Date.now(),
    };
    this._messages.push(userMessage);

    // 2. 进入 running 态，发射 agent_start。
    this._isRunning = true;
    this.abortController = new AbortController();
    this.emit({ type: "agent_start" });

    let agentError: string | undefined; // 记录 agent_end 携带的错误消息

    try {
      let toolRounds = 0;
      // ★ 工具调用循环：每轮 consume stream → 判断 toolUse → 执行工具 → 回填 → 继续。
      while (true) {
        // ★ M3 持久性关键：Context 在 while 循环【内】每轮重新构造，
        //   systemPrompt 直接读 this._baseSystemPrompt（不缓存到循环外）。
        //   因此 setSystemPromptPersistent 的修改从下一轮 consumeStream 立即生效，
        //   且连发 N 个 prompt 值恒定不变（免疫 H1）。
        //   见 scripts/test-system-prompt-persistence.mjs 用例 1/2。
        const activeTools = this.registry.getActive();
        const context: Context = {
          systemPrompt: this._baseSystemPrompt || undefined,
          messages: this._messages as Message[],
          ...(activeTools.length > 0
            ? { tools: activeTools.map(toPiAiTool) }
            : {}),
        };

        // ★ M4：消费 stream（带重试）。失败时 consumeStreamWithRetry 内部判定是否重试，
        //   并发射 auto_retry_start/end + agent_end{willRetry:true} 事件。
        //   返回的 consumed 是【最终结果】（成功 / abort / 不可重试错误 / 全部重试失败）。
        const consumed = await this.consumeStreamWithRetry(context);

        // abort / error：收尾后跳出循环。
        if (consumed.aborted || consumed.errorMessage) {
          this.emitMessageStartIfNeeded(consumed);
          this.emit({ type: "message_end", message: consumed.endMessage });
          this._messages.push(consumed.endMessage);
          if (consumed.errorMessage) agentError = consumed.errorMessage;
          break;
        }

        // 把本轮 assistant 最终消息追加到 transcript。
        const assistantMessage = consumed.endMessage;
        this._messages.push(assistantMessage);

        // ★ 提取本轮的 ToolCall（源序）。
        const toolCalls = assistantMessage.content.filter(
          (c): c is ToolCall => c.type === "toolCall",
        );

        // ★ 保守判断进工具循环（踩坑预警 #1）：
        //   stopReason === "toolUse" 或 content 含 toolCall 即进。
        const wantsTools =
          consumed.stopReason === "toolUse" || toolCalls.length > 0;

        if (!wantsTools || toolCalls.length === 0) {
          // LLM 不再要工具 → 正常结束（emit message_end 后跳出循环）。
          this.emitMessageStartIfNeeded(consumed);
          this.emit({ type: "message_end", message: assistantMessage });
          break;
        }

        // 有 toolCall：本轮 assistant 消息结束（emit message_end），接下来是工具执行。
        this.emitMessageStartIfNeeded(consumed);
        this.emit({ type: "message_end", message: assistantMessage });

        // 防死循环：超过 maxToolRounds 强制停。
        toolRounds++;
        if (toolRounds > this._maxToolRounds) {
          agentError = `DeerLoopEngine: 超过最大工具调用轮数（${this._maxToolRounds}），强制停止`;
          break;
        }

        // 构造 ExtensionContext + 执行工具。
        const ctx = this.buildExtensionContext();
        const outputs = await this.toolExecutor.executeBatch(
          toolCalls,
          this.abortController!.signal,
          ctx,
          (e) => this.emit(e),
        );

        // abort 发生在工具执行期间：回填已有结果后跳出。
        if (this.abortController?.signal.aborted) {
          const toolResults = this.buildToolResultMessages(toolCalls, outputs);
          this._messages.push(...toolResults);
          agentError = "aborted";
          break;
        }

        // 构造 ToolResultMessage × N 入 transcript（源序，对齐 toolCalls）。
        const toolResults = this.buildToolResultMessages(toolCalls, outputs);
        this._messages.push(...toolResults);

        // 继续下一轮 LLM 调用（while true 顶部重新构造 context，此时 transcript
        // 已含工具结果，LLM 会看到）。
      }
    } catch (err) {
      // 兜底：循环内不应抛（abort/error 已在 consumeStream/executeBatch 内部隔离），
      // 这里只防未预期异常。
      if (this.isAbortError(err)) {
        agentError = "aborted";
      } else {
        agentError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this._isStreaming = false;
      this._isRunning = false;
      this.abortController = null;

      const agentEndEvent: LoopEvent = {
        type: "agent_end",
        messages: [...this._messages],
        willRetry: false,
      };
      if (agentError && agentError !== "aborted") {
        (agentEndEvent as { error?: string }).error = agentError;
      }
      this.emit(agentEndEvent);
    }
  }

  // -------------------------------------------------------------------------
  // ★ M2：stream 消费 + 工具循环辅助方法
  // -------------------------------------------------------------------------

  /**
   * 消费一轮 stream：构造 SimpleStreamOptions → for-await → 跟踪状态 → 返回快照。
   *
   * 把 M1 内联在 prompt 里的流式逻辑提取成独立方法，让 prompt 主循环只管
   * 「消费 → 判断 toolUse → 执行工具 → 回填 → 继续」。
   *
   * emit：message_start（首个 partial 时）、message_update（每个 partial）。
   * **不** emit message_end（交给调用方决定，因为 abort/error/toolUse 的收尾时机不同）。
   */
  private async consumeStream(context: Context): Promise<ConsumedStream> {
    this._isStreaming = true;

    let started = false;
    let lastPartial: AssistantMessage | null = null;
    let finalMessage: AssistantMessage | null = null;
    let aborted = false;
    let errorMessage: string | undefined;
    let stopReason: string | undefined;

    try {
      const streamOptions: SimpleStreamOptions = {
        signal: this.abortController!.signal,
        sessionId: this._sessionId,
      };
      if (this._thinkingLevel) {
        streamOptions.reasoning = this._thinkingLevel;
      }
      if (this._getApiKey) {
        // pi-ai 的 SimpleStreamOptions 有 apiKey 字段（同步），而我们持有的是
        // 异步 getApiKey(provider)。在调 stream 前先解析一次（与 pi-agent-core 的
        // AgentLoopConfig.getApiKey 行为一致：每次 LLM 调用前解析）。
        const provider = this._model.provider;
        const apiKey = await this._getApiKey(provider);
        if (apiKey) streamOptions.apiKey = apiKey;
      }

      const stream = this._streamFn(this._model, context, streamOptions);

      for await (const ev of stream) {
        // abort 检查：即便 stream 没抛，也主动退出。
        if (this.abortController?.signal.aborted) {
          aborted = true;
          break;
        }

        if (ev.type === "done") {
          finalMessage = ev.message;
          stopReason = ev.reason;
          break;
        }

        if (ev.type === "error") {
          // stream 显式报告错误（含 aborted）。
          if (ev.reason === "aborted") {
            aborted = true;
          } else {
            errorMessage = ev.error.errorMessage ?? ev.reason;
          }
          // ★ 优先保留已生成的 partial 内容（H3 判定需要 contentLength）。
          //   ev.error 通常是空 content 的错误壳；若 lastPartial 有内容，用它
          //   并注入 errorMessage，避免丢弃 LLM 已产出的有效内容。
          finalMessage = lastPartial ?? ev.error;
          stopReason = ev.reason;
          break;
        }

        // start / text_* / thinking_* / toolcall_* 事件：partial 是累计 AssistantMessage。
        lastPartial = ev.partial;
        if (!started) {
          started = true;
          this.emit({ type: "message_start", message: ev.partial });
        }
        this.emit({
          type: "message_update",
          message: ev.partial,
          assistantMessageEvent: ev,
        });
      }
    } catch (err) {
      // abort 导致的抛错：标记为 aborted；其他视为错误。
      if (this.isAbortError(err)) {
        aborted = true;
      } else {
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this._isStreaming = false;
    }

    const endMessage = this.resolveEndMessage(
      finalMessage,
      lastPartial,
      aborted,
      errorMessage,
    );

    return { endMessage, started, aborted, errorMessage, stopReason };
  }

  /**
   * 若 consumeStream 未 emit message_start（stream 立即结束/出错/abort），补一次。
   * 保证 message_start / message_end 严格成对。
   */
  private emitMessageStartIfNeeded(consumed: ConsumedStream): void {
    if (!consumed.started) {
      this.emit({ type: "message_start", message: consumed.endMessage });
    }
  }

  // -------------------------------------------------------------------------
  // ★ M4：重试循环（封装 H2/H3/H4）
  // -------------------------------------------------------------------------

  /**
   * 带重试的 stream 消费（M4 核心）。
   *
   * 在 {@link consumeStream} 外层包一个重试循环。失败时调 {@link RetryPolicy.isRetryable}
   * 判定是否重试，并发射 `auto_retry_start` / `auto_retry_end` 事件。
   *
   * 事件顺序契约（设计文档 §7.1 + wrapper rpc-manager.ts:666-688）：
   *
   * 首轮失败 + 可重试：
   * ```
   *   message_start → message_update*N → message_end (失败)
   *   → agent_end{willRetry:true}
   *   → auto_retry_start{attempt, delayMs, errorMessage}
   *   → (sleep settleMs + delayMs，可被 abort 打断)
   *   → message_start → ... (重试)
   * ```
   *
   * 重试后成功：
   * ```
   *   → message_end (成功) → auto_retry_end{success:true, attempt}
   * ```
   *
   * 全部重试失败 / 不可重试：
   * ```
   *   → auto_retry_end{success:false, attempt, finalError}
   * ```
   *
   * abort 打断 sleep：
   * ```
   *   → auto_retry_end{success:false, attempt, finalError:"aborted"}
   * ```
   *
   * ★ 重试与工具循环的交互：本方法只管 consumeStream 的重试，与外层工具循环解耦。
   *   如果失败发生在工具执行后、第二轮 consumeStream——此时 transcript 已含 toolResult，
   *   重试第二轮会带上工具结果，这是合理的。工具执行本身的错误不重试（M2 错误隔离已做）。
   *
   * ★ transcript 处理：失败轮次的 assistant message 【不】入 transcript（重试是"假装上一轮
   *   没发生"，否则 LLM 会看到自己的失败消息）。只有最终结果由调用方 push。
   *
   * @returns 最终的 ConsumedStream（成功 / abort / 不可重试错误 / 全部重试失败）。
   *          失败轮次的 message 事件已在本方法内 emit；调用方只需处理最终结果。
   */
  private async consumeStreamWithRetry(context: Context): Promise<ConsumedStream> {
    let retryCount = 0; // 已完成的重试次数（0 = 初始尝试，未重试过）

    while (true) {
      const consumed = await this.consumeStream(context);

      // 成功或 abort：不重试。如果之前重试过且现在成功，补发 auto_retry_end{success:true}。
      if (!consumed.errorMessage || consumed.aborted) {
        if (retryCount > 0 && !consumed.aborted) {
          this.emit({
            type: "auto_retry_end",
            success: true,
            attempt: retryCount,
          });
        }
        return consumed;
      }

      // 错误：检查是否可重试
      const policy = this._retryPolicy;
      if (!policy || !this._autoRetryEnabled) {
        return consumed; // 未安装策略或运行时关闭 → 不重试
      }

      const nextAttempt = retryCount + 1; // 1-indexed：第一次重试 attempt=1
      const contentLength = getAssistantContentLength(consumed.endMessage);
      const decision = policy.isRetryable({
        attempt: nextAttempt,
        errorMessage: consumed.errorMessage,
        partialMessage: consumed.endMessage,
        contentLength,
      });

      // 不可重试或超过 maxAttempts
      if (!decision.retry || nextAttempt > policy.maxAttempts) {
        if (retryCount > 0) {
          // 之前重试过但最终失败：补发 auto_retry_end{success:false}
          this.emit({
            type: "auto_retry_end",
            success: false,
            attempt: retryCount,
            finalError: consumed.errorMessage,
          });
        }
        return consumed;
      }

      // ★ 可重试：发射失败轮次的收尾事件
      // message_start（若 consumeStream 未发）+ message_end（失败轮次）
      this.emitMessageStartIfNeeded(consumed);
      this.emit({ type: "message_end", message: consumed.endMessage });

      // agent_end{willRetry:true}：告诉前端/ wrapper 本轮失败但会重试（保持 _isRunning=true）
      this.emit({
        type: "agent_end",
        messages: [...this._messages],
        willRetry: true,
      });

      // auto_retry_start：通知前端开始重试
      this.emit({
        type: "auto_retry_start",
        attempt: nextAttempt,
        maxAttempts: policy.maxAttempts,
        delayMs: decision.delayMs,
        errorMessage: consumed.errorMessage,
      });

      // ★ H4（settleMs）+ H2（delayMs）sleep。可被 abort 打断。
      await this.sleepInterruptible(policy.getSettleMs() + decision.delayMs);

      // abort 打断 sleep：立即停止重试
      if (this.abortController?.signal.aborted) {
        this.emit({
          type: "auto_retry_end",
          success: false,
          attempt: nextAttempt,
          finalError: "aborted",
        });
        return { ...consumed, aborted: true, errorMessage: undefined };
      }

      retryCount = nextAttempt;
      // 继续循环 → 重新 consumeStream（重试）
    }
  }

  /**
   * 可被 abort 打断的 sleep（M4 关键：abort 优先于 retry）。
   *
   * - 若 abortController 已 aborted，立即 resolve。
   * - 否则设一个 timer，同时监听 abort 信号；任一触发即 resolve。
   *
   * 这保证重试 sleep 期间用户点"停止"能立即生效（不等完 delayMs）。
   */
  private async sleepInterruptible(ms: number): Promise<void> {
    const controller = this.abortController;
    if (!controller) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    const signal = controller.signal;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /**
   * 构造工具 execute 第 5 参用的 MinimalExtensionContext。
   *
   * 复用 loop 的最小代理（sessionManager / modelRegistry）与状态（cwd / model /
   * abortController / _isStreaming）。signal 必非空（工具执行期间在 prompt 调用，
   * abortController 已创建）。
   */
  private buildExtensionContext(): import("./extension-context.ts").ExtensionContext {
    const signal = this.abortController?.signal;
    if (!signal) {
      // 理论上不会发生（buildExtensionContext 只在 prompt 内调，abortController 非空）。
      throw new Error(
        "DeerLoopEngine.buildExtensionContext: abortController.signal 不可用（不在 prompt 执行期间）",
      );
    }
    return createMinimalExtensionContext({
      cwd: this._cwd,
      model: this._model,
      signal,
      abort: () => {
        void this.abort();
      },
      isIdle: () => !this._isStreaming && !this._isRunning,
      getSystemPrompt: () => this._baseSystemPrompt,
      sessionManager: this.sessionManager,
      modelRegistry: this.modelRegistry,
    });
  }

  /**
   * 构造 ToolResultMessage × N（每个 toolCall 一条，源序）。
   *
   * pi-ai 的 ToolResultMessage（types.d.ts:203）：
   *   { role: "toolResult", toolCallId, toolName, content, details?, isError, timestamp }
   * ★ role 是 "toolResult"（不是 "tool"），每个 toolCall 一条独立消息。
   * content 从 AgentToolResult.content 透传（[TextContent | ImageContent]）。
   */
  private buildToolResultMessages(
    toolCalls: readonly ToolCall[],
    outputs: readonly ToolExecOutput[],
  ): ToolResultMessage[] {
    const now = Date.now();
    return toolCalls.map((call, i) => {
      const output = outputs[i];
      const content = (output?.result?.content ?? [
        { type: "text" as const, text: "(no result)" },
      ]) as ToolResultMessage["content"];
      return {
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: call.name,
        content,
        isError: output?.isError ?? false,
        timestamp: now,
      } satisfies ToolResultMessage;
    });
  }

  // -------------------------------------------------------------------------
  // ★ M1 核心方法：abort
  // -------------------------------------------------------------------------

  /**
   * 中止当前 in-flight stream。
   *
   * 立即触发 abortController.abort()；返回的 promise 在 prompt 的 try/finally
   * 跑完（agent_end 已 emit、_isRunning 归零）后 resolve。
   *
   * 若当前没有运行中的 prompt，直接 resolve（幂等）。
   */
  async abort(): Promise<void> {
    const controller = this.abortController;
    if (!controller || this._isRunning === false) {
      return;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
    // 等待 prompt 主循环感知到 abort 并完成收尾。
    // 用微轮询等待 _isRunning 翻转（M1 简单实现；不引入额外 promise 状态机）。
    await this.waitForIdle();
  }

  // -------------------------------------------------------------------------
  // ★ M1 核心方法：subscribe / dispose
  // -------------------------------------------------------------------------

  /**
   * 订阅 LoopEvent。返回取消订阅函数。
   * listener 签名按 Port 契约声明为 AgentSessionEvent（与 pi 兼容），
   * DeerLoopEngine emit 的 LoopEvent 对象结构兼容，透传安全。
   */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 释放底层资源：中止运行 + 清空监听。之后再调 prompt 行为未定义（M1 不做重启保护）。
   */
  dispose(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // 只读属性
  // -------------------------------------------------------------------------

  get sessionId(): string {
    return this._sessionId;
  }

  /** M1 不持久化：返回 undefined。 */
  get sessionFile(): string | undefined {
    return undefined;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get isCompacting(): boolean {
    return false;
  }

  get autoCompactionEnabled(): boolean {
    return false;
  }

  /** ★ M4：返回真实重试状态（installRetryHardening 后为 true）。 */
  get autoRetryEnabled(): boolean {
    return this._autoRetryEnabled;
  }

  get model(): AnyModel {
    return this._model;
  }

  get thinkingLevel(): ThinkingLevel | undefined {
    return this._thinkingLevel;
  }

  /**
   * agent.state 代理（Port 过渡字段）。
   *
   * wrapper 构造时读 agent.state.systemPrompt；get_state 读 systemPrompt + thinkingLevel。
   * 返回内部维护的最小 state 对象（真实值，非 mock）。
   */
  get agent(): { state: { systemPrompt: string; thinkingLevel: string } } {
    return { state: this._agentState };
  }

  /**
   * sessionManager 代理（Port 过渡字段）。
   *
   * wrapper 构造时 applyRolePrompt 会调 sessionManager.getCwd()；
   * 多处读 isPersisted() / appendCustomEntry()。M1 不做 session 持久化，
   * 提供最小代理满足这些调用（getCwd 返回 cwd，isPersisted 返回 false，
   * appendCustomEntry 返回占位 id）。其他方法（getBranch/fork 等）被调时 throw。
   */
  get sessionManager(): import("@earendil-works/pi-coding-agent").SessionManager {
    return createMinimalSessionManager(this._cwd);
  }

  /**
   * settingsManager 代理（Port 过渡字段）。
   *
   * M1 灰度路径不读 settingsManager（compact/retry 命令不走）。提供最小代理
   * 满足 Port 类型；getCompactionSettings 返回默认值。
   */
  get settingsManager(): import("@earendil-works/pi-coding-agent").SettingsManager {
    return createMinimalSettingsManager();
  }

  /**
   * modelRegistry 代理（Port 过渡字段）。
   *
   * M1 灰度路径不读 modelRegistry（set_model/recover 不走）。提供最小代理
   * 满足 Port 类型；find 返回 undefined。
   */
  get modelRegistry(): {
    find: (provider: string, modelId: string) => AnyModel | undefined;
  } {
    return {
      find: () => undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Hack 方法（Port 要求，M1 最小/空实现）
  // -------------------------------------------------------------------------

  /**
   * 设置持久 system prompt（Port hack 方法，消灭 H1）。
   *
   * ★ M3 验证结论（scripts/test-system-prompt-persistence.mjs +
   *   scripts/test-turn-context-block.mjs 全过）：
   *   1. 持久性：连发 N 个 prompt，每轮 consumeStream 构建的
   *      context.systemPrompt 都等于这里写入的值（不被重置）——因为
   *      DeerLoopEngine 自持 _baseSystemPrompt，没有 pi 那种「外部
   *      _rebuildSystemPrompt 把 state.systemPrompt 覆盖回私有字段」的问题。
   *   2. agent.state 同步：_agentState.systemPrompt 与 _baseSystemPrompt
   *      双写，wrapper 读 this.inner.agent.state.systemPrompt 永远拿到最新值。
   *   3. turn_context 责任分工：本方法是【纯透传】——set 什么，context 就用什么。
   *      它【不】自动 stripTurnContextBlock（DeerLoopEngine 不知道 turn_context
   *      是什么）。strip 是 wrapper 的职责（rpc-manager.ts 的 stripTurnContextBlock
   *      + applyRolePrompt + withTemporarySystemPrompt.finally）。这样保持语义
   *      单一：wrapper 全权决定 prompt 内容，loop 只负责「值精确透传 + 持久」。
   *      若这里加防御性 strip，会与 wrapper 的 strip 重叠且改变 set 的语义（set X
   *      不一定得 X），故【刻意不加】。
   *
   * 不能 throw——wrapper 构造时 applyRolePrompt 会立即调用。
   */
  setSystemPromptPersistent(prompt: string): void {
    this._baseSystemPrompt = prompt;
    this._agentState.systemPrompt = prompt;
  }

  /**
   * 应用工具执行模式（Port hack 方法，消灭 H5/H6/H7/H8）。★ M2 真正实现。
   *
   * 对齐 PiEngineAdapter 的逻辑：
   * - PI_DISABLE_PARALLEL_TOOLS=1 时，全局默认设为 sequential（H5）。
   * - 按 DEFAULT_TOOL_EXECUTION_MODES 表为内置工具设 sequential/parallel（H6/H7/H8）。
   *
   * DeerLoopEngine 只有一份 registry，写入即生效，无需三处同步。
   */
  applyToolExecutionModes(): void {
    const forceSequential =
      process.env.PI_DISABLE_PARALLEL_TOOLS === "1" ||
      process.env.PI_DISABLE_PARALLEL_TOOLS === "true";
    if (forceSequential) {
      this.registry.setDefaultExecutionMode("sequential");
    }
    // 为已注册的内置工具应用预设 mode（仅当表里有该工具名时）。
    for (const tool of this.registry.getAll()) {
      const mode = DEFAULT_TOOL_EXECUTION_MODES[tool.name];
      if (mode) {
        this.registry.setExecutionMode(tool.name, mode);
      } else if (forceSequential) {
        // 未在表里的工具，强制串行时也设 sequential。
        this.registry.setExecutionMode(tool.name, "sequential");
      }
    }
  }

  /**
   * 安装自动重试加固（Port hack 方法，消灭 H2/H3/H4）。★ M4 真正实现。
   *
   * pi 路径（PiEngineAdapter）里这是三处私有字段 hack（getRetrySettings /
   * _isRetryableError / _prepareRetry）。自研 loop 不需要 hack——直接安装
   * {@link DefaultRetryPolicy}，重试判定与退避全部走公开接口。
   *
   * 安装后 `_autoRetryEnabled` 默认 true（与 pi 行为一致）。可用
   * {@link setAutoRetryEnabled} 运行时关闭。
   *
   * 重复调用幂等：重新安装会覆盖旧策略（便于运行时换策略）。
   */
  installRetryHardening(): void {
    this._retryPolicy = new DefaultRetryPolicy();
    this._autoRetryEnabled = true;
  }

  /**
   * 运行时热替换自定义工具（Port hack 方法，消灭 H9）。★ M2 实现。
   *
   * 原子操作：register+unregister+setActive 一次完成。对应 rpc-manager.installMcpRuntime
   * 里对 pi 私有字段 _customTools / _allowedToolNames / _refreshToolRegistry 的操作。
   * DeerLoopEngine 走公开 registry.replaceBatch，无中间态。
   */
  replaceCustomTools(options: {
    removeNames: readonly string[];
    addTools: ToolDefinition[];
    extraAllowedNames: readonly string[];
    activeToolNames: readonly string[];
  }): void {
    this.registry.replaceBatch({
      removeNames: options.removeNames,
      addTools: options.addTools as AnyToolDefinition[],
      activeToolNames: options.activeToolNames,
      extraAllowedNames: options.extraAllowedNames,
    });
    // 热替换后重新应用执行模式（新注册的工具需要 mode 预设）。
    this.applyToolExecutionModes();
  }

  // -------------------------------------------------------------------------
  // Port其余方法：M2-M6 的能力，统一 throw not-implemented
  // -------------------------------------------------------------------------

  async setModel(_model: AnyModel): Promise<void> {
    throw notImplemented("setModel", "M2 (runtime model switch)");
  }

  async navigateTree(
    _targetId: string,
    _options?: { summarize?: boolean },
  ): Promise<{
    editorText?: string;
    cancelled: boolean;
    aborted?: boolean;
  }> {
    throw notImplemented("navigateTree", "M6 (SessionStore)");
  }

  /** appendCustomEntry：M1 不持久化，no-op 返回占位 id。 */
  appendCustomEntry(customType: string, _data?: unknown): string {
    // M1 不写 jsonl；返回一个稳定格式的占位 id 避免上游炸。
    return `deer-loop-custom-${Date.now()}-${customType}`;
  }

  setThinkingLevel(_level: string): void {
    throw notImplemented("setThinkingLevel", "M2 (runtime thinking switch)");
  }

  async compact(_customInstructions?: string): Promise<unknown> {
    throw notImplemented("compact", "M6 (SessionStore)");
  }

  setAutoCompactionEnabled(_enabled: boolean): void {
    // M1 不支持压缩；no-op（避免命令路径抛错，但实际不生效）。
  }

  /** ★ M4：运行时开关自动重试（set_auto_retry 命令用）。 */
  setAutoRetryEnabled(enabled: boolean): void {
    this._autoRetryEnabled = enabled;
  }

  async steer(
    _text: string,
    _images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    throw notImplemented("steer", "M5 (steering queue)");
  }

  async followUp(
    _text: string,
    _images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    throw notImplemented("followUp", "M5 (followUp queue)");
  }

  /** ★ M2：返回全部已注册工具的 name/description（给 get_state 命令用）。 */
  getAllTools(): { name: string; description: string }[] {
    return this.registry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /** ★ M2：返回当前激活工具名（白名单）。 */
  getActiveToolNames(): string[] {
    return this.registry.getActiveNames();
  }

  /** ★ M2：重设激活白名单（setActiveToolsByName 命令用）。 */
  setActiveToolsByName(names: string[]): void {
    this.registry.setActive(names);
  }

  abortCompaction(): void {
    // M1 不支持压缩；no-op。
  }

  /** M1 不维护上下文用量：返回 undefined。 */
  getContextUsage():
    | {
        percent: number | null;
        contextWindow: number;
        tokens: number | null;
      }
    | undefined {
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 私有 helper
  // -------------------------------------------------------------------------

  /**
   * 发射一个 LoopEvent 给所有订阅者。
   * LoopEvent 结构兼容 Port 要求的 AgentSessionEvent，用类型断言桥接。
   */
  private emit(event: LoopEvent): void {
    const listeners = Array.from(this.listeners);
    for (const listener of listeners) {
      try {
        listener(event as unknown as AgentSessionEvent);
      } catch (err) {
        // 订阅者异常不能拖垮 loop。记录后继续。
        console.error("[DeerLoopEngine] subscribe listener threw:", err);
      }
    }
  }

  /** 构造 user message 的 content（文本 + 可选图片）。 */
  private buildUserContent(
    text: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): string | NonNullable<UserMessage["content"]> {
    if (!images || images.length === 0) {
      return text;
    }
    const parts: NonNullable<UserMessage["content"]> = [{ type: "text", text }];
    for (const img of images) {
      parts.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    return parts;
  }

  /** 判断错误是否为 abort 导致（stream 中断后 next() 抛 AbortError）。 */
  private isAbortError(err: unknown): boolean {
    if (this.abortController?.signal.aborted) return true;
    if (err instanceof Error) {
      return err.name === "AbortError" || /abort/i.test(err.message);
    }
    return false;
  }

  /**
   * 计算 message_end 应使用的 AssistantMessage。
   *
   * 优先级：
   * 1. stream 的 done/error 事件携带的 message（finalMessage）
   * 2. 最后一次 partial（lastPartial）
   * 3. 合成空 AssistantMessage（极端情况：没收到任何 partial）
   *
   * abort 时强制覆盖 stopReason 为 "aborted"。
   */
  private resolveEndMessage(
    finalMessage: AssistantMessage | null,
    lastPartial: AssistantMessage | null,
    aborted: boolean,
    errorMessage: string | undefined,
  ): AssistantMessage {
    const base =
      finalMessage ??
      lastPartial ??
      this.synthesizeEmptyAssistantMessage(aborted ? "aborted" : "error", errorMessage);

    if (!aborted && base.stopReason !== "error" && !errorMessage) {
      return base;
    }

    // abort 或 error：覆盖 stopReason / errorMessage（不修改原对象）。
    return {
      ...base,
      stopReason: aborted ? "aborted" : errorMessage ? "error" : base.stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  /** 合成一个空 AssistantMessage（stream 没收到任何 partial 时的兜底）。 */
  private synthesizeEmptyAssistantMessage(
    stopReason: AssistantMessage["stopReason"],
    errorMessage?: string,
  ): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: this._model.api,
      provider: this._model.provider,
      model: this._model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason,
      timestamp: Date.now(),
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  /** 等待 loop 进入 idle 态（_isRunning=false）。 */
  private async waitForIdle(): Promise<void> {
    // 简单轮询：每 10ms 检查一次，最多等 10s（避免死锁）。
    const deadline = Date.now() + 10_000;
    while (this._isRunning && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// ===========================================================================
// 默认 streamFn：委托给 pi-ai 的 streamSimple
// ===========================================================================

/**
 * 默认 StreamFn 实现：直接调 pi-ai 的 streamSimple。
 *
 * 拆成单独函数是为了：
 * 1. 延迟 import（避免模块加载时就拉起 pi-ai provider 注册）。
 * 2. 测试可注入 mock，绕过此默认实现。
 */
function defaultStreamFn(
  model: AnyModel,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // 动态 require 避免 top-level 副作用；pi-ai 的 streamSimple 会注册 provider。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { streamSimple } = require("@earendil-works/pi-ai") as {
    streamSimple: StreamFn;
  };
  return streamSimple(model, context, options);
}

// ===========================================================================
// 最小代理工厂（sessionManager / settingsManager）
// ===========================================================================

/**
 * 创建最小的 SessionManager 代理，满足 wrapper 构造与 get_state 的调用。
 *
 * DeerLoopEngine 不做 jsonl 持久化（M6 的事），所以 isPersisted 返回 false、
 * appendCustomEntry 返回占位 id。其他方法（getBranch/createBranchedSession 等）
 * 在被调时 throw——M1 灰度路径不会触碰它们。
 */
function createMinimalSessionManager(
  cwd: string,
): import("@earendil-works/pi-coding-agent").SessionManager {
  const minimal = {
    getCwd: () => cwd,
    isPersisted: () => false,
    appendCustomEntry: (_customType: string, _data?: unknown) =>
      `deer-loop-custom-${Date.now()}`,
    getBranch: () => [] as unknown[],
    getSessionFile: () => undefined,
  };
  // 用 Proxy 把未实现的方法统一转成 throw，避免返回一个"看起来完整"的假对象。
  return new Proxy(minimal, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // 访问任何未实现的方法/属性时返回一个 throw 函数（兼容方法调用）或 throw。
      throw new Error(
        `DeerLoopEngine.sessionManager.${String(prop)}: not implemented in M1 (see M6 / SessionStore)`,
      );
    },
  }) as unknown as import("@earendil-works/pi-coding-agent").SessionManager;
}

/**
 * 创建最小的 SettingsManager 代理。
 * M1 灰度不读 settings；提供默认值满足 Port 类型。
 */
function createMinimalSettingsManager(): import("@earendil-works/pi-coding-agent").SettingsManager {
  const minimal = {
    getCompactionSettings: () => ({ threshold: 0.5, autoCompact: false }),
    getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 5000 }),
  };
  return new Proxy(minimal, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      throw new Error(
        `DeerLoopEngine.settingsManager.${String(prop)}: not implemented in M1`,
      );
    },
  }) as unknown as import("@earendil-works/pi-coding-agent").SettingsManager;
}
