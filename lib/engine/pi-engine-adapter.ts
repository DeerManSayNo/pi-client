import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_TOOL_NAME } from "@/lib/parallel-agent/subagent-tool";
import type { AgentEnginePort } from "./port";

// ===========================================================================
// 私有 helper（与 lib/rpc-manager.ts 中的同名 helper 逐字一致）
//
// 这些 helper 原本只在 hack 函数内部使用。把 hack 搬到 adapter 时一并搬入，
// 以保持函数体原样、不引入跨文件耦合。后续里程碑收敛后可统一。
// ===========================================================================

/** 判断是否为普通对象（与 rpc-manager.ts 同名 helper 一致）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Promise 延时（与 rpc-manager.ts 同名 helper 一致；rpc-manager 自己也保留一份给 wrapper 用）。 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// hardenAutoRetry 相关常量与类型（原样从 rpc-manager.ts 搬入，仅换宿主）
// ===========================================================================

const MIN_AUTO_RETRY_DELAY_MS = 5000;
const AUTO_RETRY_SETTLE_MS = 1000;
const PREMATURE_STREAM_ERROR_RE = /connection.?lost|websocket.?closed|websocket.?error|other side closed|ended without|stream ended before message_stop|http2 request did not get a response|terminated/i;

type AssistantLike = {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
};

function getAssistantContentLength(message: AssistantLike): number {
  const content = message.content;
  if (typeof content === "string") return content.trim().length;
  if (!Array.isArray(content)) return 0;

  let length = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") length += block.text.trim().length;
    else if (typeof block.thinking === "string") length += block.thinking.trim().length;
  }
  return length;
}

// ===========================================================================
// configureToolExecutionModes 相关常量（原样从 rpc-manager.ts 搬入）
// ===========================================================================

const TOOL_EXECUTION_MODES: Record<string, "parallel" | "sequential"> = {
  read: "parallel",
  grep: "parallel",
  find: "parallel",
  ls: "parallel",
  code_search: "parallel",
  [SUBAGENT_TOOL_NAME]: "parallel",
  bash: "sequential",
  edit: "sequential",
  write: "sequential",
};

// ===========================================================================
// PiEngineAdapter
//
// AgentEnginePort 的 M0 唯一实现：包一层 pi 的 AgentSession。
// - 公开方法/属性：一行委托给 this.session。
// - Hack 方法：从 rpc-manager.ts 原样迁入（函数体逐字一致，仅把 session 形参换成 this.session）。
// ===========================================================================

/**
 * 用 pi 的 AgentSession 实现 {@link AgentEnginePort}。
 *
 * 构造后即可当作 AgentSession 的“加固版”使用：所有 DeerHux 私有字段 hack 都集中在本类的方法里。
 */
export class PiEngineAdapter implements AgentEnginePort {
  constructor(private readonly session: AgentSession) {}

  // -------------------------------------------------------------------------
  // 只读属性：一行透传
  // -------------------------------------------------------------------------

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  get isCompacting(): boolean {
    return this.session.isCompacting;
  }

  get autoCompactionEnabled(): boolean {
    return this.session.autoCompactionEnabled;
  }

  get autoRetryEnabled(): boolean {
    return this.session.autoRetryEnabled;
  }

  /**
   * 过渡透传：暴露 pi 的 Agent，wrapper 取 agent.state 用。后续里程碑内化。
   * Port 接口侧以 AgentSessionLike 的窄结构（{ state? }) 收口；pi 的 Agent 结构兼容，无需 cast。
   */
  get agent() {
    return this.session.agent;
  }

  /** 过渡透传：暴露 pi 的 SessionManager。后续里程碑内化。 */
  get sessionManager() {
    return this.session.sessionManager;
  }

  /** 过渡透传：暴露 pi 的 SettingsManager。后续里程碑内化。 */
  get settingsManager() {
    return this.session.settingsManager;
  }

  /**
   * pi 的真实 Model<any> 结构兼容 AgentSessionLike 的 ModelLike（{ id, provider }），
   * 由 Port 接口收口，无需 cast。
   */
  get model() {
    return this.session.model;
  }

