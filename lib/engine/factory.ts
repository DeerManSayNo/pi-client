/**
 * DeerLoopEngine 工厂（文档 §4.5）。
 *
 * 把 DeerLoopEngine 的构造细节收敛到一个函数，rpc-manager 的 feature flag
 * 分支只调 createDeerLoop(options)，拿到一个 AgentEnginePort 实例。
 */
import type { AgentEnginePort } from "./port";
import { DeerLoopEngine, type DeerLoopOptions } from "./deer-loop";

/**
 * 创建一个 DeerLoopEngine 实例（M1 最小骨架）。
 *
 * @param options 见 {@link DeerLoopOptions}。model 与 cwd 必填。
 * @returns 实现了 {@link AgentEnginePort} 的 DeerLoopEngine。
 */
export function createDeerLoop(options: DeerLoopOptions): AgentEnginePort {
  return new DeerLoopEngine(options);
}

export type { DeerLoopOptions };
export { DeerLoopEngine };
