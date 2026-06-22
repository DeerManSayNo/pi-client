import path from "path";
import { existsSync, readFileSync } from "fs";
import { createAgentSession, defineTool, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import type { ToolInfo } from "./deerhux-types";
import { PiEngineAdapter } from "./engine/pi-engine-adapter";
import type { AgentEnginePort } from "./engine/port";
import { detectPiPrivateFields } from "./engine/sdk-guard";
import { createDeerLoop } from "./engine/factory";
import type { AnyToolDefinition } from "./engine/tool-registry";
import { isDeerLoopEnabled } from "./engine/feature-flag";
import { getLiveIslandClient } from "./live-island-client";
import { applyRolePromptToSystemPrompt } from "./roles";
import { applyRolePromptConfigToPrompt, isRoleSystemPromptSectionEnabled, readRoleSystemPromptConfig } from "./system-prompt-decomposer";
import { indexExists } from "./code-index/database";
import { searchIndex } from "./code-index/search";
import { createCodeGraphTools } from "./codegraph/tools";
import { createSubagentTool, SUBAGENT_TOOL_NAME } from "./parallel-agent/subagent-tool";
import { getAgentEventStore } from "./agent-runtime/event-store";
import type { FileReference, ImageContent, SkillReference, TextContent } from "./types";
import type { McpRuntime, McpRuntimeLease } from "./mcp-runtime";
import {
  applyModePrompt,
  getToolNamesForAgentMode,
  isReadOnlyAgentMode,
  normalizeAgentMode,
  stripModePrompt,
  type AgentMode,
} from "./agent-modes";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

interface SkillInvocation {
  name: string;
  content?: string;
}

interface PreparedTurnContext {
  message: string;
  displayMessage: string;
  references: FileReference[];
  skill?: SkillReference;
  systemPromptBlock: string;
}

type RuntimeImage = {
  type: "image";
  data?: string;      // base64 (legacy, may be empty when filePath is set)
  filePath?: string;   // absolute filesystem path (new — backend reads from disk)
  mimeType: string;
};

/** SDK image format — data is always a non-empty string when passed to the model. */
type SdkImage = { type: "image"; data: string; mimeType: string };

/** Filter RuntimeImage[] down to only those with resolved data, for SDK calls. */
function toSdkImages(images?: RuntimeImage[]): SdkImage[] | undefined {
  if (!images?.length) return undefined;
  const out: SdkImage[] = [];
  for (const img of images) {
    if (typeof img.data === "string" && img.data.length > 0) {
      out.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }
  return out.length > 0 ? out : undefined;
}

type DisplayUserContent = string | (TextContent | ImageContent)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileReferenceName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function escapeTurnContextText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseSkillCommand(message: string): { skillName: string; message: string } | null {
  const match = message.match(/^\/skill:([\w-]+)(?:\s|$)([\s\S]*)/);
  if (!match) return null;
  return { skillName: match[1], message: match[2].trim() };
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

function buildDisplayUserContent(message: string, images?: RuntimeImage[]): DisplayUserContent {
  if (!images?.length) return message;
  return [
    ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
    ...images.map((image) => {
      if (image.filePath) {
        // Use file URL reference so session files stay lean (no base64 bloat)
        return {
          type: "image" as const,
          source: { type: "url" as const, url: `/api/files${image.filePath}?type=read` },
        };
      }
      return {
        type: "image" as const,
        source: { type: "base64" as const, media_type: image.mimeType, data: image.data ?? "" },
      };
    }),
  ];
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

const TURN_CONTEXT_BLOCK_RE = /\n*<turn_context>[\s\S]*?<\/turn_context>\s*/g;

/**
 * Remove any `<turn_context>…</turn_context>` blocks left over from a previous
 * turn. The per-turn context block is appended to the system prompt by
 * `withTemporarySystemPrompt` and must never leak into `baseSystemPrompt` —
 * otherwise the first turn's context (references/skill/mode) would be frozen
 * into every subsequent turn. Call this whenever we capture the system prompt
 * back from `agent.state` (where the SDK may still hold a turn-specific value)
 * into our own `baseSystemPrompt`.
 */
function stripTurnContextBlock(prompt: string): string {
  return prompt.replace(TURN_CONTEXT_BLOCK_RE, "").trimEnd();
}

type ProjectContextFile = { path: string; content: string };

const PROJECT_CONTEXT_COMPACT_THRESHOLD = 2500;

function extractMarkdownSection(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`(^|\n)## ${escaped}\n([\s\S]*?)(?=\n## |$)`));
  return match?.[2]?.trim() ?? "";
}

function extractImportantBullets(section: string, limit = 12): string[] {
  const bullets: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") && !trimmed.startsWith("**")) continue;
    if (/^---+$/.test(trimmed)) continue;
    bullets.push(trimmed.replace(/\s+/g, " "));
    if (bullets.length >= limit) break;
  }
  return bullets;
}

function compactProjectContextContent(filePath: string, content: string): string {
  const fileName = path.basename(filePath).toLowerCase();
  if (!fileName.startsWith("agents") && !fileName.startsWith("claude")) return content;
  if (content.length <= PROJECT_CONTEXT_COMPACT_THRESHOLD) return content;

  const codingRules = extractImportantBullets(extractMarkdownSection(content, "编码规范"), 8);
  const quickStart = extractMarkdownSection(content, "快速开始");
  const quickStartLines = quickStart.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```") && (/npm run dev|tsc --noEmit|next lint|next build|绝不要/.test(line)))
    .slice(0, 6);
  const architectureLines = [
    "- 浏览器通过 /api/sessions 只读读取 session；发送消息走 POST /api/agent/[id]；事件流走 GET /api/agent/[id]/events。",
    "- session 读取主要在 lib/session-reader.ts；AgentSession 生命周期与进程内注册表主要在 lib/rpc-manager.ts。",
  ].filter(Boolean);
  const pitfalls = extractImportantBullets(extractMarkdownSection(content, "关键设计决策与陷阱"), 18);
  const sessionFormat = extractMarkdownSection(content, "DeerHux Session 文件格式");
  const sessionLines = sessionFormat.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /存放位置|parentSession|session_info|SessionContext|entryIds/.test(line))
    .slice(0, 6);

  const lines = [
    `# Project instructions summary for ${filePath}`,
    "",
    "This is a compact summary of the project context file. The full file can be read from the path above when a task requires detailed architecture, file maps, session format, or edge-case behavior.",
  ];

  if (codingRules.length > 0) lines.push("", "## 编码规范", ...codingRules);
  if (quickStartLines.length > 0) lines.push("", "## 快速开始与校验", ...quickStartLines.map((line) => line.startsWith("-") ? line : `- ${line}`));
  lines.push("", "## 架构要点", ...architectureLines);
  if (pitfalls.length > 0) lines.push("", "## 关键陷阱", ...pitfalls);
  if (sessionLines.length > 0) lines.push("", "## Session 文件提示", ...sessionLines.map((line) => line.startsWith("-") ? line : `- ${line}`));

  return lines.join("\n");
}

