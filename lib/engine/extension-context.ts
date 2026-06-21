/**
 * MinimalExtensionContext —— 给工具 execute 第 5 参用的最小上下文（M2 产出）。
 *
 * 设计文档 §4「核心技术契约」#2：DeerHux 是 RPC 模式（hasUI=false），工具的
 * execute(toolCallId, params, signal, onUpdate, ctx) 的第 5 参 ctx 需要一个
 * 满足 pi-coding-agent `ExtensionContext` 接口的对象。
 *
 * 复用 loop 已有的最小代理（sessionManager / modelRegistry）与状态（cwd / model /
 * abortController / isStreaming），不引入新的依赖。MCP / codegraph 等自定义工具
 * 的 execute 只用到 ctx.signal / ctx.cwd（部分用到 sessionManager），ui 相关方法
 * 在 RPC 模式不会被调（hasUI=false 时工具不应碰 ui）。
 *
 * 未实现的方法（shutdown / compact / getContextUsage）：提供最小兜底，被调时
 * 不 crash（M6 SessionStore 落地后再完善）。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/** re-export 类型，方便外部按 ExtensionContext 形状引用。 */
export type { ExtensionContext };

/**
 * 构造 MinimalExtensionContext 所需的依赖（由 DeerLoopEngine 注入）。
 *
 * 设计成「传函数/对象」而非「传 loop 实例」，是为了避免循环依赖
 *（extension-context.ts 不 import deer-loop.ts）。
 */
export interface MinimalExtensionContextDeps {
  /** 工作目录（ctx.cwd）。 */
  cwd: string;
  /** 当前模型（ctx.model，可能 undefined）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any> | undefined;
  /** 当前 abort signal（ctx.signal，工具执行期间必非空）。 */
  signal: AbortSignal;
  /** 中止操作（ctx.abort）。 */
  abort: () => void;
  /** loop 是否空闲（ctx.isIdle，= !isStreaming）。 */
  isIdle: () => boolean;
  /** 当前系统提示词（ctx.getSystemPrompt）。 */
  getSystemPrompt: () => string;
  /** sessionManager 代理（ctx.sessionManager，复用 loop 的最小代理）。 */
  sessionManager: unknown;
  /** modelRegistry 代理（ctx.modelRegistry）。 */
  modelRegistry: unknown;
}

/**
 * 创建一个满足 pi-coding-agent ExtensionContext 接口的最小上下文。
 *
 * 策略（设计文档 §4 #2）：
 * - `hasUI: false`，`ui: {}`（RPC 模式工具不调 ui；访问时返回 undefined 不 crash）
 * - `cwd` / `model` / `signal` / `abort` / `isIdle` / `getSystemPrompt`：透传 deps
 * - `sessionManager` / `modelRegistry`：透传 loop 已有的最小代理
 * - `hasPendingMessages`: false（M5 才有队列）
 * - `shutdown` / `compact` / `getContextUsage`：最小兜底（no-op / undefined）
 */
export function createMinimalExtensionContext(
  deps: MinimalExtensionContextDeps,
): ExtensionContext {
  const ctx: ExtensionContext = {
    ui: createNoopUI(),
    hasUI: false,
    cwd: deps.cwd,
    sessionManager: deps.sessionManager as ExtensionContext["sessionManager"],
    modelRegistry: deps.modelRegistry as ExtensionContext["modelRegistry"],
    model: deps.model,
    isIdle: deps.isIdle,
    signal: deps.signal,
    abort: deps.abort,
    hasPendingMessages: () => false,
    shutdown: () => {
      /* M6 SessionStore 落地后再实现真正的 shutdown */
    },
    getContextUsage: () => undefined,
    compact: () => {
      /* M6 落地 compact */
    },
    getSystemPrompt: deps.getSystemPrompt,
  };
  return ctx;
}

/**
 * 创建 no-op 的 ExtensionUIContext（RPC 模式工具不应调 ui；这里保证即使误调也不 crash）。
 *
 * 所有方法返回空组件 / undefined，不抛错。pi-coding-agent 的 ExtensionUIContext
 *（extensions/types.d.ts:67）方法众多，这里用 Proxy 统一兜底，避免逐个 stub。
 */
function createNoopUI(): ExtensionContext["ui"] {
  return new Proxy(
    {},
    {
      get(_target, _prop) {
        // 任何 ui.xxx 调用都返回一个 no-op 函数（兼容方法调用）或 undefined。
        return (..._args: unknown[]) => undefined;
      },
    },
  ) as ExtensionContext["ui"];
}
