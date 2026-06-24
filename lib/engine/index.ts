/**
 * DeerHux Agent 引擎抽象层。
 *
 * - {@link AgentEnginePort}：稳定接口（AgentSession 公开 API 子集 + 9 个 hack 能力）。
 * - {@link DeerLoopEngine}：自研 loop 引擎。
 * - {@link detectPiPrivateFields} / {@link isPiSdkDrifted}：SDK 升级探测。
 */
export type { AgentEnginePort } from "./port";
export {
  detectPiPrivateFields,
  isPiSdkDrifted,
  PI_SDK_DRIFT_ENV,
  REQUIRED_PRIVATE_FIELDS,
  type SdkGuardResult,
} from "./sdk-guard";
export { DeerLoopEngine } from "./deer-loop";
export type { DeerLoopOptions } from "./deer-loop";
export type {
  LoopEvent,
  AgentMessage,
  ToolExecutionMode,
  QueueMode,
  CompactionResult,
  AgentToolResult,
} from "./loop-event";
export type { StreamFn } from "./deer-loop";
