import { startRpcSession } from "@/lib/rpc-manager";
import type { AgentEvent } from "@/lib/rpc-manager";

/**
 * Create a read-only worker session for parallel analysis.
 * Uses a temporary session key and read-only tools only.
 */
export async function createWorkerSession(cwd: string): Promise<{
  sessionId: string;
  sendPrompt: (message: string) => Promise<string>;
  listen: (listener: (event: AgentEvent) => void) => () => void;
  abort: () => Promise<void>;
  destroy: () => void;
}> {
  const tempKey = `__worker__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const readOnlyTools = ["read", "grep", "find", "ls"];
  const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, readOnlyTools);

  return {
    sessionId: realSessionId,
    sendPrompt: async (message: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

        const timeout = setTimeout(() => settle(() => reject(new Error("Worker session timed out after 10 minutes"))), 10 * 60 * 1000);

        const unsub = session.onEvent((event: AgentEvent) => {
          if (event.type === "agent_end" && event.messages) {
            settle(() => {
              clearTimeout(timeout);
              unsub();
              const messages = event.messages as Array<{ role: string; content?: string | Array<{ type: string; text?: string; thinking?: string }> }>;
              const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
              if (lastAssistant) {
                const content = lastAssistant.content;
                if (typeof content === "string") {
                  resolve(content);
                } else if (Array.isArray(content)) {
                  resolve(content.map(b => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "") ?? "").join(""));
                } else {
                  resolve("");
                }
              } else {
                resolve("");
              }
            });
          }
          if (event.type === "agent_end" && event.error) {
            settle(() => {
              clearTimeout(timeout);
              unsub();
              reject(new Error(String(event.error)));
            });
          }
        });

        session.send({ type: "prompt", message }).catch(reject);
      });
    },
    listen: (listener: (event: AgentEvent) => void) => session.onEvent(listener),
    abort: async () => { await session.send({ type: "abort" }); },
    destroy: () => { session.destroy(); },
  };
}
