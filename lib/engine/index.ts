/**
 * DeerHux Agent 引擎抽象层（M0 里程碑）。
 *
 * 这里把 DeerHux 对 pi SDK 的全部访问收敛到一个稳定边界后面：
 * - {@link AgentEnginePort}：稳定接口（AgentSession 公开 API 子集 + 9 个 hack 能力）。
 * - {@link PiEngineAdapter}：M0 唯一实现，包 pi 的 AgentSession，hack 走私有字段。
 * - {@link detectPiPrivateFields} / {@link isPiSdkDrifted}：SDK 升级探测。
 *
 * 后续 M1+ 自研 DeerLoopEngine 时，只需再实现一个 AgentEnginePort，无需改动 rpc-manager。
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
