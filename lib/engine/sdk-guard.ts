/**
 * SDK 升级探测（sdk-guard）。
 *
 * DeerHux 的 9 个 hack 依赖 pi 的私有字段名（`_baseSystemPrompt`、`_toolRegistry` 等）。
 * pi 版本升级若改了字段名或删除字段，这些 hack 会**静默失效**——运行不报错，但行为退化
 * （例如 system prompt 不持久、工具并行模式丢失、自动重试不再加固）。
 *
 * 本模块在 session 创建时探测这些字段是否存在；缺失则：
 *   1. `console.warn` 输出告警（服务端日志可见）；
 *   2. 设置 `process.env.DEERHUX_PI_SDK_DRIFT = "1"`，前端可读此 env 显示告警横幅。
 *
 * M0 阶段只做探测+告警，不阻断启动（避免误伤）。
 */

/**
 * hack 依赖的 pi 私有字段清单（与 PiEngineAdapter 里 `as unknown as` 访问的字段一一对应）。
 * - H1: _baseSystemPrompt
 * - H2/H3/H4: _isRetryableError / _prepareRetry（+ settingsManager.getRetrySettings）
 * - H5/H6/H7/H8: _toolRegistry / _toolDefinitions（+ agent.toolExecution）
 * - H9: _customTools / _allowedToolNames / _refreshToolRegistry
 */
export const REQUIRED_PRIVATE_FIELDS = [
  "_baseSystemPrompt",
  "_toolRegistry",
  "_toolDefinitions",
  "_isRetryableError",
  "_prepareRetry",
  "_customTools",
  "_allowedToolNames",
  "_refreshToolRegistry",
] as const;

/** 环境变量名：检测到 SDK 漂移时置 "1"。前端/运维可读此值判断 hack 是否可能失效。 */
export const PI_SDK_DRIFT_ENV = "DEERHUX_PI_SDK_DRIFT";

export interface SdkGuardResult {
  /** true 表示所有必需私有字段都在，hack 应能正常工作。 */
  ok: boolean;
  /** 缺失的字段名列表（ok=true 时为空）。 */
  missingFields: string[];
}

/**
 * 探测给定对象（通常是 pi 的 AgentSession 实例）是否具备全部必需私有字段。
 *
 * 缺失时会 `console.warn` 并把 `DEERHUX_PI_SDK_DRIFT` 置 "1"。
 * 重复调用是幂等的：只要还有缺失字段就保持告警状态。
 *
 * @param session 任意对象，一般传 `createAgentSession()` 返回的 session。
 * @returns 探测结果（含缺失字段列表）。
 */
export function detectPiPrivateFields(session: unknown): SdkGuardResult {
  const missingFields: string[] = [];
  for (const field of REQUIRED_PRIVATE_FIELDS) {
    // 用 in 操作符探测字段是否存在（含原型链上的字段也认；pi 的私有字段都在实例上）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(field in (session as any))) {
      missingFields.push(field);
    }
  }

  const ok = missingFields.length === 0;
  if (!ok) {
    if (process.env[PI_SDK_DRIFT_ENV] !== "1") {
      console.warn(
        `[sdk-guard] 检测到 pi SDK 漂移：缺失私有字段 ${missingFields.join(", ")}。` +
          "DeerHux 的 system-prompt/重试/工具模式/MCP hack 可能静默失效。" +
          "请核对 @earendil-works/pi-coding-agent 版本与 lib/engine/pi-engine-adapter.ts。",
      );
    }
    process.env[PI_SDK_DRIFT_ENV] = "1";
  }
  return { ok, missingFields };
}

/**
 * 是否已检测到 SDK 漂移（hack 可能失效）。
 * 前端可经 API 读取此状态后显示告警横幅。
 */
export function isPiSdkDrifted(): boolean {
  return process.env[PI_SDK_DRIFT_ENV] === "1";
}
