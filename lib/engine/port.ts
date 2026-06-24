import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "@/lib/deerhux-types";

/**
 * AgentEnginePort —— DeerHux 与 Agent 引擎之间的稳定边界。
 * 将 DeerHux 对引擎的调用收敛到此接口，由 DeerLoopEngine 实现。
 */
export interface AgentEnginePort extends AgentSessionLike {
  /** 设置持久 system prompt，保证后续轮次 prompt() 重置时不回退到内置 prompt。 */
  setSystemPromptPersistent(prompt: string): void;

  /** 应用工具执行模式（read/grep/find/ls/code_search/subagent 并行，bash/edit/write 串行）。 */
  applyToolExecutionModes(): void;

  /** 安装自动重试加固（最小退避、假性流错误判定、settle 静默窗口）。 */
  installRetryHardening(): void;

  /** 运行时热替换自定义工具（MCP 工具集）。 */
  replaceCustomTools(options: {
    removeNames: readonly string[];
    addTools: ToolDefinition[];
    extraAllowedNames: readonly string[];
    activeToolNames: readonly string[];
  }): void;
}
