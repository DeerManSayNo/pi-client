import path from "path";
import { createAgentSession, defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import type { AgentSessionLike, ToolInfo } from "./deerhux-types";
import { getLiveIslandClient } from "./live-island-client";
import { applyRolePromptToSystemPrompt } from "./roles";
import { applyRolePromptConfigToPrompt, isRoleSystemPromptSectionEnabled, readRoleSystemPromptConfig } from "./system-prompt-decomposer";
import { indexExists } from "./code-index/database";
import { searchIndex } from "./code-index/search";
import { createCodeGraphTools } from "./codegraph/tools";
import type { FileReference } from "./types";
import type { McpRuntime, McpRuntimeLease } from "./mcp-runtime";

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

function fileReferenceName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function normalizeReferences(value: unknown): FileReference[] {
  if (!Array.isArray(value)) return [];
  const references: FileReference[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== "string") continue;
    const filePath = item.path.trim();
    if (!filePath) continue;
    references.push({
      path: filePath,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : fileReferenceName(filePath),
    });
  }
  return references;
}

function escapeReferenceText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function withAvailableReferences(message: string, references: FileReference[]): string {
  if (references.length === 0) return message;
  const referenceBlock = [
    "<available_references>",
    "The user selected these files or folders as optional context. Use them only if the user's request requires them. Do not summarize or analyze them just because they are listed.",
    ...references.map((ref) => `- ${escapeReferenceText(ref.path)}`),
    "</available_references>",
  ].join("\n");
  const skillPrefix = message.match(/^(\/skill:[\w-]+)(?:\s|$)([\s\S]*)/);
  if (skillPrefix) {
    const rest = skillPrefix[2].trim();
    return `${skillPrefix[1]} ${rest ? `${referenceBlock}\n\n${rest}` : referenceBlock}`;
  }
  return message.trim() ? `${referenceBlock}\n\n${message}` : referenceBlock;
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

  // DeerHux's AgentSession.prompt() resets agent.state.systemPrompt back to its
  // private _baseSystemPrompt before every turn. If we only mutate state here,
  // the UI preview looks correct but the next new prompt silently uses the old
  // built-in prompt again. Keep the base prompt in sync as well.
  (session as unknown as { _baseSystemPrompt?: string })._baseSystemPrompt = prompt;
}

const MIN_AUTO_RETRY_DELAY_MS = 5000;
const AUTO_RETRY_SETTLE_MS = 1000;
const PREMATURE_STREAM_ERROR_RE = /connection.?lost|websocket.?closed|websocket.?error|other side closed|ended without|stream ended before message_stop|http2 request did not get a response|terminated/i;

type AssistantLike = {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
};

