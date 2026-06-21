/**
 * M6+ feature flag：控制是否启用自研 DeerLoopEngine。
 *
 * 切换策略（M6 收官后）：
 * - 默认 on（生产走 DeerLoopEngine，pi 路径作为紧急回退保留）。
 * - 设 `DEERHUX_LOOP_ENGINE=pi` 时切回 PiEngineAdapter（紧急回退，无需改代码）。
 * - 回退后重设 `DEERHUX_LOOP_ENGINE=deer`（或不设，默认 deer）即恢复自研 loop。
 */

/** 环境变量名。 */
export const DEER_LOOP_ENGINE_ENV = "DEERHUX_LOOP_ENGINE";

/** 标识自研 loop 的值。默认启用。 */
export const DEER_LOOP_ENGINE_VALUE = "deer";

/** 标识 pi 回退的值。 */
export const PI_LOOP_ENGINE_VALUE = "pi";

/**
 * 是否启用自研 DeerLoopEngine。
 * 默认 true（M6 收官后切为默认）；仅当 DEERHUX_LOOP_ENGINE=pi 时返回 false。
 */
export function isDeerLoopEnabled(): boolean {
  return process.env[DEER_LOOP_ENGINE_ENV] !== PI_LOOP_ENGINE_VALUE;
}