  get modelRegistry() {
    return this.session.modelRegistry;
  }

  // -------------------------------------------------------------------------
  // 公开方法：一行委托
  // -------------------------------------------------------------------------

  subscribe(listener: Parameters<AgentSession["subscribe"]>[0]): () => void {
    return this.session.subscribe(listener);
  }

  prompt(text: string, options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void> {
    // AgentSessionLike.prompt 的 options 类型与 pi 的 PromptOptions.images（ImageContent[]）
    // 结构完全一致，直接透传即可。
    return this.session.prompt(text, options as Parameters<AgentSession["prompt"]>[1]);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  setModel(model: { id: string; provider: string }): Promise<void> {
    // 运行时 model 来自 modelRegistry.find()，本质就是 pi 的 Model<any>，这里只是编译期窄化。
    return this.session.setModel(model as Parameters<AgentSession["setModel"]>[0]);
  }

  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }> {
    // pi 的返回类型多一个可选 summaryEntry，结构兼容 AgentSessionLike 的窄返回类型。
    return this.session.navigateTree(targetId, options) as Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }>;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.session.sessionManager.appendCustomEntry(customType, data);
  }

  setThinkingLevel(level: string): void {
    // DeerHux 命令载荷里 level 是 string；pi 期望 ThinkingLevel 联合类型。值已在上游规范化。
    this.session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
  }

  compact(customInstructions?: string): Promise<unknown> {
    return this.session.compact(customInstructions);
  }

  setAutoCompactionEnabled(enabled: boolean): void {
    return this.session.setAutoCompactionEnabled(enabled);
  }

