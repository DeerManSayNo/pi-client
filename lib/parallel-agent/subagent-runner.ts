import path from "path";
import { existsSync, readFileSync } from "fs";
import { startRpcSession, type AgentEvent } from "@/lib/rpc-manager";
import { getAgentDir, resolveSessionPath } from "@/lib/session-reader";
import type { CollaborationRunMode } from "./collaboration-types";

export type WorkerSession = {
  sessionId: string;
  sendPrompt: (message: string) => Promise<string>;
  setModel: (model: RecoveryModel) => Promise<void>;
  listen: (listener: (event: AgentEvent) => void) => () => void;
  abort: () => Promise<void>;
  destroy: () => void;
};

export type RecoveryModel = { provider: string; modelId: string };

export function getAutoRecoveryModels(): RecoveryModel[] {
  const modelsPath = path.join(getAgentDir(), "models.json");
  if (!existsSync(modelsPath)) return [];
  try {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as { autoRecoveryModels?: unknown };
    if (!Array.isArray(data.autoRecoveryModels)) return [];
    return data.autoRecoveryModels.flatMap((entry): RecoveryModel[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { provider?: unknown; modelId?: unknown };
      const provider = typeof record.provider === "string" ? record.provider.trim() : "";
      const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
      return provider && modelId ? [{ provider, modelId }] : [];
    }).slice(0, 3);
  } catch {
    return [];
  }
}

export async function createSubagentWorkerSession(cwd: string, mode: CollaborationRunMode, existingSessionId?: string): Promise<WorkerSession> {
  const sessionFile = existingSessionId ? await resolveSessionPath(existingSessionId) : "";
  if (existingSessionId && !sessionFile) throw new Error("Worker session file was not found");
  const tempKey = existingSessionId ?? `__collab__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tools = mode === "analysis"
    ? ["read", "grep", "find", "ls", "code_search", "codegraph_status", "codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls", "code_search", "codegraph_status", "codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact"];
  const { session, realSessionId } = await startRpcSession(
    tempKey,
    sessionFile || "",
    cwd,
    tools,
    undefined,
    undefined,
    { hideFromGlobalRunningList: true, hideFromProjectList: true },
  );

  return {
    sessionId: realSessionId,
    sendPrompt: (message: string) => new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      let unsubscribe: () => void = () => undefined;
      const timeout = setTimeout(() => settle(() => {
        unsubscribe();
        reject(new Error("Worker session timed out after 10 minutes"));
      }), 10 * 60 * 1000);
      unsubscribe = session.onEvent((event: AgentEvent) => {
        if (event.type === "agent_end" && event.error) {
          settle(() => {
            clearTimeout(timeout);
            unsubscribe();
            reject(new Error(String(event.error)));
          });
          return;
        }
        if (event.type === "agent_end" && Array.isArray(event.messages)) {
          settle(() => {
            clearTimeout(timeout);
            unsubscribe();
            const messages = event.messages as Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>;
            const assistantError = getAssistantError(messages);
            if (assistantError) reject(new Error(assistantError));
            else resolve(textFromMessages(messages));
          });
        }
      });
      session.send({ type: "prompt", message }).catch((error: unknown) => {
        settle(() => {
          clearTimeout(timeout);
          unsubscribe();
          reject(error);
        });
      });
    }),
    setModel: async (model) => {
      await session.send({ type: "set_model", provider: model.provider, modelId: model.modelId });
    },
    listen: (listener) => session.onEvent(listener),
    abort: async () => { await session.send({ type: "abort" }); },
    destroy: () => session.destroy(),
  };
}

export async function runWorkerPromptWithRecovery(
  workerSession: WorkerSession,
  prompt: string,
  recoveryModels: RecoveryModel[],
  onRetry: (model: RecoveryModel, attempt: number, error: unknown) => void,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= recoveryModels.length; attempt += 1) {
    const fallbackModel = attempt > 0 ? recoveryModels[attempt - 1] : null;
    try {
      if (fallbackModel) await workerSession.setModel(fallbackModel);
      const retryPrefix = fallbackModel
        ? `上一轮子 Agent 请求失败，已切换到自动恢复模型 ${fallbackModel.provider}/${fallbackModel.modelId}。请重新完成同一个子任务，不要依赖上一轮失败输出。\n\n`
        : "";
      return await workerSession.sendPrompt(`${retryPrefix}${prompt}`);
    } catch (error) {
      lastError = error;
      if (!isRecoverableModelError(error) || attempt >= recoveryModels.length) break;
      onRetry(recoveryModels[attempt], attempt + 1, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getAssistantError(messages: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>): string | null {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return null;
  if (lastAssistant.errorMessage) return lastAssistant.errorMessage;
  return lastAssistant.stopReason === "error" ? "Model response failed" : null;
}

function isRecoverableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /400|upstream rejected|model|provider|rate.?limit|too many|overloaded|timeout|temporar/i.test(message);
}

function textFromMessages(messages: Array<{ role: string; content?: unknown }>): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const content = lastAssistant?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return "";
    const record = block as { type?: string; text?: string; thinking?: string };
    if (record.type === "text") return record.text ?? "";
    if (record.type === "thinking") return record.thinking ?? "";
    return "";
  }).join("");
}
