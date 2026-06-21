/**
 * M1 feature flag：控制是否启用自研 DeerLoopEngine。
 *
 * 灰度策略（文档 §7.2）：
 * - 默认 off（生产走 PiEngineAdapter，行为与 M0 一致）。
 * - 设 `DEERHUX_LOOP_ENGINE=deer` 时，rpc-manager 的 startRpcSession 在「无工具纯文本对话」
 *   路径上切到 DeerLoopEngine。
 * - 回退：删 flag 或设为其他值即回旧实现，无需改代码、无需发版。
 *
 * 单独抽成模块（而不是在 rpc-manager 里直接读 process.env）是为了：
 *   1. 测试可注入（mock 此模块的 isDeerLoopEnabled）。
 *   2. 后续里程碑可扩展为按 session/用户比例灰度。
 */

/** 环境变量名。 */
export const DEER_LOOP_ENGINE_ENV = "DEERHUX_LOOP_ENGINE";

/** 标识自研 loop 的灯度值。 */
export const DEER_LOOP_ENGINE_VALUE = "deer";

/**
 * 是否启用自研 DeerLoopEngine。
 * 当 DEERHUX_LOOP_ENGINE === "deer" 时返回 true。
 */
export function isDeerLoopEnabled(): boolean {
  return process.env[DEER_LOOP_ENGINE_ENV] === DEER_LOOP_ENGINE_VALUE;
}
