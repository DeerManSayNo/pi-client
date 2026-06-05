import path from "path";
import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cacheSessionPath } from "./session-reader";
import type { AgentSessionLike, ToolInfo } from "./pi-types";
import { getLiveIslandClient } from "./live-island-client";
import { applyRolePromptToSystemPrompt } from "./roles";
import { applyRolePromptConfigToPrompt, isRoleSystemPromptSectionEnabled } from "./system-prompt-decomposer";
import { indexExists } from "./code-index/database";
import { searchIndex } from "./code-index/search";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedString(value: unknown, keys: string[]): string | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function getEventContentLength(event: AgentEvent): number | null {
  if (event.type !== "message_start" && event.type !== "message_update") return null;
  const message = isRecord(event.message) ? event.message : null;
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let length = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") length += block.text.length;
    else if (typeof block.thinking === "string") length += block.thinking.length;
    else if ("input" in block) length += JSON.stringify(block.input ?? {}).length;
    else if ("arguments" in block) length += JSON.stringify(block.arguments ?? {}).length;
  }
  return length;
}

function extractToolName(event: AgentEvent): string {
  return typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : "";
}

function extractChangedFilePath(event: AgentEvent): string | null {
  const toolName = extractToolName(event);
  if (toolName !== "write" && toolName !== "edit") return null;

  return getNestedString(event, ["filePath"])
    ?? getNestedString(event, ["path"])
    ?? getNestedString(event, ["file_path"])
    ?? getNestedString(event, ["args", "file_path"])
    ?? getNestedString(event, ["args", "path"])
    ?? getNestedString(event, ["input", "file_path"])
    ?? getNestedString(event, ["input", "path"])
    ?? getNestedString(event, ["result", "filePath"])
    ?? getNestedString(event, ["result", "path"])
    ?? getNestedString(event, ["result", "file_path"]);
}

function resolveChangedFilePath(filePath: string, cwd: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
}

function setEffectiveSystemPrompt(session: AgentSessionLike, prompt: string): void {
  if (session.agent.state) session.agent.state.systemPrompt = prompt;

  // pi's AgentSession.prompt() resets agent.state.systemPrompt back to its
  // private _baseSystemPrompt before every turn. If we only mutate state here,
  // the UI preview looks correct but the next new prompt silently uses the old
  // built-in prompt again. Keep the base prompt in sync as well.
  (session as unknown as { _baseSystemPrompt?: string })._baseSystemPrompt = prompt;
}

const TOOL_EXECUTION_MODES: Record<string, "parallel" | "sequential"> = {
  read: "parallel",
  grep: "parallel",
  find: "parallel",
  ls: "parallel",
  code_search: "parallel",
  bash: "sequential",
  edit: "sequential",
  write: "sequential",
};