function compactProjectContextFiles(base: { agentsFiles: ProjectContextFile[] }): { agentsFiles: ProjectContextFile[] } {
  return {
    agentsFiles: base.agentsFiles.map((file) => ({
      ...file,
      content: compactProjectContextContent(file.path, file.content),
    })),
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FULL_PRESET_MARKERS = ["bash", "edit", "write", "grep", "find", "ls"];

function isFullToolPreset(toolNames: string[]): boolean {
  return FULL_PRESET_MARKERS.every((name) => toolNames.includes(name));
}

function includesMcpTool(toolNames: string[]): boolean {
  return toolNames.some((name) => name.startsWith("mcp__"));
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
  private staleWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private staleWarningSent = false;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private roleId: string | null = null;
  private agentMode: AgentMode = "agent";
  private modePromptEnabled = false;
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
  /** Stable string key for the currently-running turn, e.g. "sess:t3".
   * Attached to every stored/broadcast event so clients can filter by turn
   * and reconnect with precise replay boundaries. */
  private currentTurnKey: string | null = null;
  private sawAssistantEventInTurn = false;
  /** When true, the spawn_subagent tool is kept in the active tool set. */
  private _subagentEnabled = false;

  constructor(public readonly inner: AgentEnginePort, roleId?: string | null, private mcpRuntimeLease?: McpRuntimeLease | null, agentMode?: AgentMode | null) {
    this.roleId = roleId ?? null;
    this.agentMode = normalizeAgentMode(agentMode);
    this.modePromptEnabled = agentMode !== undefined && agentMode !== null;
    this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(inner.agent.state?.systemPrompt ?? ""));
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
    if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
  }

  /** Keep spawn_subagent in (or out of) the active tool set based on the toggle. */
  private applySubagentToActiveTools(): void {
    const all = this.inner.getAllTools();
    if (!all.some((t) => t.name === SUBAGENT_TOOL_NAME)) return; // tool not registered for this session
    const current = this.inner.getActiveToolNames();
    if (this._subagentEnabled) {
      if (!current.includes(SUBAGENT_TOOL_NAME)) {
        this.inner.setActiveToolsByName([...current, SUBAGENT_TOOL_NAME]);
      }
    } else if (current.includes(SUBAGENT_TOOL_NAME)) {
      this.inner.setActiveToolsByName(current.filter((name) => name !== SUBAGENT_TOOL_NAME));
    }
  }

  private applyRolePrompt(): void {
    if (!this.inner.agent.state) return;
    this.syncRoleMcpActiveTools();
    const configuredPrompt = applyRolePromptConfigToPrompt(this.baseSystemPrompt, this.roleId);
    const shouldApplyModePrompt = this.modePromptEnabled && isRoleSystemPromptSectionEnabled(this.roleId, "mode_control");
    const promptWithMode = shouldApplyModePrompt ? applyModePrompt(configuredPrompt, this.agentMode) : configuredPrompt;
    const nextPrompt = isRoleSystemPromptSectionEnabled(this.roleId, "role_profile")
      ? applyRolePromptToSystemPrompt(promptWithMode, this.roleId, this.temporaryRoleSettings, this.inner.sessionManager.getCwd())
      : promptWithMode;
    this.inner.setSystemPromptPersistent(nextPrompt);
  }

  private persistAgentMode(): void {
    if (!this.inner.sessionManager.isPersisted()) return;
    try {
      this.inner.sessionManager.appendCustomEntry("agent_mode", { mode: this.agentMode });
    } catch { /* best effort */ }
  }

  private async setAgentMode(mode: AgentMode, persist = true): Promise<void> {
    this.agentMode = normalizeAgentMode(mode);
    this.modePromptEnabled = true;
    if (this.agentMode === "agent" && this.mcpRuntime) {
      this.inner.setActiveToolsByName([...new Set([...getToolNamesForAgentMode(this.agentMode), ...this.mcpRuntime.toolNames])]);
    } else {
      this.inner.setActiveToolsByName(getToolNamesForAgentMode(this.agentMode));
    }
    this.applySubagentToActiveTools();
    if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
    this.applyRolePrompt();
    if (persist) this.persistAgentMode();
  }

  private appendDisplayUserMessage(content: unknown, references: FileReference[], skill?: SkillReference, clientMessageId?: string): void {
    if (!this.inner.sessionManager.isPersisted()) return;
    try {
      this.inner.sessionManager.appendCustomEntry("display_user_message", {
        content,
        ...(references.length ? { references } : {}),
        ...(skill ? { skill } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        agentMode: this.agentMode,
      });
    } catch { /* best effort: only affects UI history display */ }
  }

  private appendTurnContextMetadata(references: FileReference[], skill?: SkillReference): void {
    if (!this.inner.sessionManager.isPersisted()) return;
    try {
      this.inner.sessionManager.appendCustomEntry("turn_context", {
        mode: this.agentMode,
        ...(references.length ? { references } : {}),
        ...(skill ? { skill } : {}),
      });
    } catch { /* best effort: only affects UI metadata */ }
  }

  private async resolveSkillInvocation(name: string | undefined): Promise<SkillInvocation | undefined> {
    const skillName = name?.trim();
    if (!skillName) return undefined;
    const cwd = this.inner.sessionManager.getCwd();
    try {
      const { DefaultResourceLoader, getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const skill = loader.getSkills().skills.find((item: { name?: string }) => item.name === skillName);
      const filePath = (skill as { filePath?: unknown } | undefined)?.filePath;
      if (typeof filePath === "string" && existsSync(filePath)) {
        return { name: skillName, content: readFileSync(filePath, "utf8") };
      }
    } catch { /* fall through to DeerHux builtins */ }

    const builtinPath = path.join(process.cwd(), "lib", "builtin-skills", skillName, "SKILL.md");
    if (existsSync(builtinPath)) {
      return { name: skillName, content: readFileSync(builtinPath, "utf8") };
    }
    return { name: skillName };
  }

  private buildTurnSystemPromptBlock(ctx: { references: FileReference[]; skill?: SkillInvocation }): string {
    const lines = ["<turn_context>"];
    lines.push(`Current turn mode: ${this.agentMode}`);
    if (ctx.references.length > 0) {
      lines.push("");
      lines.push("User-selected references for this turn:");
      lines.push("Use these files or folders only if the user's request requires them. Do not summarize or analyze them just because they are listed.");
      for (const ref of ctx.references) lines.push(`- ${escapeTurnContextText(ref.path)}`);
    }
    if (ctx.skill) {
      lines.push("");
      lines.push(`Selected skill for this turn: ${ctx.skill.name}`);
      if (ctx.skill.content?.trim()) {
        lines.push("<selected_skill>");
        lines.push(ctx.skill.content.trim());
        lines.push("</selected_skill>");
      } else {
        lines.push("The selected skill content could not be loaded; proceed using the skill name as metadata only.");
      }
    }
    lines.push("</turn_context>");
    return lines.join("\n");
  }

  private async prepareTurnContext(rawMessage: string, rawReferences: unknown, rawSkillName: unknown): Promise<PreparedTurnContext> {
    const references = normalizeReferences(rawReferences);
    const parsedSkill = parseSkillCommand(rawMessage);
    const explicitSkillName = typeof rawSkillName === "string" ? rawSkillName : undefined;
    const skillName = explicitSkillName ?? parsedSkill?.skillName;
    const message = parsedSkill ? parsedSkill.message : rawMessage;
    const skillInvocation = await this.resolveSkillInvocation(skillName);
    const skill = skillInvocation ? { name: skillInvocation.name } : undefined;
    const displayMessage = message.trim() || (skill ? `使用技能：${skill.name}` : rawMessage);
    return {
      message: message.trim() || (skill ? `Use the selected skill: ${skill.name}.` : rawMessage),
      displayMessage,
      references,
      skill,
      systemPromptBlock: this.buildTurnSystemPromptBlock({ references, skill: skillInvocation }),
    };
  }

  private withTemporarySystemPrompt<T>(turnPromptBlock: string, run: () => Promise<T>): Promise<T> {
    // Strip any stale <turn_context> block that may have been baked into the
    // state by a previous turn (e.g. after a tool-set change during the turn
    // re-synced baseSystemPrompt from agent.state). This guarantees each turn
    // is assembled from the *current* role/mode config plus this turn's block,
    // so the model always sees the freshly-assembled prompt instead of the
    // very first turn's frozen context.
    const currentPrompt = stripTurnContextBlock(this.inner.agent.state?.systemPrompt ?? "");
    const nextPrompt = turnPromptBlock.trim() ? `${currentPrompt}\n\n${turnPromptBlock.trim()}` : currentPrompt;
    if (turnPromptBlock.trim()) this.inner.setSystemPromptPersistent(nextPrompt);
    return run().finally(() => {
      this.applyRolePrompt();
    });
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
      const turnKey = this.currentTurnKey;
      // Tag every event with the current turn key so real-time broadcasts
      // match SSE replay semantics (where turnId comes from the store).
      const tagged = turnKey ? { ...event, turnId: turnKey } as AgentEvent : event;
      getAgentEventStore().append({
        sessionId: this.inner.sessionId,
        runId: this.inner.sessionId,
        ...(turnKey ? { turnId: turnKey } : {}),
        event,
      });
      this.recordEventStatus(event);
      this.resetIdleTimer();
      for (const l of this.listeners) l(tagged);

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
          const fileChangedEvent: AgentEvent = { type: "agent_file_changed", filePath: resolved, toolName: extractToolName(sourceEvent) };
          getAgentEventStore().append({
            sessionId: this.inner.sessionId,
            runId: this.inner.sessionId,
            ...(this.currentTurnKey ? { turnId: this.currentTurnKey } : {}),
            event: fileChangedEvent,
          });
          for (const l of this.listeners) l(turnKey ? { ...fileChangedEvent, turnId: turnKey } as AgentEvent : fileChangedEvent);
        }
      }
    });
    this.resetIdleTimer();
  }

  // Idle timeout: keep inactive wrappers cheap, but never kill a running turn
  // just because a reasoning model stays quiet for longer than 10 minutes.
  private static readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  private static readonly ACTIVE_TURN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly TOOL_EXEC_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  // How long before the hard idle destroy we emit an `agent_stale_warning`
  // event, giving the frontend a chance to auto-recover (abort + follow_up)
  // instead of letting the session be torn down silently. This closes the gap
  // where the frontend watchdog missed its recovery window (e.g. the tab was
  // backgrounded and setInterval was throttled, or retry/tools phases skipped
  // the check). SSE pushes this event regardless of tab throttling.
  private static readonly IDLE_STALE_WARNING_LEAD_MS = 2 * 60 * 1000;

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.staleWarningTimer) clearTimeout(this.staleWarningTimer);
    // Any new event means the turn is making progress — allow the next idle
    // window to fire a fresh stale warning.
    this.staleWarningSent = false;
    const hasActiveTools = this.pendingToolEvents.size > 0;
    const timeout = hasActiveTools
      ? AgentSessionWrapper.TOOL_EXEC_IDLE_TIMEOUT_MS
      : this._isRunning
        ? AgentSessionWrapper.ACTIVE_TURN_IDLE_TIMEOUT_MS
        : AgentSessionWrapper.IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => this.destroy(), timeout);

    // Only schedule a stale warning while a turn is actively running. An idle
    // session (no active turn) has nothing to recover — destroying it is the
    // correct behavior, and emitting a warning would only spam the UI.
    if (this._isRunning) {
      const warningDelay = Math.max(
        timeout - AgentSessionWrapper.IDLE_STALE_WARNING_LEAD_MS,
        60_000,
      );
      if (warningDelay < timeout) {
        this.staleWarningTimer = setTimeout(() => this.emitStaleWarning(), warningDelay);
      }
    }
  }

  private emitStaleWarning(): void {
    if (!this._alive || this.staleWarningSent) return;
    const idleMs = this.lastEventAt ? Date.now() - this.lastEventAt : 0;
    // Defensive floor: if the last event was very recent, the turn is making
    // progress. This guards against misconfiguration (IDLE_STALE_WARNING_LEAD_MS
    // set so large that warningDelay collapses toward 0 and the timer fires
    // shortly after turn start) or future bugs that fail to clear the timer.
    // It cannot fully eliminate the event-loop race where a timer callback
    // (timers phase) runs just before a queued SDK I/O callback (poll phase)
    // that would have reset the timer — that window is tiny and the fallout
    // (one abort + follow_up) is acceptable, so we don't add setImmediate
    // indirection just for it.
    if (idleMs < 60_000) return;
    this.staleWarningSent = true;
    for (const l of this.listeners) {
      l({
        type: "agent_stale_warning",
        idleMs,
        destroyInMs: AgentSessionWrapper.IDLE_STALE_WARNING_LEAD_MS,
        isRunning: this._isRunning,
        isStreaming: Boolean(this.inner.isStreaming),
        lastEventType: this.lastEventType,
      });
    }
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

  private trackTurn(turnId: number, promise: Promise<void>): void {
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

    // 8s 后仍在跑 —— turn 卡死，拒绝继续，避免与新 turn 竞争 SDK 状态
    if (this._isRunning || this.inner.isStreaming) {
      throw new Error("abort timeout: current turn did not settle within 8s");
    }

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

    const nextActiveToolNames = activeBefore.filter((name) => !previousMcpToolNames.has(name) && !name.startsWith("mcp__"));
    if (activateMcp) nextActiveToolNames.push(...nextMcpToolNames);

    // H9：运行时热替换自定义工具。对 pi 私有字段（_customTools / _allowedToolNames /
    // _refreshToolRegistry）的直接操作已收敛到 AgentEnginePort.replaceCustomTools。
    // 这里只保留“保留哪些工具 / 激活哪些”的编排决策。
    this.inner.replaceCustomTools({
      removeNames: [...previousMcpToolNames],
      addTools: nextRuntime.tools,
      extraAllowedNames: [...nextMcpToolNames],
      activeToolNames: nextActiveToolNames,
    });
    this.inner.applyToolExecutionModes();

    if (this.inner.agent.state) {
      this.baseSystemPrompt = stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? "");
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
    images?: RuntimeImage[],
    displayMessage = message,
  ): Promise<{ message: string; images?: RuntimeImage[]; displayContent?: DisplayUserContent }> {
    if (!images?.length) return { message, images };

    // Resolve filePath → base64 data for images that are stored on disk.
    // This keeps session files lean (only file references) while still
    // sending actual image data to the model API when needed.
    const fs = await import("fs");
    const resolvedImages = await Promise.all(images.map(async (img) => {
      if (img.filePath && !img.data) {
        try {
          const fileData = fs.readFileSync(img.filePath);
          const base64 = fileData.toString("base64");
          return { ...img, data: base64 };
        } catch {
          // File read failed — pass through without data
          return img;
        }
      }
      return img;
    }));

    const displayContent = buildDisplayUserContent(displayMessage, resolvedImages);
    const supportsImageInput = (this.inner.model as { input?: string[] } | null | undefined)?.input?.includes("image") ?? false;
    if (supportsImageInput) return { message, images: resolvedImages, displayContent };

    const mcpRuntime = await this.ensureMcpRuntimeLoaded(false).catch(() => null);
    if (mcpRuntime) {
      const sdkFallbackImages = toSdkImages(resolvedImages);
      if (sdkFallbackImages?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawDescriptions = await mcpRuntime.describeImages(sdkFallbackImages as any, message).catch(() => [] as string[]);
        // Filter out error lines — keep only actual image descriptions.
        const validDescriptions = rawDescriptions.filter(
          (text) => !text.startsWith("MCP 图片识别失败") && !/^图片 \d+ 识别失败/.test(text),
        );
        if (validDescriptions.length > 0) {
          const imageContext = validDescriptions
            .map((text, index) => `图片 ${index + 1}:\n${text}`)
            .join("\n\n");
          return {
            message: `${message}\n\n<image_context source="mcp-vision-fallback">\n${imageContext}\n</image_context>\n\n注意：当前模型配置未勾选图片输入，上面的 image_context 是由 MCP 图片识别服务生成的，请基于该内容回答用户。`,
            images: undefined,
            displayContent,
          };
        }
      }
    }

    // No usable MCP vision fallback — just return the message without images.
    return { message, images: undefined, displayContent };
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

  /**
   * Prepare + commit + track a fresh prompt turn. Shared by `prompt` and
   * `recover` so both follow identical event/persistence semantics
   * (display_user_message append, message_end/user echo, trackTurn).
   */
  private async commitAndTrackPromptTurn(
    rawMessage: string,
    references: unknown,
    skillName: unknown,
    images: Array<{ type: "image"; data: string; mimeType: string }> | undefined,
    clientMessageId: string | undefined,
  ): Promise<{ turnId: string }> {
    const turnNum = ++this.activeTurnId;
    const turnKey = `${this.inner.sessionId}:t${turnNum}`;
    this.currentTurnKey = turnKey;
    const turnContext = await this.prepareTurnContext(rawMessage, references, skillName);
    if (turnContext.displayMessage) {
      getLiveIslandClient().recordPrompt(this.inner.sessionId, turnContext.displayMessage);
    }
    const prepared = await this.prepareImageFallback(turnContext.message, images, turnContext.displayMessage);

    const displayUserContent = prepared.displayContent ?? turnContext.displayMessage;
    const userEchoEvent = {
      type: "message_end",
      message: {
        role: "user",
        content: displayUserContent,
        ...(turnContext.references.length ? { references: turnContext.references } : {}),
        ...(turnContext.skill ? { skill: turnContext.skill } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        agentMode: this.agentMode,
        timestamp: Date.now(),
      },
    } as AgentEvent;
    // Mirror the synthetic user echo into the EventStore so pure-SSE
    // clients (e.g. WeChat bot) can replay it after reconnect — matches
    // how agent_file_changed is committed below.
    getAgentEventStore().append({
      sessionId: this.inner.sessionId,
      runId: this.inner.sessionId,
      ...(turnKey ? { turnId: turnKey } : {}),
      event: userEchoEvent,
    });
    for (const l of this.listeners) {
      l(turnKey ? { ...userEchoEvent, turnId: turnKey } as AgentEvent : userEchoEvent);
    }

    this.appendTurnContextMetadata(turnContext.references, turnContext.skill);
    this.appendDisplayUserMessage(displayUserContent, turnContext.references, turnContext.skill, clientMessageId);
    this.trackTurn(turnNum, this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
      this.inner.prompt(prepared.message, toSdkImages(prepared.images) ? { images: toSdkImages(prepared.images)! } : undefined)
    )));
    return { turnId: turnKey };
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
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const promptClientMessageId = typeof command.clientMessageId === "string" && command.clientMessageId.trim()
          ? command.clientMessageId.trim()
          : undefined;
        return this.commitAndTrackPromptTurn(promptText, command.references, command.skillName, promptImages, promptClientMessageId);
      }

      case "set_role": {
        this.setRole(typeof command.roleId === "string" ? command.roleId : null);
        return { roleId: this.roleId, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
      }

      case "set_system_prompt": {
        const rawPrompt = typeof command.prompt === "string" ? command.prompt : "";
        if (this.inner.agent.state) {
          this.baseSystemPrompt = stripModePrompt(rawPrompt);
          this.inner.setSystemPromptPersistent(rawPrompt);
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

      case "recover": {
        // Atomic abort-and-continue: settle the old turn, optionally switch
        // model, then start a fresh prompt turn. Replaces the frontend's
        // manual abort + while-wait + sleep(150) + follow_up choreography.
        //
        // 先切模型：失败时旧 turn 还活着，session 状态完全不变，前端可安全重试
        const provider = typeof command.provider === "string" ? command.provider.trim() : undefined;
        const modelId = typeof command.modelId === "string" ? command.modelId.trim() : undefined;
        let modelChanged = false;
        if (provider && modelId) {
          const registry = this.inner.modelRegistry;
          let model = registry.find(provider, modelId);
          if (!model) {
            const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
            model = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
          }
          if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
          await this.inner.setModel(model);
          modelChanged = true;
        }

        // 模型就绪后再 abort + settle + 开新 turn
        await this.abortAndSettleCurrentTurn();

        const recoverText = typeof command.message === "string" ? command.message : "";
        const recoverImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const recoverClientMessageId = typeof command.clientMessageId === "string" && command.clientMessageId.trim()
          ? command.clientMessageId.trim()
          : undefined;
        const recoverTurn = await this.commitAndTrackPromptTurn(recoverText, command.references, command.skillName, recoverImages, recoverClientMessageId);
        return { recovered: true, modelChanged, turnId: recoverTurn.turnId };
      }

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
          agentMode: this.agentMode,
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
        const turnContext = await this.prepareTurnContext(steerText, command.references, command.skillName);
        const prepared = await this.prepareImageFallback(turnContext.message, steerImages, turnContext.displayMessage);
        this.appendTurnContextMetadata(turnContext.references, turnContext.skill);
        this.appendDisplayUserMessage(prepared.displayContent ?? turnContext.displayMessage, turnContext.references, turnContext.skill);
        await this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
          this.inner.steer(prepared.message, toSdkImages(prepared.images))
        ));
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const followText = typeof command.message === "string" ? command.message : "";
        const turnContext = await this.prepareTurnContext(followText, command.references, command.skillName);
        const prepared = await this.prepareImageFallback(turnContext.message, followImages, turnContext.displayMessage);
        this.appendTurnContextMetadata(turnContext.references, turnContext.skill);
        this.appendDisplayUserMessage(prepared.displayContent ?? turnContext.displayMessage, turnContext.references, turnContext.skill);
        const imageOptions = toSdkImages(prepared.images) ? { images: toSdkImages(prepared.images)! } : undefined;
        const message = prepared.message;

        if (this._isRunning || this.inner.isStreaming) {
          // SDK followUp only queues for an already-active turn. It should be
          // sent while the turn is still active so the agent can drain it.
          await this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
            this.inner.followUp(message, toSdkImages(prepared.images))
          ));
          return null;
        }

        // If the previous turn was already aborted/stopped, followUp would only
        // sit in the queue and never trigger a model call. Start a fresh turn.
        const followTurnNum = ++this.activeTurnId;
        this.currentTurnKey = `${this.inner.sessionId}:t${followTurnNum}`;
        this.trackTurn(followTurnNum, this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
          this.inner.prompt(message, imageOptions)
        )));
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
        if (isReadOnlyAgentMode(this.agentMode)) {
          this.inner.setActiveToolsByName(getToolNamesForAgentMode(this.agentMode));
          if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
          this.applyRolePrompt();
          return null;
        }
        const isFullPreset = isFullToolPreset(requested);
        if (isFullPreset || includesMcpTool(requested)) {
          await this.ensureMcpRuntimeLoaded(true);
        }
        const toolNames = isFullPreset
          ? [...new Set([...requested, ...(this.mcpRuntime?.toolNames ?? [])])]
          : requested;
        this.inner.setActiveToolsByName(toolNames);
        this.applySubagentToActiveTools();
        if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
        this.applyRolePrompt();
        return null;
      }

      case "set_subagent_enabled": {
        this._subagentEnabled = command.enabled === true;
        this.applySubagentToActiveTools();
        if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
        this.applyRolePrompt();
        return { enabled: this._subagentEnabled };
      }

      case "get_mode": {
        return { mode: this.agentMode, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
      }

      case "set_mode": {
        const nextMode = normalizeAgentMode(command.mode);
        await this.setAgentMode(nextMode);
        return { mode: this.agentMode, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
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
    if (this.staleWarningTimer) clearTimeout(this.staleWarningTimer);
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
  roleId?: string | null,
  agentMode?: AgentMode | null,
  model?: { provider: string; modelId: string },
  options?: { allowSubagentTool?: boolean }
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  // ★ M6+ 默认走 DeerLoopEngine。DEERHUX_LOOP_ENGINE=pi 时回退到 pi 路径（紧急回退用）。
  if (isDeerLoopEnabled()) {
    const deerStarting = (async () => {
      const { session, realSessionId } = await startDeerLoopSession(
        sessionId, sessionFile, cwd, toolNames, roleId, agentMode, model, options,
      );
      return { session, realSessionId };
    })().finally(() => locks.delete(sessionId));
    locks.set(sessionId, deerStarting);
    return deerStarting;
  }

  const starting = (async () => {
    const { SessionManager, getAgentDir, DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      agentsFilesOverride: compactProjectContextFiles,
    });
    await resourceLoader.reload();

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
    const allowSubagentTool = options?.allowSubagentTool !== false;
    // Holder is mutated once the real session id is known so the subagent tool
    // can attach its runs to this session at execution time.
    const sessionIdHolder: { id: string | undefined } = { id: undefined };
    const subagentTool = allowSubagentTool ? createSubagentTool(cwd, { getParentSessionId: () => sessionIdHolder.id }) : null;
    const hasExplicitMode = agentMode !== undefined && agentMode !== null;
    const effectiveMode = normalizeAgentMode(agentMode);
    const requestedToolNames = toolNames ?? (hasExplicitMode ? getToolNamesForAgentMode(effectiveMode) : []);
    const shouldLoadMcpAtStartup = (!hasExplicitMode && isFullToolPreset(requestedToolNames)) || includesMcpTool(requestedToolNames);
    const mcpRuntimeLease = shouldLoadMcpAtStartup
      ? await import("./mcp-runtime").then(({ acquireMcpRuntime }) => acquireMcpRuntime(cwd))
      : null;
    const mcpRuntime = mcpRuntimeLease?.runtime ?? null;
    const customTools = [...(codeSearchTool ? [codeSearchTool] : []), ...codeGraphTools, ...(subagentTool ? [subagentTool] : []), ...(mcpRuntime?.tools ?? [])];
    const availableToolNames = [
      ...allCodingToolNames,
      ...(codeSearchTool ? ["code_search"] : []),
      ...codeGraphTools.map(tool => tool.name),
      ...(mcpRuntime?.toolNames ?? []),
    ];
    let toolsOption: string[] | undefined;
    if (toolNames !== undefined || hasExplicitMode) {
      if (requestedToolNames.length === 0) {
        toolsOption = [];
      } else if (!hasExplicitMode && isFullToolPreset(requestedToolNames)) {
        toolsOption = availableToolNames;
      } else {
        const available = new Set(availableToolNames);
        toolsOption = requestedToolNames.filter((name) => available.has(name));
      }
    }

    // spawn_subagent is registered as a custom tool, but the SDK derives its
    // allowed-tool whitelist (`allowedToolNames`) from the `tools` option. If
    // spawn_subagent isn't in that whitelist, `_refreshToolRegistry` filters it
    // out of the registry entirely — so `getAllTools()` never returns it and
    // the `set_subagent_enabled` toggle silently no-ops (applySubagentToActiveTools
    // early-returns). Add it to the whitelist whenever any tools are enabled;
    // whether it is *active* is still driven by `_subagentEnabled` via
    // setActiveToolsByName after creation.
    if (allowSubagentTool && toolsOption && toolsOption.length > 0 && !toolsOption.includes(SUBAGENT_TOOL_NAME)) {
      toolsOption.push(SUBAGENT_TOOL_NAME);
    }

    let inner: AgentSession;
    try {
      ({ session: inner } = await createAgentSession({
        cwd,
        agentDir,
        sessionManager,
        resourceLoader,
        settingsManager,
        ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
        ...(customTools.length > 0 ? { customTools } : {}),
      }));
    } catch (error) {
      mcpRuntimeLease?.release();
      throw error;
    }

    // 探测 pi 私有字段是否还在（SDK 升级漂移告警）。不阻断启动。
    detectPiPrivateFields(inner);

    // 用 Port 包裹 session：9 个 hack 集中到 PiEngineAdapter。
    const adapter = new PiEngineAdapter(inner);
    adapter.applyToolExecutionModes();
    adapter.installRetryHardening();

    // If specific tool names were requested (non-empty), narrow active tools now.
    // The frontend preset lists are static, so the "full" preset cannot enumerate
    // dynamically discovered MCP tool names. Treat the built-in full preset as
    // "all available runtime tools", including MCP.
    if (requestedToolNames.length > 0 && (toolNames !== undefined || hasExplicitMode)) {
      const knownTools = new Set(adapter.getAllTools().map((tool: ToolInfo) => tool.name));
      const isFullPreset = !hasExplicitMode && isFullToolPreset(requestedToolNames);
      const requested = requestedToolNames.filter(name => knownTools.has(name));
      if (isFullPreset) requested.push(...(mcpRuntime?.toolNames ?? []).filter(name => knownTools.has(name)));
      adapter.setActiveToolsByName([...new Set(requested)]);
    }

    // When all tools are disabled, clear the system prompt entirely.
    // DeerHux's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // the only way to truly clear it is to call agent.setSystemPrompt directly.
    if (toolNames?.length === 0) {
      adapter.setSystemPromptPersistent("");
    }

    const wrapper = new AgentSessionWrapper(adapter, roleId, mcpRuntimeLease, hasExplicitMode ? effectiveMode : undefined);
    wrapper.start();

    const realSessionId = adapter.sessionId;
    sessionIdHolder.id = realSessionId;
    const realSessionFile = adapter.sessionFile;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
    if (!sessionFile) invalidateSessionListCache();

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}

// ===========================================================================
// ★ M6+：自研 DeerLoopEngine 创建路径（默认，不再灰度）
//
// 取代 pi 的 createAgentSession：用 DeerLoopEngine + ToolRegistry + ToolExecutor 管理
// 整个 agent loop，pi-ai 只做 LLM 传输。注册与 pi 路径等价的真实工具集（code_search /
// codegraph / mcp / spawn_subagent），支持角色/模式 prompt 注入，走 SessionManager 做
// jsonl 持久化。
// ===========================================================================

/**
 * 创建 DeerLoopEngine，注册真实工具，包装成 AgentSessionWrapper，注册到 registry。
 *
 * @param sessionId 前端请求的会话 id
 * @param sessionFile 已有 jsonl 文件路径（fork/navigateTree/恢复时传入）
 * @param cwd 工作目录
 * @param toolNames 激活工具名（undefined=全部可用；[]=纯文本；[...]=指定集）
 * @param roleId 角色 id（null=无角色；undefined=由前端透传决定）
 * @param agentMode AgentMode（null=无模式；undefined=默认）
 */
async function startDeerLoopSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  roleId?: string | null,
  agentMode?: AgentMode | null,
  modelOverride?: { provider: string; modelId: string },
  options?: { allowSubagentTool?: boolean },
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // 选取默认 model。优先级：modelOverride（worker 继承父 session 的 model）
  // > DEERHUX_LOOP_MODEL 环境变量 > 第一个可用 model。worker 若退回默认
  // getAvailable()[0]，会与父 session 的 model 不一致（实测 deepseek-v4-pro
  // 不稳定会超时），导致 spawn_subagent 全军覆没。
  let model = modelRegistry.getAvailable()[0];
  const override = modelOverride
    ? `${modelOverride.provider}/${modelOverride.modelId}`
    : process.env.DEERHUX_LOOP_MODEL;
  if (override) {
    const [provider, modelId] = override.split("/");
    if (provider && modelId) {
      const found = modelRegistry.find(provider, modelId);
      if (found) model = found;
    }
  }
  if (!model) {
    throw new Error(
      "DeerLoopEngine 启动失败：未找到可用 model。请在 ~/.deerhux/agent 配置 API key，" +
        "或设 DEERHUX_LOOP_MODEL=provider/modelId 指定模型。",
    );
  }

  // ─── 工具准备（与 pi 路径对齐：code_search + codegraph + subagent + mcp）───
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
  const allowSubagentTool = options?.allowSubagentTool !== false;
  const sessionContextHolder: { id: string | undefined; model: { provider: string; modelId: string } | undefined } = { id: undefined, model: undefined };
  const subagentTool = allowSubagentTool ? createSubagentTool(cwd, {
    getParentSessionId: () => sessionContextHolder.id,
    getParentModel: () => sessionContextHolder.model,
  }) : null;

  const hasExplicitMode = agentMode !== undefined && agentMode !== null;
  const effectiveMode = normalizeAgentMode(agentMode);
  const requestedToolNames = toolNames ?? (hasExplicitMode ? getToolNamesForAgentMode(effectiveMode) : []);
  const shouldLoadMcpAtStartup = (!hasExplicitMode && isFullToolPreset(requestedToolNames)) || includesMcpTool(requestedToolNames);
  const mcpRuntimeLease = shouldLoadMcpAtStartup
    ? await import("./mcp-runtime").then(({ acquireMcpRuntime }) => acquireMcpRuntime(cwd))
    : null;
  const mcpRuntime = mcpRuntimeLease?.runtime ?? null;

  const customTools: AnyToolDefinition[] = [
    ...(codeSearchTool ? [codeSearchTool] : []),
    ...codeGraphTools,
    ...(subagentTool ? [subagentTool] : []),
    ...(mcpRuntime?.tools ?? []),
  ];
  const availableToolNames = [
    ...allCodingToolNames,
    ...(codeSearchTool ? ["code_search"] : []),
    ...codeGraphTools.map(t => t.name),
    ...(mcpRuntime?.toolNames ?? []),
  ];

  let activeToolNames: string[];
  if (toolNames !== undefined || hasExplicitMode) {
    if (requestedToolNames.length === 0) {
      activeToolNames = [];
    } else if (!hasExplicitMode && isFullToolPreset(requestedToolNames)) {
      activeToolNames = availableToolNames;
    } else {
      const available = new Set(availableToolNames);
      activeToolNames = requestedToolNames.filter(name => available.has(name));
    }
    if (allowSubagentTool && activeToolNames.length > 0 && !activeToolNames.includes(SUBAGENT_TOOL_NAME)) {
      activeToolNames.push(SUBAGENT_TOOL_NAME);
    }
  } else {
    // 未传 toolNames 且无 agentMode：激活全部可用工具（与 pi 路径默认行为对齐）
    activeToolNames = availableToolNames;
  }

  // ─── system prompt 构造（角色 + 模式）───
  let systemPrompt = "";
  if (roleId) {
    try {
      // applyRolePromptConfigToPrompt：角色配置文件注入
      systemPrompt = applyRolePromptConfigToPrompt(systemPrompt, roleId);
      // applyRolePromptToSystemPrompt：角色 prompt 注入（含 temporarySettings 等）
      systemPrompt = applyRolePromptToSystemPrompt(systemPrompt, roleId, [], cwd);
    } catch (e) {
      console.warn(`DeerLoopEngine: 角色 ${roleId} prompt 注入失败:`, e);
    }
  }
  if (hasExplicitMode) {
    systemPrompt = applyModePrompt(systemPrompt, effectiveMode);
  }
  // 全部工具关闭时清空 system prompt（对齐 pi 路径行为）
  if (toolNames?.length === 0) {
    systemPrompt = "";
  }

  // ★ M6 SessionManager（jsonl 持久化）。必须在创建 engine 前注入，
  // 否则 wrapper/DeerLoopEngine 会只拿到最小 no-op 代理，导致消息结束后 session 文件为空。
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, undefined)
    : SessionManager.create(cwd, undefined);
  // ★ 用 SessionManager 的真实 sessionId（uuid）作为 engine 的 sessionId，而不是
  //   前端/worker 传入的临时 key（如 `__collab__...`）。否则 registry 与
  //   subagent-registry 用临时 key 注册，而 SessionManager.listAll() 返回真实 uuid，
  //   两者对不上 → worker session 的 isSubagent 标记失效 → worker session 泄露到
  //   侧边栏项目列表（表现为「多出一模一样的 session」）。
  const realSessionId = sessionManager.getSessionId();

  // ─── 构造 DeerLoopEngine ───
  const engine: AgentEnginePort = createDeerLoop({
    model,
    cwd,
    sessionId: realSessionId,
    systemPrompt,
    // 用 ModelRegistry 解析 key，而不是直接 AuthStorage.getApiKey(provider)。
    // 原因：custom providers 的 apiKey/headers 可能来自 models.json，pi 路径也是通过
    // ModelRegistry.getApiKeyForProvider / getApiKeyAndHeaders 处理。直接读 AuthStorage
    // 会漏掉 Opencodego 等 models.json provider，导致 No API key。
    getApiKey: (provider) => modelRegistry.getApiKeyForProvider(provider),
    sessionManager,
    tools: customTools,
    activeToolNames,
  });

  // ★ M4：安装默认重试策略
  engine.installRetryHardening();

  // 用 AgentSessionWrapper 包装
  const wrapper = new AgentSessionWrapper(engine, roleId, mcpRuntimeLease, hasExplicitMode ? effectiveMode : undefined);
  wrapper.start();

  sessionContextHolder.id = realSessionId;
  const engineModel = engine.model;
  sessionContextHolder.model = engineModel
    ? { provider: String(engineModel.provider), modelId: String((engineModel as { id?: unknown }).id ?? "") }
    : undefined;
  const realSessionFile = sessionManager.getSessionFile?.() ?? undefined;
  if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
  if (!sessionFile) invalidateSessionListCache();

  wrapper.onDestroy(() => getRegistry().delete(realSessionId));
  getRegistry().set(realSessionId, wrapper);

  return { session: wrapper, realSessionId };
}
