/**
 * DeerHux Agent 引擎抽象层（M0+M1 里程碑）。
 *
 * 这里把 DeerHux 对 pi SDK 的全部访问收敛到一个稳定边界后面：
 * - {@link AgentEnginePort}：稳定接口（AgentSession 公开 API 子集 + 9 个 hack 能力）。
 * - {@link PiEngineAdapter}：M0 唯一实现，包 pi 的 AgentSession，hack 走私有字段。
 * - {@link DeerLoopEngine} / {@link createDeerLoop}：M1 自研 loop 骨架（feature flag 灰度）。
 * - {@link detectPiPrivateFields} / {@link isPiSdkDrifted}：SDK 升级探测。
 *
 * 默认走 PiEngineAdapter；设 `DEERHUX_LOOP_ENGINE=deer` 时 rpc-manager 会切到 DeerLoopEngine。
 */
export type { AgentEnginePort } from "./port";
export { PiEngineAdapter } from "./pi-engine-adapter";
export {
  detectPiPrivateFields,
  isPiSdkDrifted,
  PI_SDK_DRIFT_ENV,
  REQUIRED_PRIVATE_FIELDS,
  type SdkGuardResult,
} from "./sdk-guard";
export { createDeerLoop, DeerLoopEngine } from "./factory";
export type { DeerLoopOptions } from "./factory";
export type {
  LoopEvent,
  AgentMessage,
  ToolExecutionMode,
  QueueMode,
  CompactionResult,
  AgentToolResult,
} from "./loop-event";
export type { StreamFn } from "./deer-loop";
export {
  DEER_LOOP_ENGINE_ENV,
  DEER_LOOP_ENGINE_VALUE,
  isDeerLoopEnabled,
} from "./feature-flag";