export function configureToolExecutionModes(session: AgentSessionLike): void {
  const forceSequential = process.env.PI_DISABLE_PARALLEL_TOOLS === "1" || process.env.PI_DISABLE_PARALLEL_TOOLS === "true";
  if (forceSequential) {
    (session.agent as unknown as { toolExecution?: "parallel" | "sequential" }).toolExecution = "sequential";
  }

  const resolveMode = (name: string) => forceSequential ? "sequential" : TOOL_EXECUTION_MODES[name];
  const registry = (session as unknown as { _toolRegistry?: Map<string, { name: string; executionMode?: "parallel" | "sequential" }> })._toolRegistry;
  for (const [name, tool] of registry ?? []) {
    const mode = resolveMode(name);
    if (mode) tool.executionMode = mode;
  }

  const definitions = (session as unknown as { _toolDefinitions?: Map<string, { definition?: { executionMode?: "parallel" | "sequential" } }> })._toolDefinitions;
  for (const [name, entry] of definitions ?? []) {
    const mode = resolveMode(name);
    if (mode && entry.definition) entry.definition.executionMode = mode;
  }

  const activeTools = (session.agent.state as { tools?: Array<{ name: string; executionMode?: "parallel" | "sequential" }> } | undefined)?.tools;
  for (const tool of activeTools ?? []) {
    const mode = resolveMode(tool.name);
    if (mode) tool.executionMode = mode;
  }
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingToolEvents = new Map<string, AgentEvent>();
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private roleId: string | null = null;
  private temporaryRoleSettings: string[] = [];
  private baseSystemPrompt = "";
  private lastEventType = "";
  private lastEventAt = 0;
  private lastContentAt = 0;
  private eventCount = 0;
  private runStartedAt = 0;
  private lastContentLength = 0;

  constructor(public readonly inner: AgentSessionLike, roleId?: string | null) {
    this.roleId = roleId ?? null;
    this.baseSystemPrompt = inner.agent.state?.systemPrompt ?? "";
    this.applyRolePrompt();
  }

  private applyRolePrompt(): void {
    if (!this.inner.agent.state) return;
    const basePrompt = this.baseSystemPrompt;
    const configuredPrompt = applyRolePromptConfigToPrompt(basePrompt, this.roleId);
    const nextPrompt = isRoleSystemPromptSectionEnabled(this.roleId, "role_profile")
      ? applyRolePromptToSystemPrompt(configuredPrompt, this.roleId, this.temporaryRoleSettings, this.inner.sessionManager.getCwd())
      : configuredPrompt;
    setEffectiveSystemPrompt(this.inner, nextPrompt);
  }

  private setRole(roleId: string | null, persist = true): void {
    const normalized = roleId?.trim() || null;
    const changed = this.roleId !== normalized;
    this.roleId = normalized;
    this.applyRolePrompt();
    if (persist && changed && this.inner.sessionManager.isPersisted()) {
      try {
        this.inner.sessionManager.appendCustomEntry("role_profile", { roleId: this.roleId });
      } catch { /* best effort */ }
    }
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  start(): void {
    const liveIsland = getLiveIslandClient();
    const cwd = this.inner.sessionManager.getCwd();
    liveIsland.trackSession(this.inner.sessionId, cwd);

    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.recordEventStatus(event);
      this.resetIdleTimer();
      for (const l of this.listeners) l(event);

      // Forward to AIControls Live Island
      const currentCwd = this.inner.sessionManager.getCwd();
      liveIsland.handleEvent(this.inner.sessionId, currentCwd, event);

      if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
        this.pendingToolEvents.set(event.toolCallId, event);
        return;
      }
      const sourceEvent = event.type === "tool_execution_end" && typeof event.toolCallId === "string"
        ? { ...(this.pendingToolEvents.get(event.toolCallId) ?? {}), ...event }
        : event;
      if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
        this.pendingToolEvents.delete(event.toolCallId);
      }
      const changedFilePath = extractChangedFilePath(sourceEvent);
      if (changedFilePath && currentCwd) {
        const resolved = resolveChangedFilePath(changedFilePath, currentCwd);
        if (resolved) {
          for (const l of this.listeners) l({ type: "agent_file_changed", filePath: resolved, toolName: extractToolName(sourceEvent) });
        }
      }
    });
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(), 10 * 60 * 1000);
  }

  private recordEventStatus(event: AgentEvent): void {
    const now = Date.now();
    if (event.type === "agent_start" || !this.runStartedAt || (!this.inner.isStreaming && !this.inner.isCompacting)) {
      this.runStartedAt = now;
      this.eventCount = 0;
      this.lastContentLength = 0;
      this.lastContentAt = now;
    }
    this.eventCount += 1;
    this.lastEventType = event.type;
    this.lastEventAt = now;

    const nextContentLength = getEventContentLength(event);
    if (nextContentLength !== null && nextContentLength !== this.lastContentLength) {
      this.lastContentLength = nextContentLength;
      this.lastContentAt = now;
    }
  }

  getStatus() {
    const now = Date.now();
    const runningForMs = this.runStartedAt ? Math.max(0, now - this.runStartedAt) : 0;
    return {
      sessionId: this.sessionId,
      isStreaming: Boolean(this.inner.isStreaming),
      isCompacting: Boolean(this.inner.isCompacting),
      lastEventType: this.lastEventType,
      eventCount: this.eventCount,
      eventRate: runningForMs > 0 ? this.eventCount / (runningForMs / 1000) : 0,
      eventIdleMs: this.lastEventAt ? now - this.lastEventAt : null,
      contentIdleMs: this.lastContentAt ? now - this.lastContentAt : null,
    };
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        if (typeof command.roleId === "string") {
          this.setRole(command.roleId);
        }
        // Record prompt text for Live Island display
        if (command.message) {
          getLiveIslandClient().recordPrompt(this.inner.sessionId, command.message as string);
        }
        // Fire and forget — events come via subscribe.
        // But if prompt() rejects immediately (e.g. session destroyed), emit error to listeners.
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        this.inner.prompt(command.message as string, promptImages?.length ? { images: promptImages } : undefined).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          for (const l of this.listeners) l({ type: "agent_end", messages: [], willRetry: false, error: msg });
        });
        return null;
      }

      case "set_role": {
        this.setRole(typeof command.roleId === "string" ? command.roleId : null);
        return { roleId: this.roleId, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
      }

      case "set_system_prompt": {
        const rawPrompt = typeof command.prompt === "string" ? command.prompt : "";
        if (this.inner.agent.state) {
          this.baseSystemPrompt = rawPrompt;
          setEffectiveSystemPrompt(this.inner, rawPrompt);
        }
        this.applyRolePrompt();
        return {
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
        };
      }

      case "add_temporary_role_setting": {
        const text = typeof command.text === "string" ? command.text.trim() : "";
        if (text) this.temporaryRoleSettings.push(text);
        this.applyRolePrompt();
        return { ok: true, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
      }

      case "abort":
        await this.inner.abort();
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const registry = this.inner.modelRegistry;
        const model = registry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        // pi's compact() does not guard against empty messagesToSummarize — use findCutPoint
        // to pre-check and throw a clean error instead of generating a useless empty summary.
        const { findCutPoint, DEFAULT_COMPACTION_SETTINGS } = await import("@earendil-works/pi-coding-agent");
        const pathEntries = this.inner.sessionManager.getBranch() as Array<{ type: string }>;
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...this.inner.settingsManager.getCompactionSettings() };
        let prevCompactionIndex = -1;
        for (let i = pathEntries.length - 1; i >= 0; i--) {
          if (pathEntries[i].type === "compaction") { prevCompactionIndex = i; break; }
        }
        const boundaryStart = prevCompactionIndex + 1;
        const cutPoint = findCutPoint(pathEntries as never, boundaryStart, pathEntries.length, settings.keepRecentTokens);
        const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
        if (historyEnd <= boundaryStart) {
          throw new Error("Conversation too short to compact");
        }
        const result = await this.inner.compact(command.customInstructions as string | undefined);
        return result;
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "set_tools": {
        this.inner.setActiveToolsByName(command.toolNames as string[]);
        if (this.inner.agent.state) this.baseSystemPrompt = this.inner.agent.state.systemPrompt ?? "";
        this.applyRolePrompt();
        return null;
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function listRpcSessionStates(): Array<{ sessionId: string; isStreaming: boolean; isCompacting: boolean; lastEventType: string; eventCount: number; eventRate: number; eventIdleMs: number | null; contentIdleMs: number | null }> {
  return [...getRegistry().values()]
    .filter((session) => session.isAlive())
    .map((session) => session.getStatus());
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  roleId?: string | null
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    const { SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, createAgentSession expects string[] tool names instead of Tool[] instances.
    // Pass all built-in coding tool names by default; for "all off", pass empty array.
    const allCodingToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const hasCodeIndex = indexExists(cwd);
    const codeSearchTool = hasCodeIndex ? defineTool({
      name: "code_search",
      label: "Code Search",
      description: "Search the codebase using a pre-built index. Returns file paths, line ranges, and concise code snippets.",
      promptSnippet: "code_search: Search the indexed codebase by keywords and get file paths, line ranges, and snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query keywords" }),
        path: Type.Optional(Type.String({ description: "Restrict to files under this relative path" })),
        limit: Type.Optional(Type.Number({ description: "Maximum results, default 20" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, params, signal) => {
        const results = await searchIndex(cwd, params.query, {
          path: params.path,
          limit: params.limit ?? 20,
          signal,
        });
        const text = results.length
          ? results.map(r => `${r.path}:${r.startLine}-${r.endLine} (score ${r.score})\n${r.snippet}`).join("\n\n")
          : `No indexed results for: ${params.query}`;
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    }) : null;
    const availableToolNames = codeSearchTool ? [...allCodingToolNames, "code_search"] : allCodingToolNames;
    let toolsOption: string[] | undefined;
    if (toolNames !== undefined) {
      toolsOption = toolNames.length === 0 ? [] : availableToolNames;
    }

    const { session: inner } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
      ...(codeSearchTool ? { customTools: [codeSearchTool] } : {}),
    });

    configureToolExecutionModes(inner);

    // If specific tool names were requested (non-empty), narrow active tools now
    if (toolNames && toolNames.length > 0) {
      const knownTools = new Set(inner.getAllTools().map((tool: ToolInfo) => tool.name));
      inner.setActiveToolsByName(toolNames.filter(name => knownTools.has(name)));
    }

    // When all tools are disabled, clear the system prompt entirely.
    // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // the only way to truly clear it is to call agent.setSystemPrompt directly.
    if (toolNames?.length === 0) {
      setEffectiveSystemPrompt(inner, "");
    }

    const wrapper = new AgentSessionWrapper(inner, roleId);
    wrapper.start();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