function getAssistantContentLength(message: AssistantLike): number {
  const content = message.content;
  if (typeof content === "string") return content.trim().length;
  if (!Array.isArray(content)) return 0;

  let length = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") length += block.text.trim().length;
    else if (typeof block.thinking === "string") length += block.thinking.trim().length;
  }
  return length;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hardenAutoRetry(session: AgentSessionLike): void {
  const settingsManager = session.settingsManager as unknown as {
    getRetrySettings?: () => { enabled: boolean; maxRetries: number; baseDelayMs: number };
  };
  const originalGetRetrySettings = settingsManager.getRetrySettings?.bind(session.settingsManager);
  if (originalGetRetrySettings) {
    settingsManager.getRetrySettings = () => {
      const settings = originalGetRetrySettings();
      return { ...settings, baseDelayMs: Math.max(settings.baseDelayMs ?? 0, MIN_AUTO_RETRY_DELAY_MS) };
    };
  }

  const rawSession = session as unknown as {
    _isRetryableError?: (message: AssistantLike) => boolean;
    _prepareRetry?: (message: AssistantLike) => Promise<boolean>;
  };

  const originalIsRetryableError = rawSession._isRetryableError?.bind(session);
  if (originalIsRetryableError) {
    rawSession._isRetryableError = (message: AssistantLike) => {
      const retryable = originalIsRetryableError(message);
      if (!retryable) return false;

      // Premature-stream/transport-close errors are noisy: providers can emit
      // them after a complete-looking assistant message. Retrying those causes
      // an unnecessary `continue`. Only retry these when essentially no useful
      // assistant content was received.
      const err = message.errorMessage ?? "";
      if (PREMATURE_STREAM_ERROR_RE.test(err) && getAssistantContentLength(message) >= 20) {
        return false;
      }

      return true;
    };
  }

  const originalPrepareRetry = rawSession._prepareRetry?.bind(session);
  if (originalPrepareRetry) {
    rawSession._prepareRetry = async (message: AssistantLike) => {
      // Give SSE/tool/agent-end bookkeeping a clean quiet window before deciding
      // to send `continue`; this avoids racing other async cleanup paths.
      await sleepMs(AUTO_RETRY_SETTLE_MS);
      return originalPrepareRetry(message);
    };
  }
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

const FULL_PRESET_MARKERS = ["grep", "find", "ls"];

function isFullToolPreset(toolNames: string[]): boolean {
  return FULL_PRESET_MARKERS.every((name) => toolNames.includes(name));
}

function includesMcpTool(toolNames: string[]): boolean {
  return toolNames.some((name) => name.startsWith("mcp__"));
}

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
  /** Tracks whether an agent turn is actively running (agent_start → agent_end).
   *  Unlike isStreaming, this stays true during gaps between tool execution
   *  and the next model response, and during auto-retry backoff. */
  private _isRunning = false;
  private activeTurnId = 0;
  private activeTurnPromise: Promise<void> | null = null;
  private sawAssistantEventInTurn = false;

  constructor(public readonly inner: AgentSessionLike, roleId?: string | null, private mcpRuntimeLease?: McpRuntimeLease | null) {
    this.roleId = roleId ?? null;
    this.baseSystemPrompt = inner.agent.state?.systemPrompt ?? "";
    this.applyRolePrompt();
  }

  private get mcpRuntime(): McpRuntime | null {
    return this.mcpRuntimeLease?.runtime ?? null;
  }

  private syncRoleMcpActiveTools(): void {
    const allMcpToolNames = this.mcpRuntime?.toolNames ?? [];
    if (allMcpToolNames.length === 0) return;

    const config = readRoleSystemPromptConfig(this.roleId);
    const mcpSection = config.sections.find((s) => s.id === "mcp_tools");
    const allowedMcpToolNames = mcpSection?.enabled === false ? [] : (config.mcpToolNames ?? allMcpToolNames);
    const allowed = new Set(allowedMcpToolNames);
    const allMcp = new Set(allMcpToolNames);
    const activeBefore = this.inner.getActiveToolNames();
    const nonMcpActive = activeBefore.filter((name) => !allMcp.has(name) && !name.startsWith("mcp__"));
    const hadActiveMcp = activeBefore.some((name) => allMcp.has(name) || name.startsWith("mcp__"));
    const isFullPreset = ["grep", "find", "ls"].every((name) => nonMcpActive.includes(name));
    if (!hadActiveMcp && !isFullPreset) return;

    const nextMcpActive = allMcpToolNames.filter((name) => allowed.has(name));
    const nextActive = [...new Set([...nonMcpActive, ...nextMcpActive])];
    const currentKey = activeBefore.join("\0");
    const nextKey = nextActive.join("\0");
    if (currentKey === nextKey) return;

    this.inner.setActiveToolsByName(nextActive);
    if (this.inner.agent.state) this.baseSystemPrompt = this.inner.agent.state.systemPrompt ?? "";
  }

  private applyRolePrompt(): void {
    if (!this.inner.agent.state) return;
    this.syncRoleMcpActiveTools();
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
    if (this.unsubscribe) return;

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

  // Idle timeout: 10 min normally, but extended to 30 min during active tool
  // execution to avoid killing the session mid-build / mid-install.
  private static readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  private static readonly TOOL_EXEC_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const hasActiveTools = this.pendingToolEvents.size > 0;
    const timeout = hasActiveTools
      ? AgentSessionWrapper.TOOL_EXEC_IDLE_TIMEOUT_MS
      : AgentSessionWrapper.IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => this.destroy(), timeout);
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

    // Track active turn state (agent_start → agent_end).
    // Auto-retry keeps the turn alive: SDK emits agent_end with willRetry=true,
    // then either agent_start (retry success) or auto_retry_end with success=false.
    if (event.type === "agent_start") {
      this._isRunning = true;
      this.sawAssistantEventInTurn = false;
    }
    if (event.type === "agent_end") {
      const willRetry = (event as { willRetry?: boolean }).willRetry ?? false;
      if (!willRetry) {
        this._isRunning = false;
      }
    }
    if (event.type === "auto_retry_end") {
      const success = (event as { success?: boolean }).success ?? true;
      if (!success) {
        this._isRunning = false;
      }
    }

    const nextContentLength = getEventContentLength(event);
    if (nextContentLength !== null && nextContentLength !== this.lastContentLength) {
      this.lastContentLength = nextContentLength;
      this.lastContentAt = now;
    }
    if (
      (event.type === "message_start" || event.type === "message_update" || event.type === "message_end")
      && isRecord(event.message)
      && event.message.role === "assistant"
    ) {
      this.sawAssistantEventInTurn = true;
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
      isRunning: this._isRunning,
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

  private trackTurn(promise: Promise<void>): void {
    const turnId = ++this.activeTurnId;
    this.activeTurnPromise = promise;

    promise.catch((err: unknown) => {
      // If a recovery follow_up has already started, this rejection belongs to
      // the aborted old turn and must not mark the new turn as failed.
      if (!this._alive || this.activeTurnId !== turnId) return;
      this._isRunning = false;
      const msg = err instanceof Error ? err.message : String(err);
      for (const l of this.listeners) l({ type: "agent_end", messages: [], willRetry: false, error: msg });
    }).finally(() => {
      if (this.activeTurnId !== turnId) return;
      invalidateSessionListCache();
      this.activeTurnPromise = null;
      if (this._isRunning && !this.inner.isStreaming && this.sawAssistantEventInTurn) {
        this._isRunning = false;
        for (const l of this.listeners) l({ type: "agent_end", messages: [], willRetry: false });
      }
    });
  }

  private async waitForCurrentTurnToStop(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while ((this._isRunning || this.inner.isStreaming) && Date.now() - start < timeoutMs) {
      await sleepMs(50);
    }
  }

  private async abortAndSettleCurrentTurn(): Promise<void> {
    const turnPromise = this.activeTurnPromise;
    const turnId = this.activeTurnId;

    await this.inner.abort();
    await this.waitForCurrentTurnToStop(8_000);

    if (turnPromise && this.activeTurnId === turnId) {
      await Promise.race([
        turnPromise.catch(() => {}),
        sleepMs(2_000),
      ]);
    }
  }

  private installMcpRuntime(nextRuntime: McpRuntime, activateMcp: boolean): void {
    const previousRuntime = this.mcpRuntime;
    const previousMcpToolNames = new Set(previousRuntime?.toolNames ?? []);
    const nextMcpToolNames = new Set(nextRuntime.toolNames);
    const activeBefore = this.inner.getActiveToolNames();

    const rawSession = this.inner as unknown as {
      _customTools?: ToolDefinition[];
      _allowedToolNames?: Set<string>;
      _refreshToolRegistry?: (options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }) => void;
    };

    if (!Array.isArray(rawSession._customTools) || typeof rawSession._refreshToolRegistry !== "function") {
      throw new Error("Current AgentSession does not support runtime MCP reload");
    }

    if (rawSession._allowedToolNames && rawSession._allowedToolNames.size > 0) {
      for (const toolName of nextMcpToolNames) rawSession._allowedToolNames.add(toolName);
    }

    rawSession._customTools = [
      ...rawSession._customTools.filter((tool) => !previousMcpToolNames.has(tool.name) && !tool.name.startsWith("mcp__")),
      ...nextRuntime.tools,
    ];

    const nextActiveToolNames = activeBefore.filter((name) => !previousMcpToolNames.has(name) && !name.startsWith("mcp__"));
    if (activateMcp) nextActiveToolNames.push(...nextMcpToolNames);

    rawSession._refreshToolRegistry({ activeToolNames: [...new Set(nextActiveToolNames)], includeAllExtensionTools: true });
    configureToolExecutionModes(this.inner);

    if (this.inner.agent.state) {
      this.baseSystemPrompt = this.inner.agent.state.systemPrompt ?? "";
    }
    this.applyRolePrompt();
  }

  private async ensureMcpRuntimeLoaded(activateMcp = false): Promise<McpRuntime | null> {
    if (this.mcpRuntime) {
      if (activateMcp) this.installMcpRuntime(this.mcpRuntime, true);
      return this.mcpRuntime;
    }

    const cwd = this.inner.sessionManager.getCwd();
    const { acquireMcpRuntime } = await import("./mcp-runtime");
    const lease = await acquireMcpRuntime(cwd);
    try {
      this.installMcpRuntime(lease.runtime, activateMcp);
      this.mcpRuntimeLease = lease;
      return lease.runtime;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private async prepareImageFallback(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
    displayMessage = message,
  ): Promise<{ message: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; displayContent?: unknown }> {
    if (!images?.length) return { message, images };

    const supportsImageInput = (this.inner.model as { input?: string[] } | null | undefined)?.input?.includes("image") ?? false;
    if (supportsImageInput) return { message, images };

    const mcpRuntime = await this.ensureMcpRuntimeLoaded(false).catch(() => null);
    const descriptions = await mcpRuntime?.describeImages(images, message).catch((error: unknown) => [
      `MCP 图片识别失败：${error instanceof Error ? error.message : String(error)}`,
    ]);
    const imageContext = descriptions?.length
      ? descriptions.map((text, index) => `图片 ${index + 1}:\n${text}`).join("\n\n")
      : "当前模型未开启图片输入，且没有可用的 MCP 图片识别工具。";
    const displayContent = [
      ...(displayMessage.trim() ? [{ type: "text", text: displayMessage }] : []),
      ...images.map((image) => ({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.data },
      })),
    ];

    return {
      message: `${message}\n\n<image_context source="mcp-vision-fallback">\n${imageContext}\n</image_context>\n\n注意：当前模型配置未勾选图片输入，上面的 image_context 是由 MCP 图片识别服务生成的，请基于该内容回答用户。`,
      images: undefined,
      displayContent: displayContent.length ? displayContent : message,
    };
  }

  private async reloadMcpRuntime(): Promise<{ ok: boolean; skipped?: boolean; toolNames?: string[]; serverStatuses?: McpRuntime["serverStatuses"] }> {
    if (this._isRunning || this.inner.isStreaming || this.inner.isCompacting) {
      return { ok: false, skipped: true };
    }

    const cwd = this.inner.sessionManager.getCwd();
    const { createMcpRuntime } = await import("./mcp-runtime");
    const nextRuntime = await createMcpRuntime(cwd);
    const previousRuntime = this.mcpRuntime;
    const previousMcpToolNames = new Set(previousRuntime?.toolNames ?? []);
    const activeBefore = this.inner.getActiveToolNames();
    const hadActiveMcp = activeBefore.some((name) => previousMcpToolNames.has(name) || name.startsWith("mcp__"));
    const isFullPreset = isFullToolPreset(activeBefore);

    try {
      this.installMcpRuntime(nextRuntime, hadActiveMcp || isFullPreset);
    } catch (error) {
      nextRuntime.close();
      throw error;
    }

    this.mcpRuntimeLease?.release();
    this.mcpRuntimeLease = { runtime: nextRuntime, release: () => nextRuntime.close() };

    return { ok: true, toolNames: nextRuntime.toolNames, serverStatuses: nextRuntime.serverStatuses };
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        if (typeof command.roleId === "string") {
          this.setRole(command.roleId);
        }
        const promptText = typeof command.message === "string" ? command.message : "";
        const references = normalizeReferences(command.references);
        const modelMessage = withAvailableReferences(promptText, references);
        // Record prompt text for Live Island display
        if (promptText) {
          getLiveIslandClient().recordPrompt(this.inner.sessionId, promptText);
        }
        // Fire and forget — events come via subscribe. Track the promise so an
        // abort + follow_up recovery can wait for the old turn to settle.
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const prepared = await this.prepareImageFallback(modelMessage, promptImages, promptText);

        // 外部远程连接（如微信 Bot）触发 prompt 时，前端没有本地乐观追加 user 消息。
        // SDK 不一定会通过 subscribe 立即广播 user message，因此这里统一补发一条
        // message_end/user 事件，让已打开的 session 能第一时间显示远程用户刚发来的消息。
        // 前端本地输入框发送时已有去重逻辑，会跳过同内容的 user message_end，不会重复。
        const displayUserContent = prepared.displayContent ?? promptText;
        for (const l of this.listeners) {
          l({
            type: "message_end",
            message: {
              role: "user",
              content: displayUserContent,
              ...(references.length ? { references } : {}),
              timestamp: Date.now(),
            },
          });
        }

        if ((prepared.displayContent || references.length) && this.inner.sessionManager.isPersisted()) {
          try {
            this.inner.sessionManager.appendCustomEntry("display_user_message", {
              content: displayUserContent,
              ...(references.length ? { references } : {}),
            });
          } catch { /* best effort: only affects UI history display */ }
        }
        invalidateSessionListCache();
        this.trackTurn(this.inner.prompt(prepared.message, prepared.images?.length ? { images: prepared.images } : undefined));
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
        await this.abortAndSettleCurrentTurn();
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
          isRunning: this._isRunning,
          mcp: this.mcpRuntime ? {
            toolNames: this.mcpRuntime.toolNames,
            serverStatuses: this.mcpRuntime.serverStatuses,
          } : null,
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const registry = this.inner.modelRegistry;
        let model = registry.find(provider, modelId);

        // Existing AgentSession instances keep the ModelRegistry they were
        // created with. If ~/.deerhux/agent/models.json was edited while this
        // wrapper is alive, the UI may already show the new model (loaded via
        // /api/models) but the stale in-memory registry cannot find it. Try a
        // fresh registry before failing so newly-saved models are selectable
        // without restarting the app/session.
        if (!model) {
          const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
          model = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
        }

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
        invalidateSessionListCache();
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
        // DeerHux's compact() does not guard against empty messagesToSummarize — use findCutPoint
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
        const steerText = typeof command.message === "string" ? command.message : "";
        const references = normalizeReferences(command.references);
        const prepared = await this.prepareImageFallback(withAvailableReferences(steerText, references), steerImages, steerText);
        await this.inner.steer(prepared.message, prepared.images?.length ? prepared.images : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const followText = typeof command.message === "string" ? command.message : "";
        const references = normalizeReferences(command.references);
        const prepared = await this.prepareImageFallback(withAvailableReferences(followText, references), followImages, followText);
        const imageOptions = prepared.images?.length ? { images: prepared.images } : undefined;
        const message = prepared.message;

        if (this._isRunning || this.inner.isStreaming) {
          // SDK followUp only queues for an already-active turn. It should be
          // sent while the turn is still active so the agent can drain it.
          await this.inner.followUp(message, prepared.images?.length ? prepared.images : undefined);
          return null;
        }

        // If the previous turn was already aborted/stopped, followUp would only
        // sit in the queue and never trigger a model call. Start a fresh turn.
        this.trackTurn(this.inner.prompt(message, imageOptions));
        return null;
      }

      case "mcp_reload": {
        return this.reloadMcpRuntime();
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
        const requested = Array.isArray(command.toolNames) ? command.toolNames.filter((name): name is string => typeof name === "string") : [];
        const isFullPreset = isFullToolPreset(requested);
        if (isFullPreset || includesMcpTool(requested)) {
          await this.ensureMcpRuntimeLoaded(true);
        }
        const toolNames = isFullPreset
          ? [...new Set([...requested, ...(this.mcpRuntime?.toolNames ?? [])])]
          : requested;
        this.inner.setActiveToolsByName(toolNames);
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
    // Abort any ongoing agent turn (streaming, tools, retries) so underlying
    // WebSocket connections and child processes are released promptly.
    // Fire-and-forget: destroy() is called synchronously from idle timeout,
    // fork, and DELETE handler; blocking would delay those callers.
    this.inner.abort().catch(() => {});
    this.mcpRuntimeLease?.release();
    this.mcpRuntimeLease = null;
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __deerhuxSessions: Map<string, AgentSessionWrapper> | undefined;
  var __deerhuxStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__deerhuxSessions) {
    globalThis.__deerhuxSessions = new Map();
    const cleanup = () => globalThis.__deerhuxSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__deerhuxSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__deerhuxStartLocks) globalThis.__deerhuxStartLocks = new Map();
  return globalThis.__deerhuxStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function listRpcSessionStates(): Array<{ sessionId: string; isStreaming: boolean; isCompacting: boolean; lastEventType: string; eventCount: number; eventRate: number; eventIdleMs: number | null; contentIdleMs: number | null }> {
  return [...getRegistry().values()]
    .filter((session) => session.isAlive())
    .map((session) => session.getStatus());
}

export function reloadMcpForIdleSessions(): Promise<Array<{ sessionId: string; ok: boolean; skipped?: boolean; error?: string; toolNames?: string[] }>> {
  return Promise.all([...getRegistry().values()]
    .filter((session) => session.isAlive())
    .map(async (session) => {
      try {
        const result = await session.send({ type: "mcp_reload" }) as { ok?: boolean; skipped?: boolean; toolNames?: string[] };
        return { sessionId: session.sessionId, ok: result.ok === true, skipped: result.skipped, toolNames: result.toolNames };
      } catch (error) {
        return { sessionId: session.sessionId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), DeerHux generates its own id.
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
    const codeGraphTools = await createCodeGraphTools(cwd);
    const requestedToolNames = toolNames ?? [];
    const shouldLoadMcpAtStartup = isFullToolPreset(requestedToolNames) || includesMcpTool(requestedToolNames);
    const mcpRuntimeLease = shouldLoadMcpAtStartup
      ? await import("./mcp-runtime").then(({ acquireMcpRuntime }) => acquireMcpRuntime(cwd))
      : null;
    const mcpRuntime = mcpRuntimeLease?.runtime ?? null;
    const customTools = [...(codeSearchTool ? [codeSearchTool] : []), ...codeGraphTools, ...(mcpRuntime?.tools ?? [])];
    const availableToolNames = [
      ...allCodingToolNames,
      ...(codeSearchTool ? ["code_search"] : []),
      ...codeGraphTools.map(tool => tool.name),
      ...(mcpRuntime?.toolNames ?? []),
    ];
    let toolsOption: string[] | undefined;
    if (toolNames !== undefined) {
      toolsOption = toolNames.length === 0 ? [] : availableToolNames;
    }

    let inner: AgentSessionLike;
    try {
      ({ session: inner } = await createAgentSession({
        cwd,
        agentDir,
        sessionManager,
        ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
        ...(customTools.length > 0 ? { customTools } : {}),
      }));
    } catch (error) {
      mcpRuntimeLease?.release();
      throw error;
    }

    configureToolExecutionModes(inner);
    hardenAutoRetry(inner);

    // If specific tool names were requested (non-empty), narrow active tools now.
    // The frontend preset lists are static, so the "full" preset cannot enumerate
    // dynamically discovered MCP tool names. Treat the built-in full preset as
    // "all available runtime tools", including MCP.
    if (toolNames && toolNames.length > 0) {
      const knownTools = new Set(inner.getAllTools().map((tool: ToolInfo) => tool.name));
      const isFullPreset = isFullToolPreset(toolNames);
      const requested = toolNames.filter(name => knownTools.has(name));
      if (isFullPreset) requested.push(...(mcpRuntime?.toolNames ?? []).filter(name => knownTools.has(name)));
      inner.setActiveToolsByName([...new Set(requested)]);
    }

    // When all tools are disabled, clear the system prompt entirely.
    // DeerHux's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // the only way to truly clear it is to call agent.setSystemPrompt directly.
    if (toolNames?.length === 0) {
      setEffectiveSystemPrompt(inner, "");
    }

    const wrapper = new AgentSessionWrapper(inner, roleId, mcpRuntimeLease);
    wrapper.start();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
    if (!sessionFile) invalidateSessionListCache();

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
