import { SessionManager, buildSessionContext as piBuildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionInfo, SessionContext, AssistantMessage, FileReference, SkillReference } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { extractTurnMode, normalizeAgentMode, stripTurnModeContext, type AgentMode } from "./agent-modes";

const SESSION_LIST_TTL_MS = 30_000;

export { getAgentDir };

export function getSessionsDir(): string {
  return `${getAgentDir()}/sessions`;
}

declare global {
  var __deerhuxSessionListCache: {
    sessions: SessionInfo[];
    expiresAt: number;
    inflight?: Promise<SessionInfo[]>;
  } | undefined;
}

async function listAllSessionsUncached(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  const cache = getPathCache();
  return piSessions.map((s) => {
    // Populate path cache so resolveSessionPath works without a full scan
    cache.set(s.id, s.path);
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
    };
  });
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const now = Date.now();
  const cached = globalThis.__deerhuxSessionListCache;
  if (cached && cached.expiresAt > now) return cached.sessions;
  if (cached?.inflight) return cached.inflight;

  const inflight = listAllSessionsUncached().then((sessions) => {
    globalThis.__deerhuxSessionListCache = {
      sessions,
      expiresAt: Date.now() + SESSION_LIST_TTL_MS,
    };
    return sessions;
  }).finally(() => {
    const current = globalThis.__deerhuxSessionListCache;
    if (current?.inflight === inflight) {
      delete current.inflight;
    }
  });

  globalThis.__deerhuxSessionListCache = {
    sessions: cached?.sessions ?? [],
    expiresAt: 0,
    inflight,
  };
  return inflight;
}

export function invalidateSessionListCache(): void {
  globalThis.__deerhuxSessionListCache = undefined;
}

// ============================================================================
// Session path cache: sessionId → absolute file path
// Stored in globalThis for hot-reload safety
// ============================================================================
declare global {
  var __deerhuxSessionPathCache: Map<string, string> | undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__deerhuxSessionPathCache) globalThis.__deerhuxSessionPathCache = new Map();
  return globalThis.__deerhuxSessionPathCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  getPathCache().set(sessionId, filePath);
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
  invalidateSessionListCache();
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

/**
 * Strip large base64 image data from content blocks to keep API responses small.
 * Session files can contain multi-MB base64-encoded images embedded in
 * display_user_message entries. Sending these unchanged over HTTP causes
 * extreme latency and browser parsing overhead.
 *
 * We replace base64 image data with a short placeholder so the frontend can
 * still show image count/type without the payload cost. The frontend renders
 * a lightweight placeholder for images whose data has been stripped.
 */
