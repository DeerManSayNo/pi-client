/**
 * Live Island bridge client for pi-agent.
 *
 * Connects to AIControls' Live Island TCP listener (127.0.0.1:38971) and
 * reports agent session events so pi-agent sessions appear in the macOS
 * 灵动岛 alongside Claude Code sessions.
 *
 * Protocol: same JSON-line format as AIControls' live-island-bridge.mjs.
 */

import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { AgentEvent } from "./rpc-manager";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOST = "127.0.0.1";
const PORT = 38971;
const RECONNECT_DELAY_MS = 2000;
const DONE_RETRACT_MS = 5_000;
const MAX_DETAIL_LENGTH = 56;

const PI_AGENT_BUNDLE_ID = "com.deermansayno.pi-agent";
const PI_AGENT_APP_NAME = "pi-agent";
const AICONTROLS_PI_AGENT_EXTENSION = `${homedir()}/.pi/agent/extensions/aicontrols-bridge.js`;

// ---------------------------------------------------------------------------
// Types (matching AIControls live_island.rs LiveIslandEvent)
// ---------------------------------------------------------------------------

type LiveIslandRowStatus =
  | "thinking" | "reading" | "editing" | "writing"
  | "running" | "searching" | "done" | "interrupted" | "error" | "waiting";

interface LiveIslandMessage {
  id: string;
  type: "update" | "remove" | "done-retract";
  project?: string;
  status?: LiveIslandRowStatus;
  detail?: string;
  prompt?: string;
  startedAt?: number;
  lastActiveAt?: number;
  detailStartedAt?: number;
  frozenElapsed?: number | null;
  frozenDetailElapsed?: number | null;
  delayMs?: number;
  cwd?: string;
  appBundleId?: string | null;
  appName?: string | null;
  appPid?: number | null;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionState {
  id: string;
  cwd: string;
  project: string;
  prompt: string;
  startedAt: number;
  lastActiveAt: number;
  detailStartedAt: number;
  islandStatus: LiveIslandRowStatus;
  islandDetail: string;
  finished: boolean;
  frozenElapsed: number | null;
  frozenDetailElapsed: number | null;
  activeToolCount: number;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(input: string, max: number): string {
  const compact = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function nowMs(): number {
  return Date.now();
}

function projectNameFromCwd(cwd: string): string {
  if (!cwd) return "pi-agent";
  const name = basename(cwd.replace(/\/+$/, ""));
  const metaDirs = new Set([
    ".claude", ".cursor", ".codex", ".hermes", ".openclaw",
    ".trae", ".qoder", ".qoderwork", ".kiro", ".config",
  ]);
  if (metaDirs.has(name)) {
    const parts = cwd.replace(/\/+$/, "").split("/");
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] && !metaDirs.has(parts[i])) return parts[i];
    }
  }
  return name || "pi-agent";
}

function hasAIControlsPiAgentExtension(): boolean {
  if (process.env.PI_AGENT_LIVE_ISLAND_FORCE === "1") return false;
  return existsSync(AICONTROLS_PI_AGENT_EXTENSION);
}

// ---------------------------------------------------------------------------
// Tool → Live Island status
// ---------------------------------------------------------------------------

