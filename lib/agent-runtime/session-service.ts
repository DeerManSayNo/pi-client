import { addAllowedRoot } from "@/lib/file-access";
import { resolveSessionPath, readSessionFileCached } from "@/lib/session-reader";
import { getRpcSession, startRpcSession, AgentSessionWrapper } from "@/lib/rpc-manager";

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export async function ensureRpcSession(sessionId: string): Promise<AgentSessionWrapper> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) return existing;

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionNotFoundError(sessionId);

  const { context, header } = readSessionFileCached(filePath);
  const cwd = header?.cwd ?? process.cwd();

  const { session } = await startRpcSession(
    sessionId,
    filePath,
    cwd,
    undefined,
    context.roleId ?? null,
    context.agentMode ?? "agent",
  );
  addAllowedRoot(cwd);
  return session;
}