function stripImageData(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    if (b.type !== "image") return block;

    // Keep the structure but replace base64 payload with a tiny sentinel.
    // source.data can be 5-10 MB of base64 text; we keep the first ~20 chars
    // so the frontend knows an image was attached without the data bloat.
    const source = b.source as Record<string, unknown> | undefined;
    if (source && typeof source.data === "string" && source.data.length > 200) {
      return {
        ...b,
        source: { ...source, data: source.data.slice(0, 20) + "…[stripped]" },
        _stripped: true,
      };
    }
    // Legacy flat field
    if (typeof b.data === "string" && b.data.length > 200) {
      return {
        ...b,
        data: b.data.slice(0, 20) + "…[stripped]",
        _stripped: true,
      };
    }
    return block;
  });
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model, roleId: null, agentMode: "agent" };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model, roleId: null, agentMode: "agent" };
  }

  const normalizeReferences = (value: unknown): FileReference[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): FileReference[] => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || !record.path.trim()) return [];
      const path = record.path.trim();
      const fallbackName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      return [{
        path,
        name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : fallbackName,
      }];
    });
  };

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  let roleId: string | null = null;
  let agentMode: AgentMode = "agent";
  const turnContextByMessageId = new Map<string, { agentMode?: AgentMode; references?: FileReference[]; skill?: SkillReference }>();
  let pendingTurnContext: { agentMode?: AgentMode; references?: FileReference[]; skill?: SkillReference } | null = null;
  for (const e of path) {
    if (e.type === "custom" && (e as { customType?: string }).customType === "role_profile") {
      const data = (e as { data?: { roleId?: unknown } }).data;
      roleId = typeof data?.roleId === "string" && data.roleId.trim() ? data.roleId.trim() : null;
    }
    if (e.type === "custom" && (e as { customType?: string }).customType === "agent_mode") {
      const data = (e as { data?: { mode?: unknown } }).data;
      agentMode = normalizeAgentMode(data?.mode);
    }
    if (e.type === "custom" && (e as { customType?: string }).customType === "turn_context") {
      const data = (e as { data?: { mode?: unknown; references?: unknown; skill?: { name?: unknown } } }).data;
      const references = normalizeReferences(data?.references);
      const skillName = typeof data?.skill?.name === "string" && data.skill.name.trim() ? data.skill.name.trim() : null;
      pendingTurnContext = {
        agentMode: normalizeAgentMode(data?.mode),
        ...(references.length ? { references } : {}),
        ...(skillName ? { skill: { name: skillName } } : {}),
      };
    }
    if (e.type === "message" && (e as { message?: { role?: unknown } }).message?.role === "user") {
      if (pendingTurnContext) {
        turnContextByMessageId.set(e.id, pendingTurnContext);
        pendingTurnContext = null;
      }
    }
  }

  // Find the last compaction on path (mirrors DeerHux's buildSessionContext logic)
  let compactionId: string | undefined;
  let firstKeptEntryId: string | undefined;
  for (const e of path) {
    if (e.type === "compaction") {
      compactionId = e.id;
      firstKeptEntryId = (e as { firstKeptEntryId: string }).firstKeptEntryId;
    }
  }

  const entryIds: string[] = [];
  if (compactionId) {
    // The first message in piCtx.messages is the synthetic compaction summary — map to compaction entry id
    entryIds.push(compactionId);
    const compactionIdx = path.findIndex((e) => e.id === compactionId);
    const firstKeptIdx = firstKeptEntryId
      ? path.findIndex((e, i) => i < compactionIdx && e.id === firstKeptEntryId)
      : -1;
    const startIdx = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx;
    for (let i = startIdx; i < compactionIdx; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
  } else {
    for (const e of path) {
      if (e.type === "message") entryIds.push(e.id);
    }
  }

  // DeerHux injects compaction summary as {role:"compactionSummary", summary, tokensBefore}.
  // Convert to {role:"user"} so MessageView can render it the same as before.
  const stripInternalUserContext = (content: string): string => {
    return stripTurnModeContext(content)
      .replace(/\n*<image_context source="mcp-vision-fallback">[\s\S]*?<\/image_context>\n*/g, "\n")
      .replace(/\n*注意：当前模型配置未勾选图片输入，上面的 image_context 是由 MCP 图片识别服务生成的，请基于该内容回答用户。\s*/g, "")
      .trim();
  };

  const getDisplayUserMessage = (entryId: string | undefined): { content: unknown; references?: FileReference[]; agentMode?: AgentMode; skill?: SkillReference } | null => {
    if (!entryId) return null;
    const entry = byId.get(entryId);
    if (!entry?.parentId) return null;
    const parent = byId.get(entry.parentId);
    if (parent?.type !== "custom" || (parent as { customType?: string }).customType !== "display_user_message") return null;
    const data = (parent as { data?: { content?: unknown; references?: unknown; agentMode?: unknown; skill?: { name?: unknown } } }).data;
    if (!data || !("content" in data)) return null;
    const references = normalizeReferences(data.references);
    const skillName = typeof data.skill?.name === "string" && data.skill.name.trim() ? data.skill.name.trim() : null;
    // Strip large base64 image payloads from display content to keep
    // session-load responses lean and avoid multi-second HTTP transfers.
    const displayContent = stripImageData(data.content);
    return {
      content: displayContent,
      ...(references.length ? { references } : {}),
      ...(data.agentMode ? { agentMode: normalizeAgentMode(data.agentMode) } : {}),
      ...(skillName ? { skill: { name: skillName } } : {}),
    };
  };

  const messages = (piCtx.messages as AssistantMessage[]).map((msg, index) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.role === "compactionSummary") {
      return {
        role: "user" as const,
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      };
    }
    const normalized = normalizeToolCalls(msg);
    if (normalized.role === "user") {
      const rawContent = typeof normalized.content === "string" ? normalized.content : "";
      const messageMode = extractTurnMode(rawContent) ?? undefined;
      const turnContext = entryIds[index] ? turnContextByMessageId.get(entryIds[index]) : undefined;
      const displayMessage = getDisplayUserMessage(entryIds[index]);
      if (displayMessage) return {
        ...normalized,
        content: displayMessage.content as typeof normalized.content,
        ...(displayMessage.references ?? turnContext?.references ? { references: displayMessage.references ?? turnContext?.references } : {}),
        ...(displayMessage.skill ?? turnContext?.skill ? { skill: displayMessage.skill ?? turnContext?.skill } : {}),
        agentMode: displayMessage.agentMode ?? turnContext?.agentMode ?? messageMode,
      };
      if (typeof normalized.content === "string" && (normalized.content.includes('<deerhux_turn_mode') || normalized.content.includes('<image_context source="mcp-vision-fallback">'))) {
        return {
          ...normalized,
          content: stripInternalUserContext(normalized.content),
          ...(turnContext?.references ? { references: turnContext.references } : {}),
          ...(turnContext?.skill ? { skill: turnContext.skill } : {}),
          ...(turnContext?.agentMode || messageMode ? { agentMode: turnContext?.agentMode ?? messageMode } : {}),
        };
      }
      // Strip image base64 data from raw user messages too (not just display_user_message).
      // Session message entries can also embed large base64 images directly in content arrays.
      const strippedContent = stripImageData(normalized.content);
      if (turnContext || messageMode) return {
        ...normalized,
        content: strippedContent as typeof normalized.content,
        ...(turnContext?.references ? { references: turnContext.references } : {}),
        ...(turnContext?.skill ? { skill: turnContext.skill } : {}),
        ...(turnContext?.agentMode || messageMode ? { agentMode: turnContext?.agentMode ?? messageMode } : {}),
      };
      // Always strip image data from user messages to keep API responses lean.
      if (strippedContent !== normalized.content) return { ...normalized, content: strippedContent as typeof normalized.content };
    }
    return normalized;
  });

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
    roleId,
    agentMode,
  };
}

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}