function toolToStatus(toolName: string, input: Record<string, unknown> = {}): { status: LiveIslandRowStatus; detail: string } {
  const name = String(toolName ?? "").toLowerCase();
  const mcpShort = name.startsWith("mcp__")
    ? name.split("__").filter(Boolean).slice(1).join(" · ")
    : name;

  // Normalize known pi-agent tool names (pi SDK uses lowercase with optional prefixes)
  if (name === "read" || name.endsWith("_read")) {
    return { status: "reading", detail: truncate(`Read · ${basename(String(input.file_path ?? input.path ?? "")) || "file"}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "edit" || name.endsWith("_edit")) {
    return { status: "editing", detail: truncate(`Edit · ${basename(String(input.file_path ?? input.path ?? "")) || "file"}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "write" || name.endsWith("_write")) {
    return { status: "writing", detail: truncate(`Write · ${basename(String(input.file_path ?? input.path ?? "")) || "file"}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "bash" || name.endsWith("_bash") || name === "execute_command") {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").trim();
    return { status: "running", detail: truncate(`Bash · ${cmd || "shell"}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "grep" || name.includes("search_content")) {
    return { status: "searching", detail: truncate(`Grep · ${String(input.pattern ?? "text")}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "find" || name === "ls" || name === "list_files" || name === "glob" || name.includes("search_file")) {
    return { status: "searching", detail: truncate(`Search · ${String(input.path ?? "").split("/").pop() || "files"}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "task" || name === "agent" || name.includes("subagent")) {
    return { status: "running", detail: truncate(`Task · ${String(input.description ?? "sub-agent")}`, MAX_DETAIL_LENGTH) };
  }
  return { status: "running", detail: truncate(`${mcpShort} · tool`, MAX_DETAIL_LENGTH) };
}

// ---------------------------------------------------------------------------
// Live Island Client
// ---------------------------------------------------------------------------

class LiveIslandClient {
  private socket: Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessions = new Map<string, SessionState>();
  private pendingRemovals = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private disabled = false;
  private logPrefix = "[pi-agent-live-island]";

  private log(msg: string): void {
    console.error(`${this.logPrefix} ${msg}`);
  }

  start(): void {
    if (hasAIControlsPiAgentExtension()) {
      this.disabled = true;
      this.disposed = true;
      this.log(`bridge disabled; AIControls pi-agent extension is installed at ${AICONTROLS_PI_AGENT_EXTENSION}`);
      return;
    }
    this.disabled = false;
    this.disposed = false;
    this.connect();
    this.log("bridge started");
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.socket?.destroy();
    this.socket = null;
    this.sessions.clear();
    this.pendingRemovals.forEach((t) => clearTimeout(t));
    this.pendingRemovals.clear();
  }

  /** Register a pi-agent session. Called by AgentSessionWrapper.start(). */
  trackSession(sessionId: string, cwd: string): void {
    if (this.disabled) return;
    if (this.sessions.has(sessionId)) return;
    const now = nowMs();
    const project = projectNameFromCwd(cwd);
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      project,
      prompt: "",
      startedAt: now,
      lastActiveAt: now,
      detailStartedAt: now,
      islandStatus: "thinking",
      islandDetail: "Ready",
      finished: false,
      frozenElapsed: null,
      frozenDetailElapsed: null,
      activeToolCount: 0,
    });
    this.log(`tracked session: ${sessionId} project=${project} cwd=${cwd}`);
  }

  /** Record the user's prompt text — call BEFORE inner.prompt() in AgentSessionWrapper. */
  recordPrompt(sessionId: string, promptText: string): void {
    if (this.disabled) return;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.prompt = truncate(promptText, 48);
      this.log(`prompt recorded: ${sessionId} text="${session.prompt}"`);
    }
  }

  /** Handle a pi-agent event for a session. */
  handleEvent(sessionId: string, cwd: string, event: AgentEvent): void {
    if (this.disabled) return;
    if (this.disposed) return;

    const session = this.sessions.get(sessionId);
    if (!session) {
      // Auto-track if not already tracked (may happen for resumed sessions)
      this.trackSession(sessionId, cwd);
      const s = this.sessions.get(sessionId);
      if (!s) return;
      this.handleEventInternal(s, event);
      return;
    }

    session.lastActiveAt = nowMs();
    session.cwd = cwd || session.cwd;
    this.handleEventInternal(session, event);
  }

  private handleEventInternal(session: SessionState, event: AgentEvent): void {
    this.log(`event: session=${session.id.substring(0, 8)} type=${event.type} tool=${String(event.toolName ?? event.name ?? "")}`);

    switch (event.type) {
      case "agent_start":
        this.handleAgentStart(session);
        break;
      case "agent_end":
        this.handleAgentEnd(session);
        break;
      case "tool_execution_start":
        this.handleToolStart(session, event);
        break;
      case "tool_execution_end":
        this.handleToolEnd(session, event);
        break;
    }
  }

  // ---- TCP ----

  private connect(): void {
    if (this.disposed) return;
    this.socket?.destroy();

    this.socket = connect(PORT, HOST, () => {
      this.log(`connected to ${HOST}:${PORT}`);
      // Resend active sessions
      for (const [, session] of this.sessions) {
        if (!session.finished) {
          this.write(this.buildUpdate(session));
        }
      }
    });

    this.socket.on("error", (err) => {
      this.log(`connection error: ${err.message}`);
    });

    this.socket.on("close", () => {
      this.log("connection closed");
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.log(`reconnecting in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  private write(message: LiveIslandMessage): void {
    if (!this.socket || this.socket.destroyed) {
      this.log(`write skipped (no socket): id=${message.id} status=${message.status}`);
      return;
    }
    try {
      this.socket.write(JSON.stringify(message) + "\n");
    } catch (err) {
      this.log(`write error: ${String(err)}`);
    }
  }

  // ---- Message builders ----

  private buildUpdate(session: SessionState): LiveIslandMessage {
    return {
      id: session.id,
      type: "update",
      project: session.project,
      status: session.islandStatus,
      detail: session.islandDetail,
      prompt: session.prompt || session.islandDetail,
      startedAt: session.startedAt,
      lastActiveAt: session.lastActiveAt,
      detailStartedAt: session.detailStartedAt,
      frozenElapsed: session.finished ? (session.frozenElapsed ?? nowMs() - session.startedAt) : null,
      frozenDetailElapsed: session.finished ? (session.frozenDetailElapsed ?? nowMs() - session.detailStartedAt) : null,
      cwd: session.cwd,
      appBundleId: PI_AGENT_BUNDLE_ID,
      appName: PI_AGENT_APP_NAME,
      appPid: null,
    };
  }

  // ---- Event handlers ----

  private handleAgentStart(session: SessionState): void {
    this.cancelPendingRemoval(session.id);

    // Remove the existing row first so AIControls clears its internal
    // remove_at deadline (set by a previous done-retract). Without this,
    // AIControls may silently delete the row mid-run after the deadline
    // expires — even though client-side state has been reset.
    this.write({ id: session.id, type: "remove" });

    session.finished = false;
    session.activeToolCount = 0;
    session.frozenElapsed = null;
    session.frozenDetailElapsed = null;
    session.startedAt = nowMs();
    session.detailStartedAt = session.startedAt;
    session.islandStatus = "thinking";
    session.islandDetail = "Thinking · pi-agent";

    this.log(`agent_start: ${session.id.substring(0, 8)} project=${session.project}`);
    this.write(this.buildUpdate(session));
  }

  private handleAgentEnd(session: SessionState): void {
    if (session.finished) return;
    session.finished = true;
    session.frozenElapsed = nowMs() - session.startedAt;
    session.frozenDetailElapsed = nowMs() - session.detailStartedAt;
    session.islandStatus = "done";
    session.islandDetail = "Done · 完成";

    this.log(`agent_end: ${session.id.substring(0, 8)} elapsed=${session.frozenElapsed}ms`);
    this.write(this.buildUpdate(session));
    this.write({ id: session.id, type: "done-retract", delayMs: DONE_RETRACT_MS });
    this.scheduleSessionRemoval(session.id);
  }

  private handleToolStart(session: SessionState, event: AgentEvent): void {
    this.cancelPendingRemoval(session.id);
    session.activeToolCount++;
    session.finished = false;

    const toolName = String(event.toolName ?? event.name ?? "");
    const toolInput = (event.input ?? event.args ?? {}) as Record<string, unknown>;
    const { status, detail } = toolToStatus(toolName, toolInput);

    if (session.islandDetail !== detail) {
      session.detailStartedAt = nowMs();
    }
    session.islandStatus = status;
    session.islandDetail = detail;

    this.log(`tool_start: ${toolName} → ${status} "${detail}"`);
    this.write(this.buildUpdate(session));
  }

  private handleToolEnd(session: SessionState, event: AgentEvent): void {
    session.activeToolCount = Math.max(0, session.activeToolCount - 1);

    const hadError = event.error || event.isError;
    session.islandDetail = truncate(
      `${session.islandDetail} ${hadError ? "✗" : "✓"}`,
      MAX_DETAIL_LENGTH,
    );

    this.log(`tool_end: ok=${!hadError} detail="${session.islandDetail}"`);
    this.write(this.buildUpdate(session));
  }

  // ---- Session lifecycle ----

  private cancelPendingRemoval(sessionId: string): void {
    const timer = this.pendingRemovals.get(sessionId);
    if (timer) { clearTimeout(timer); this.pendingRemovals.delete(sessionId); }
  }

  private scheduleSessionRemoval(sessionId: string): void {
    this.cancelPendingRemoval(sessionId);
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(sessionId);
      this.write({ id: sessionId, type: "remove" });
      this.sessions.delete(sessionId);
      this.log(`session removed: ${sessionId.substring(0, 8)}`);
    }, DONE_RETRACT_MS + 1000);
    this.pendingRemovals.set(sessionId, timer);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const instance = new LiveIslandClient();
let started = false;

export function getLiveIslandClient(): LiveIslandClient {
  if (!started) {
    started = true;
    instance.start();
  }
  return instance;
}