  setAutoRetryEnabled(enabled: boolean): void {
    return this.session.setAutoRetryEnabled(enabled);
  }

  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    return this.session.steer(text, images as Parameters<AgentSession["steer"]>[1]);
  }

  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    return this.session.followUp(text, images as Parameters<AgentSession["followUp"]>[1]);
  }

  getAllTools(): { name: string; description: string }[] {
    return this.session.getAllTools();
  }

  getActiveToolNames(): string[] {
    return this.session.getActiveToolNames();
  }

  setActiveToolsByName(names: string[]): void {
    return this.session.setActiveToolsByName(names);
  }

  abortCompaction(): void {
    return this.session.abortCompaction();
  }

  getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined {
    return this.session.getContextUsage();
  }

  // -------------------------------------------------------------------------
  // ★ Hack 方法：从 rpc-manager.ts 原样迁入（函数体逐字一致，session → this.session）
  // -------------------------------------------------------------------------

  /** 设置持久 system prompt。原 setEffectiveSystemPrompt，消灭 H1。 */
  setSystemPromptPersistent(prompt: string): void {
    if (this.session.agent.state) this.session.agent.state.systemPrompt = prompt;

    // DeerHux's AgentSession.prompt() resets agent.state.systemPrompt back to its
    // private _baseSystemPrompt before every turn. If we only mutate state here,
    // the UI preview looks correct but the next new prompt silently uses the old
    // built-in prompt again. Keep the base prompt in sync as well.
    (this.session as unknown as { _baseSystemPrompt?: string })._baseSystemPrompt = prompt;
  }

  /** 应用工具执行模式。原 configureToolExecutionModes，消灭 H5/H6/H7/H8。 */
  applyToolExecutionModes(): void {
    const forceSequential = process.env.PI_DISABLE_PARALLEL_TOOLS === "1" || process.env.PI_DISABLE_PARALLEL_TOOLS === "true";
    if (forceSequential) {
      (this.session.agent as unknown as { toolExecution?: "parallel" | "sequential" }).toolExecution = "sequential";
    }

    const resolveMode = (name: string) => forceSequential ? "sequential" : TOOL_EXECUTION_MODES[name];
    const registry = (this.session as unknown as { _toolRegistry?: Map<string, { name: string; executionMode?: "parallel" | "sequential" }> })._toolRegistry;
    for (const [name, tool] of registry ?? []) {
      const mode = resolveMode(name);
      if (mode) tool.executionMode = mode;
    }

    const definitions = (this.session as unknown as { _toolDefinitions?: Map<string, { definition?: { executionMode?: "parallel" | "sequential" } }> })._toolDefinitions;
    for (const [name, entry] of definitions ?? []) {
      const mode = resolveMode(name);
      if (mode && entry.definition) entry.definition.executionMode = mode;
    }

    const activeTools = (this.session.agent.state as { tools?: Array<{ name: string; executionMode?: "parallel" | "sequential" }> } | undefined)?.tools;
    for (const tool of activeTools ?? []) {
      const mode = resolveMode(tool.name);
      if (mode) tool.executionMode = mode;
    }
  }

  /** 安装自动重试加固。原 hardenAutoRetry，消灭 H2/H3/H4。 */
  installRetryHardening(): void {
    const settingsManager = this.session.settingsManager as unknown as {
      getRetrySettings?: () => { enabled: boolean; maxRetries: number; baseDelayMs: number };
    };
    const originalGetRetrySettings = settingsManager.getRetrySettings?.bind(this.session.settingsManager);
    if (originalGetRetrySettings) {
      settingsManager.getRetrySettings = () => {
        const settings = originalGetRetrySettings();
        return { ...settings, baseDelayMs: Math.max(settings.baseDelayMs ?? 0, MIN_AUTO_RETRY_DELAY_MS) };
      };
    }

    const rawSession = this.session as unknown as {
      _isRetryableError?: (message: AssistantLike) => boolean;
      _prepareRetry?: (message: AssistantLike) => Promise<boolean>;
    };

    const originalIsRetryableError = rawSession._isRetryableError?.bind(this.session);
    if (originalIsRetryableError) {
      rawSession._isRetryableError = (message: AssistantLike) => {
        const retryable = originalIsRetryableError(message);
        if (!retryable) return false;

        // Premature-stream/transport-close errors are noisy: providers can emit
        // them after a complete-looking assistant message. Retrying those causes
        // an unnecessary `continue`. Only retry these when essentially no useful
        // assistant content was received.
        const err = message.errorMessage ?? "";
        if (PREMATURE_STREAM_ERROR_RE.test(err) && getAssistantContentLength(message) >= 20) {
          return false;
        }

        return true;
      };
    }

    const originalPrepareRetry = rawSession._prepareRetry?.bind(this.session);
    if (originalPrepareRetry) {
      rawSession._prepareRetry = async (message: AssistantLike) => {
        // Give SSE/tool/agent-end bookkeeping a clean quiet window before deciding
        // to send `continue`; this avoids racing other async cleanup paths.
        await sleepMs(AUTO_RETRY_SETTLE_MS);
        return originalPrepareRetry(message);
      };
    }
  }

  /**
   * 运行时热替换自定义工具。原 installMcpRuntime 里的 H9 私有字段操作，消灭 H9。
   *
   * 编排决策（保留哪些工具、激活哪些）由 wrapper 负责；本方法只做对 pi 私有字段
   * `_customTools` / `_allowedToolNames` / `_refreshToolRegistry` 的直接操作。
   */
  replaceCustomTools(options: {
    removeNames: readonly string[];
    addTools: ToolDefinition[];
    extraAllowedNames: readonly string[];
    activeToolNames: readonly string[];
  }): void {
    const rawSession = this.session as unknown as {
      _customTools?: ToolDefinition[];
      _allowedToolNames?: Set<string>;
      _refreshToolRegistry?: (opts?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }) => void;
    };

    if (!Array.isArray(rawSession._customTools) || typeof rawSession._refreshToolRegistry !== "function") {
      throw new Error("Current AgentSession does not support runtime MCP reload");
    }

    if (rawSession._allowedToolNames && rawSession._allowedToolNames.size > 0) {
      for (const toolName of options.extraAllowedNames) rawSession._allowedToolNames.add(toolName);
    }

    const removeSet = new Set(options.removeNames);
    rawSession._customTools = [
      ...rawSession._customTools.filter((tool) => !removeSet.has(tool.name) && !tool.name.startsWith("mcp__")),
      ...options.addTools,
    ];

    rawSession._refreshToolRegistry({ activeToolNames: [...new Set(options.activeToolNames)], includeAllExtensionTools: true });
  }
}
