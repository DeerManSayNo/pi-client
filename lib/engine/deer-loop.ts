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
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEnginePort } from "./port";
import type { AgentMessage, LoopEvent } from "./loop-event";

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
}

/** 标记当前是否处于 M1 的 not-implemented 路径抛出的错误。 */
function notImplemented(method: string, milestone: string): Error {
  return new Error(
    `DeerLoopEngine.${method}: not implemented in M1 (see ${milestone})`,
  );
}

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

  /** 持久系统提示词（M3 会完善 turn_context strip，M1 简单存取）。 */
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
  }

  // -------------------------------------------------------------------------
  // ★ M1 核心方法：prompt 流式
  // -------------------------------------------------------------------------

  /**
   * 发起一轮 prompt。消费 pi-ai 的 AssistantMessageEventStream，转成 LoopEvent emit。
   *
   * 事件顺序：agent_start → message_start → message_update*N → message_end → agent_end
   *
   * abort 行为：abortController.abort() 后，stream 的下一次 yield 会抛 AbortError
   *（或 stream 自己 emit 一个 reason:"aborted" 的 error 事件），loop 捕获后
   * emit message_end{stopReason:"aborted"} + agent_end{willRetry:false}。
   *
   * 错误行为：stream 抛非 abort 错误，或 emit error 事件，loop emit
   * message_end{stopReason:"error"} + agent_end{error}。
   */
  async prompt(
    text: string,
    options?: {
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
    },
  ): Promise<void> {
    if (this._isRunning) {
      throw new Error(
        "DeerLoopEngine.prompt: a prompt is already running (M1 不支持并发 prompt)",
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

    // 2. 构造 pi-ai Context（messages 即 transcript，systemPrompt 来自 baseSystemPrompt）。
    const context: Context = {
      systemPrompt: this._baseSystemPrompt || undefined,
      messages: this._messages as Message[],
      // M1 不支持工具：不传 tools。
    };

    // 3. 进入 running 态，发射 agent_start。
    this._isRunning = true;
    this._isStreaming = true;
    this.abortController = new AbortController();
    this.emit({ type: "agent_start" });

    // 跟踪本次 stream 的状态。
    let started = false; // 是否已 emit message_start
    let lastPartial: AssistantMessage | null = null; // 最后一次收到的 partial
    let finalMessage: AssistantMessage | null = null; // done 事件的最终 message
    let aborted = false; // 是否被 abort
    let errorMessage: string | undefined; // 错误消息（非 abort）

    try {
      const streamOptions: SimpleStreamOptions = {
        signal: this.abortController.signal,
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
          break;
        }

        if (ev.type === "error") {
          // stream 显式报告错误（含 aborted）。
          if (ev.reason === "aborted") {
            aborted = true;
          } else {
            errorMessage = ev.error.errorMessage ?? ev.reason;
          }
          finalMessage = ev.error;
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
    }

    // 4. 收尾 message 流：保证 message_start / message_end 成对（即便没收到任何 partial）。
    const endMessage = this.resolveEndMessage(
      finalMessage,
      lastPartial,
      aborted,
      errorMessage,
    );
    if (!started) {
      // stream 立即结束/出错/abort，从没 emit 过 message_start：补一次。
      this.emit({ type: "message_start", message: endMessage });
    }
    this.emit({ type: "message_end", message: endMessage });

    // 把 assistant 最终消息追加到 transcript（user 消息已在开头追加）。
    this._messages.push(endMessage);

    // 5. 退出 running 态，发射 agent_end。
    this._isStreaming = false;
    this._isRunning = false;
    this.abortController = null;

    const agentEndEvent: LoopEvent = {
      type: "agent_end",
      messages: [...this._messages],
      willRetry: false,
    };
    if (errorMessage) {
      (agentEndEvent as { error?: string }).error = errorMessage;
    }
    this.emit(agentEndEvent);
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

  get autoRetryEnabled(): boolean {
    return false;
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
   * M1 简单实现：直接写 _baseSystemPrompt + agentState.systemPrompt。
   * M3 会完善（stripTurnContextBlock / withTemporarySystemPrompt 恢复）。
   * 不能 throw——wrapper 构造时 applyRolePrompt 会立即调用。
   */
  setSystemPromptPersistent(prompt: string): void {
    this._baseSystemPrompt = prompt;
    this._agentState.systemPrompt = prompt;
  }

  /**
   * 应用工具执行模式（Port hack 方法，消灭 H5/H6/H7/H8）。
   * M1 无工具：空实现。
   */
  applyToolExecutionModes(): void {
    // M1 no-op（无工具）。
  }

  /**
   * 安装自动重试加固（Port hack 方法，消灭 H2/H3/H4）。
   * M1 无重试：空实现。
   */
  installRetryHardening(): void {
    // M1 no-op（无重试）。
  }

  /**
   * 运行时热替换自定义工具（Port hack 方法，消灭 H9）。
   * M1 无工具：throw（M2 实现）。
   */
  replaceCustomTools(_options: {
    removeNames: readonly string[];
    addTools: import("@earendil-works/pi-coding-agent").ToolDefinition[];
    extraAllowedNames: readonly string[];
    activeToolNames: readonly string[];
  }): void {
    throw notImplemented("replaceCustomTools", "M2");
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

  setAutoRetryEnabled(_enabled: boolean): void {
    // M1 不支持重试；no-op。
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

  /** M1 无工具：返回空数组。 */
  getAllTools(): { name: string; description: string }[] {
    return [];
  }

  /** M1 无工具：返回空数组。 */
  getActiveToolNames(): string[] {
    return [];
  }

  /** M1 无工具：空实现。 */
  setActiveToolsByName(_names: string[]): void {
    // M1 no-op（无工具）。
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
