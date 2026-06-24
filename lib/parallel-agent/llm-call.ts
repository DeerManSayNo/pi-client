/**
 * 一次性 LLM 纯推理调用辅助（无工具、无持久化、无 session）。
 *
 * 供 subagent 的 planner / aggregator 这类「失败可优雅降级到正则/静态拼接」的
 * 场景使用：任何错误（model 解析失败、网络超时、空响应）都返回 null，由调用方
 * 走 fallback，绝不中断主流程。
 *
 * 技术路径：pi-ai 的 completeSimple(model, context, options) —— 同步返回一条
 * AssistantMessage。model 经 ModelRegistry.find(provider, modelId) 解析（与主
 * session 的 set_model 同路径，apiKey 由 ModelRegistry 自动绑定）。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface LlmCallOptions {
  model: { provider: string; modelId: string };
  systemPrompt: string;
  userPrompt: string;
  /** 超时 ms，默认 30s。超时返回 null（调用方降级）。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 调一次 LLM 拿纯文本。成功返回 assistant 文本；失败/超时/空返回 null。
 * 不抛异常 —— planner/aggregator 的降级路径依赖这一点。
 */
export async function callLlmForText(options: LlmCallOptions): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const [{ completeSimple }, { ModelRegistry, AuthStorage }] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    const model = ModelRegistry.create(AuthStorage.create()).find(options.model.provider, options.model.modelId);
    // find 可能返回 undefined（provider/modelId 配置缺失或 modelRegistry 未注册）。
    if (!model) return null;
    const callPromise = completeSimple(model, {
      systemPrompt: options.systemPrompt,
      messages: [
        { role: "user", content: options.userPrompt, timestamp: Date.now() },
      ],
    });

    // completeSimple 无原生 AbortSignal 选项，用 Promise.race 兜底超时，
    // 避免模型卡住拖死整个 subagent run（worker 有自己的 30min watchdog，
    // 但 planner/aggregator 必须快速失败快速降级）。
    const assistant = await Promise.race([
      callPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!assistant) return null;
    return extractAssistantText(assistant);
  } catch {
    return null;
  }
}

/** 从 AssistantMessage.content 提取纯文本（跳过 thinking/tool_call 块）。 */
function extractAssistantText(assistant: AssistantMessage): string {
  if (assistant.errorMessage) return "";
  const content = assistant.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const record = block as { type?: string; text?: string };
      return record.type === "text" ? record.text ?? "" : "";
    })
    .join("")
    .trim();
}
