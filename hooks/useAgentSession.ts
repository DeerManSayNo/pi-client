"use client";

import { useState, useCallback, useRef, useEffect, useReducer, useMemo } from "react";
import { getLocalStorageItem } from "@/lib/client-storage";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { normalizeCompletedMessage, normalizeCompletedMessages, normalizeToolCalls } from "@/lib/normalize";
import { agentEventBus } from "@/lib/agent-event-bus";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ToolEntry } from "@/components/ToolPanel";

type ToolPreset = "none" | "default" | "full" | "custom";
const AUTO_CONTINUE_MESSAGE = "请从刚才中断的位置继续，不要重复已经完成的内容。如果上一步有未完成的工具调用或代码修改，请继续完成。";

/**
 * Compress expanded skill content back to /skill:name form for display.
 * The DeerHux SDK's _expandSkillCommand replaces /skill:name args with the full
 * skill file content when saving to .jsonl. This reverses that expansion
 * purely for display purposes — the model still receives the full content.
 *
 * Expanded format:
 *   <skill name="xxx" location="...">\n...\n</skill>\n\nargs
 *
 * Compressed format:
 *   /skill:xxx args
 */
function compressSkillText(text: string): string {
  const match = text.match(/^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>(?:\n\n)?([\s\S]*)$/);
  if (!match) return text;
  const skillName = match[1];
  const args = match[2].trim();
  return args ? `/skill:${skillName} ${args}` : `/skill:${skillName}`;
}

function compressMessageContent(msg: AgentMessage): AgentMessage {
  if (msg.role !== "user") return msg;
  const content = msg.content;
  if (typeof content === "string") {
    const compressed = compressSkillText(content);
    return compressed !== content ? { ...msg, content: compressed } : msg;
  }
  if (Array.isArray(content)) {
    let changed = false;
    const newContent = content.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        const compressed = compressSkillText(block.text);
        if (compressed !== block.text) {
          changed = true;
          return { ...block, text: compressed };
        }
      }
      return block;
    });
    return changed ? { ...msg, content: newContent } : msg;
  }
  return msg;
}

export interface SessionData {
  sessionId: string;
  filePath: string;
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    roleId?: string | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface ModelsResponse {
  models: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: ("text" | "image")[] }[];
  defaultModel?: { provider: string; modelId: string } | null;
  autoRecoveryModels?: ({ provider: string; modelId: string } | null)[];
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
}

let modelsPromise: Promise<ModelsResponse> | null = null;

function fetchModels(): Promise<ModelsResponse> {
  if (modelsPromise) return modelsPromise;

  modelsPromise = fetch("/api/models", { cache: "no-store" })
    .then((r) => r.json() as Promise<ModelsResponse>)
    .finally(() => {
      modelsPromise = null;
    });
  return modelsPromise;
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface UseAgentSessionOptions {
  activeTabId?: string | null;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: (sessionId: string, changedFiles?: string[]) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionStarted?: (session: SessionInfo | null) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onSystemPromptChange?: (prompt: string | null) => void;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: ToolPreset) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

function userContentKey(msg: AgentMessage | Partial<AgentMessage>): string | null {
  if (msg.role !== "user") return null;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return JSON.stringify([{ type: "text", text: compressSkillText(content).trim() }]);
  }
  if (!Array.isArray(content)) return null;

  const parts = content.map((block) => {
    if (typeof block !== "object" || block === null || !("type" in block)) return block;
    const blockRecord = block as Record<string, unknown>;
    if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
      return { type: "text", text: compressSkillText(blockRecord.text).trim() };
    }
    if (blockRecord.type === "image") {
      const source = typeof blockRecord.source === "object" && blockRecord.source !== null
        ? blockRecord.source as Record<string, unknown>
        : null;
      const mediaType = source
        ? (typeof source.media_type === "string" ? source.media_type
          : typeof source.mediaType === "string" ? source.mediaType
          : typeof source.mimeType === "string" ? source.mimeType
          : typeof source.mime_type === "string" ? source.mime_type
          : "")
        : (typeof blockRecord.mimeType === "string" ? blockRecord.mimeType
          : typeof blockRecord.mediaType === "string" ? blockRecord.mediaType
          : typeof blockRecord.media_type === "string" ? blockRecord.media_type
          : "");
      const data = source
        ? (typeof source.data === "string" ? source.data : "")
        : (typeof blockRecord.data === "string" ? blockRecord.data : "");
      const url = source
        ? (typeof source.url === "string" ? source.url : "")
        : (typeof blockRecord.url === "string" ? blockRecord.url : "");
      return { type: "image", mediaType, data, url };
    }
    return block;
  });
  return JSON.stringify(parts);
}

function getStreamingContentLength(msg: Partial<AgentMessage> | null | undefined): number {
  const content = msg?.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content.length : 0;
  let chars = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) continue;
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      chars += block.text.length;
    } else if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
      chars += block.thinking.length;
    } else if (block.type === "toolCall") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = block as any;
      if (b.input) chars += JSON.stringify(b.input).length;
      else if (b.arguments) chars += JSON.stringify(b.arguments).length;
    }
  }
  return chars;
}

export type WatchdogInfo = {
  eventIdleMs: number;
  contentIdleMs: number;
  eventThresholdMs: number;
  contentThresholdMs: number;
};

export type AutoRecoveryMode = "off" | "conservative" | "aggressive";
export type StallLevel = null | "warning" | "recovering";

type AgentStatus = {
  isStreaming?: boolean;
  isCompacting?: boolean;
  isRunning?: boolean;
  lastEventType?: string;
  eventIdleMs?: number | null;
  contentIdleMs?: number | null;
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    activeTabId,
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionStarted, onSessionForked,
    modelsRefreshKey, onSystemPromptChange,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(() => !isNew);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string; input?: ("text" | "image")[] }[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [autoRecoveryModels, setAutoRecoveryModels] = useState<({ provider: string; modelId: string } | null)[]>([]);
  const [newSessionModel, setNewSessionModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [watchdogInfo, setWatchdogInfo] = useState<WatchdogInfo | null>(null);
  const [lastModelError, setLastModelError] = useState<string | null>(null);
  const lastModelErrorRef = useRef<string | null>(null);
  const [modelsConfigVersion, bumpModelsConfigVersion] = useReducer((v: number) => v + 1, 0);

  // Auto-recovery mode persisted in localStorage
  const [autoRecoveryMode, setAutoRecoveryModeState] = useState<AutoRecoveryMode>(() => {
    if (typeof window === "undefined") return "conservative";
    const stored = getLocalStorageItem("deerhux.auto-recovery-mode");
    return (stored === "off" || stored === "aggressive") ? stored : "conservative";
  });
  const [stallLevel, setStallLevel] = useState<StallLevel>(null);
  const stallDismissedRef = useRef(false);
  const stallRecoveriesRef = useRef(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sseReconnectAttemptRef = useRef(0);
  const sseReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const agentRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const changedFilesRef = useRef<Set<string>>(new Set());
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const entryIdsRef = useRef<string[]>([]);
  const lastAgentEventAtRef = useRef(Date.now());
  const lastContentChangedAtRef = useRef(Date.now());
  const lastContentLengthRef = useRef(0);
  const autoRecoveryModelsRef = useRef<({ provider: string; modelId: string } | null)[]>([]);
  const watchdogCheckingRef = useRef(false);
  const watchdogStaleRecoveriesRef = useRef(0);
  // Tracks how many times the watchdog has auto-recovered this logical turn.
  // Reset only on user-initiated sends (handleSend / handleFollowUp), NOT in
  // resetTurnTracking(), so it survives across watchdog recovery cycles and
  // acts as a circuit breaker (max 3 auto-recoveries per user message).
  const autoRecoveryAttemptsRef = useRef(0);
  const agentPhaseRef = useRef<AgentPhase>(null);
  const autoContinueSentRef = useRef(false);
  const autoContinueInProgressRef = useRef(false);
  const abortCompletedRef = useRef(false);
  const receivedAssistantMessageRef = useRef(false);
  const awaitingAgentStartRef = useRef(false);
  const optimisticSessionIdRef = useRef<string | null>(null);
  const adoptingCreatedSessionRef = useRef<string | null>(null);
  const turnIdRef = useRef(0);

  // Shared reset: clears all per-turn tracking state. Called at the start of
  // every new turn (user send, follow_up, agent_start) to prevent stale
  // watchdog/error state leaking across turns.
  //
  // NOTE: autoContinueSentRef / autoContinueInProgressRef are NOT reset here.
  // They are managed exclusively by executeRecovery() and the agent_end handler.
  // Resetting them inside resetTurnTracking() creates a race window: if the
  // SDK's auto-retry fires an agent_start between executeRecovery's abort and
  // follow_up, the agent_start → resetTurnTracking() would clear the recovery
  // gate, causing two concurrent streams (SDK retry + our follow_up).
  // handleSend / handleFollowUp explicitly reset these refs for user-initiated turns.
  const resetTurnTracking = () => {
    watchdogStaleRecoveriesRef.current = 0;
    stallDismissedRef.current = false;
    stallRecoveriesRef.current = 0;
    setStallLevel(null);
    lastModelErrorRef.current = null;
    setLastModelError(null);
    receivedAssistantMessageRef.current = false;
    awaitingAgentStartRef.current = false;
    lastAgentEventAtRef.current = Date.now();
    lastContentChangedAtRef.current = Date.now();
    lastContentLengthRef.current = 0;
  };

  const setNewSessionModel = opts.setNewSessionModel ?? setNewSessionModelState;
  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? newSessionModel : currentModel;

  const sessionStats = useMemo(() => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  }, [messages]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      if (showLoading) setLoading(true);
      const url = includeState
        ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
        : `/api/sessions/${encodeURIComponent(sid)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData & { agentState?: { running: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean; isRunning?: boolean; contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; thinkingLevel?: string } } };
      if (sid !== sessionIdRef.current) return null;
      setData(d);
      setMessages(normalizeCompletedMessages(d.context.messages.map(compressMessageContent)));
      setEntryIds(d.context.entryIds ?? []);
      setCurrentModelOverride(null);
      setError(null);
      // If no live agent state, fall back to thinking level from session file
      if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
      return d.agentState ?? null;
    } catch (e) {
      if (sid === sessionIdRef.current) {
        setError(e instanceof DOMException && e.name === "AbortError" ? "加载会话超时" : String(e));
      }
      return null;
    } finally {
      clearTimeout(timeout);
      if (sid === sessionIdRef.current) setLoading(false);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/components/ToolPanel");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const connectEvents = useCallback((sid: string) => {
    // Clear any pending reconnect timer from a previous attempt
    if (sseReconnectTimerRef.current) {
      clearTimeout(sseReconnectTimerRef.current);
      sseReconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    sseReconnectAttemptRef.current = 0;

    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        agentEventBus.emit(event);
        handleAgentEventRef.current?.(event);
      } catch {
        // ignore
      }
    };
    es.onopen = () => {
      sseReconnectAttemptRef.current = 0;
      // On reconnect, verify we didn't miss agent_end during the backoff gap.
      // If the backend session has already finished, sync state locally so the
      // UI doesn't stay stuck in "streaming" mode waiting for events that will
      // never arrive.
      fetch(`/api/agent/${encodeURIComponent(sid)}`)
        .then((r) => r.json())
        .then((d: { running?: boolean; status?: AgentStatus }) => {
          if (awaitingAgentStartRef.current) return;
          if (agentRunningRef.current && (!d.running || d.status?.isRunning === false)) {
            // Session ended while we were disconnected — dispatch a synthetic
            // agent_end so the client state resets cleanly.
            handleAgentEventRef.current?.({ type: "agent_end", willRetry: false });
          }
        })
        .catch(() => {});
    };
    es.onerror = () => {
      // Always close the broken EventSource so it doesn't keep reconnecting
      // after the session has ended.  Without this, stale EventSources leak.
      if (eventSourceRef.current !== es) {
        es.close();
        return;
      }
      es.close();
      eventSourceRef.current = null;

      if (!agentRunningRef.current) return;

      sseReconnectAttemptRef.current += 1;
      const attempt = sseReconnectAttemptRef.current;
      const MAX_ATTEMPTS = 10;
      if (attempt > MAX_ATTEMPTS) return;

      // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);

      sseReconnectTimerRef.current = setTimeout(() => {
        sseReconnectTimerRef.current = null;
        // Guard: only reconnect if we're still on the same session AND
        // the agent is still running.  Without this check, a tab switch
        // during the backoff delay would reconnect to the wrong session.
        if (agentRunningRef.current && sessionIdRef.current === sid) {
          connectEvents(sid);
        }
      }, delay);
    };
    return es;
  }, []);

  const ensureEventsConnected = useCallback((sid: string) => {
    const existing = eventSourceRef.current;
    if (sessionIdRef.current === sid && existing && existing.readyState !== EventSource.CLOSED) {
      return existing;
    }
    return connectEvents(sid);
  }, [connectEvents]);

  const waitForEventsReady = useCallback((sid: string, timeoutMs = 700) => new Promise<void>((resolve) => {
    const es = eventSourceRef.current;
    if (!es || sessionIdRef.current !== sid || es.readyState === EventSource.OPEN) {
      resolve();
      return;
    }

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      es.removeEventListener("open", done);
      es.removeEventListener("message", done);
      es.removeEventListener("error", done);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    timeout = setTimeout(done, timeoutMs);
    es.addEventListener("open", done);
    es.addEventListener("message", done);
    es.addEventListener("error", done);
  }), []);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  useEffect(() => {
    agentPhaseRef.current = agentPhase;
  }, [agentPhase]);

  useEffect(() => {
    autoRecoveryModelsRef.current = autoRecoveryModels;
  }, [autoRecoveryModels]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    lastAgentEventAtRef.current = Date.now();
    switch (event.type) {
      case "agent_file_changed": {
        const filePath = event.filePath;
        if (typeof filePath === "string" && filePath.trim()) {
          changedFilesRef.current.add(filePath);
        }
        break;
      }
      case "agent_start":
        turnIdRef.current += 1;
        // A fresh turn has started — reset all per-turn tracking.
        resetTurnTracking();
        awaitingAgentStartRef.current = false;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end": {
        // If the stale-event protection gate is still open (set by a
        // watchdog recovery cycle that sent abort), and abortCompletedRef
        // has NOT been set yet, this agent_end is from the aborted old
        // turn.  Consume it silently.
        //
        // Once abortCompletedRef is set (either by the abort's agent_end
        // or by the recovery timeout), the gate lets subsequent agent_ends
        // through — otherwise the follow_up's agent_end would be swallowed
        // and the UI would stay stuck in streaming mode indefinitely.
        if (autoContinueInProgressRef.current && !abortCompletedRef.current) {
          abortCompletedRef.current = true;
          break;
        }
        // Reset autoContinueSentRef when a normal agent_end is received.
        // This allows future watchdog recoveries if needed.
        if (autoContinueSentRef.current) {
          console.log('[Watchdog] agent_end received after auto-continue, resetting autoContinueSentRef');
          autoContinueSentRef.current = false;
        }
        stallDismissedRef.current = false;
        stallRecoveriesRef.current = 0;
        setStallLevel(null);
        watchdogStaleRecoveriesRef.current = 0;
        const eventData = event as { willRetry?: boolean; error?: string };
        const willRetry = eventData.willRetry ?? false;
        // Capture error from immediate prompt() failure (rpc-manager sends error field)
        if (eventData.error && !lastModelErrorRef.current) {
          lastModelErrorRef.current = eventData.error;
          setLastModelError(eventData.error);
        }
        // Show error if: retries were exhausted (lastModelError is set) OR the turn ended
        // without producing any assistant message (direct failure, auto-retry disabled)
        const endedWithError = (
          (lastModelErrorRef.current !== null) ||
          (!willRetry && !receivedAssistantMessageRef.current)
        );
        if (!willRetry && !receivedAssistantMessageRef.current && !lastModelErrorRef.current) {
          lastModelErrorRef.current = "模型响应失败";
          setLastModelError("模型响应失败");
        }
        // When the agent will retry automatically, keep agentRunning=true so the
        // UI stays in "streaming" mode and prevents accidental user "continue"
        // inputs that would collide with the SDK's auto-retry.
        if (willRetry) {
          // Keep running — auto_retry_end or the next agent_start will update state.
          // Don't clear retryInfo either; auto_retry_start will set it shortly.
          // Still reload session to capture partial output so far.
          if (sessionIdRef.current) {
            loadSession(sessionIdRef.current);
          }
          break;
        }
        setAgentRunning(false);
        setAgentPhase(null);
        if (!endedWithError) setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current && !endedWithError) {
          loadSession(sessionIdRef.current);
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: { contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string } }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
            })
            .catch(() => {});
        }
        // Reload session even on error to capture any partial output
        if (sessionIdRef.current && endedWithError) {
          loadSession(sessionIdRef.current);
        }
        const changedFiles = [...changedFilesRef.current];
        changedFilesRef.current.clear();
        if (sessionIdRef.current) onAgentEnd?.(sessionIdRef.current, changedFiles);
        break;
      }
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "assistant") {
          const normalizedMsg = normalizeToolCalls(msg as AgentMessage);
          const nextLen = getStreamingContentLength(normalizedMsg);
          if (nextLen !== lastContentLengthRef.current) {
            watchdogStaleRecoveriesRef.current = 0;
            lastContentLengthRef.current = nextLen;
            lastContentChangedAtRef.current = Date.now();
          }
          dispatch({ type: "update", message: normalizedMsg });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        const completed = event.message as AgentMessage | undefined;
        if (completed) {
          if (completed.role === "assistant") receivedAssistantMessageRef.current = true;
          const normalized = normalizeCompletedMessage(completed);
          setMessages((prev) => {
            // We optimistically append the user's prompt in handleSend/handleFollowUp.
            // DeerHux may later emit a message_end for that same user message; don't append it again.
            if (normalized.role === "user") {
              const completedKey = userContentKey(normalized);
              const lastUser = [...prev].reverse().find((m) => m.role === "user");
              if (completedKey && lastUser && userContentKey(lastUser) === completedKey) {
                return prev;
              }
            }
            return [...prev, normalized];
          });
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start":
        // Reset watchdog timers so the retry backoff period doesn't trigger a
        // false-positive stale-detection and a conflicting auto-continue.
        watchdogStaleRecoveriesRef.current = 0;
        lastContentChangedAtRef.current = Date.now();
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end": {
        const retryEndEvent = event as { success?: boolean; finalError?: string };
        if (retryEndEvent.success === false) {
          // Retries exhausted — finalize the stop.
          if (retryEndEvent.finalError) {
            lastModelErrorRef.current = retryEndEvent.finalError;
            setLastModelError(retryEndEvent.finalError);
          }
          if (agentRunningRef.current) {
            agentRunningRef.current = false;
            setAgentRunning(false);
            setAgentPhase(null);
            dispatch({ type: "end" });
          }
          // Reset autoContinueSentRef so watchdog can try again if needed
          autoContinueSentRef.current = false;
        }
        setRetryInfo(null);
        break;
      }
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
        } else if (!event.aborted) {
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
    }
  }, [loadSession, onAgentEnd]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[], roleId?: string) => {
    if (!message.trim() && !images?.length) return;
    if (agentRunningRef.current) return;
    // Set the ref immediately to prevent duplicate sends before React re-renders
    agentRunningRef.current = true;
    turnIdRef.current += 1;
    // Explicitly clear recovery state — a user-initiated send always starts a fresh turn
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    resetTurnTracking();
    autoRecoveryAttemptsRef.current = 0;
    awaitingAgentStartRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;

    let optimisticNewSession: SessionInfo | null = null;
    if (isNew && newSessionCwd) {
      const optimisticId = `pending-${Date.now().toString(36)}`;
      optimisticSessionIdRef.current = optimisticId;
      optimisticNewSession = {
        id: optimisticId,
        path: "",
        cwd: newSessionCwd,
        name: undefined,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 1,
        firstMessage: message,
      };
      onSessionStarted?.(optimisticNewSession);
    }

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let createdRealSession = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        if (selectedModel) setPendingModel(selectedModel);
        const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/ToolPanel");
        const toolNames = toolPreset === "none" ? PRESET_NONE : toolPreset === "default" ? PRESET_DEFAULT : PRESET_FULL;
        const res = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "create",
            toolNames,
            ...(piImages?.length ? { images: piImages } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
            ...(roleId ? { roleId } : {}),
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
        }
        const result = await res.json() as { sessionId: string };
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        adoptingCreatedSessionRef.current = realId;
        optimisticSessionIdRef.current = null;
        connectEvents(realId);
        await waitForEventsReady(realId);
        createdRealSession = true;
        onSessionCreated?.({
          id: realId,
          path: "",
          cwd: newSessionCwd,
          name: undefined,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: message,
        });
        await sendAgentCommand(realId, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } else if (session) {
        ensureEventsConnected(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
          ...(roleId ? { roleId } : {}),
        });
      }
    } catch (e) {
      if (optimisticNewSession && !createdRealSession) onSessionStarted?.(null);
      awaitingAgentStartRef.current = false;
      optimisticSessionIdRef.current = null;
      adoptingCreatedSessionRef.current = null;
      console.error("Failed to send message:", e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      // 400 with images → likely model doesn't support image input
      if (piImages?.length && /400/.test(errorMessage)) {
        lastModelErrorRef.current = errorMessage + " — 该模型可能不支持图片输入，请检查模型配置";
        setLastModelError(lastModelErrorRef.current);
      } else {
        lastModelErrorRef.current = errorMessage;
        setLastModelError(errorMessage);
      }
      // Remove the optimistically-inserted user message so the UI doesn't
      // show a dangling message with no reply.
      setMessages((prev) => prev.filter((m) => m !== userMsg));
      // Reset the ref synchronously so the watchdog and SSE reconnect logic
      // see the correct state immediately — not after the next React render.
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      // If connectEvents was called before sendAgentCommand threw (existing
      // session path), close the orphaned EventSource so it doesn't keep
      // retrying in the background for a prompt that was never sent.
      if (sseReconnectTimerRef.current) {
        clearTimeout(sseReconnectTimerRef.current);
        sseReconnectTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    }
  }, [isNew, newSessionCwd, newSessionModel, toolPreset, thinkingLevel, session, connectEvents, ensureEventsConnected, waitForEventsReady, onSessionCreated, onSessionStarted]);

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    try {
      await sendAgentCommand(sid, { type: "compact" });
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: `[steer] ${message}`, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: message, timestamp: Date.now() } as AgentMessage]);
    // Explicitly clear recovery state — a user-initiated follow_up always starts a fresh turn
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    resetTurnTracking();
    autoRecoveryAttemptsRef.current = 0;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  // Watchdog thresholds - can be configured via environment variables
  const WATCHDOG_STALE_EVENT_MS = parseInt(process.env.NEXT_PUBLIC_WATCHDOG_STALE_EVENT_MS || '', 10) || 60_000;  // 60 seconds (was 30s)
  const WATCHDOG_STALE_CONTENT_MS = parseInt(process.env.NEXT_PUBLIC_WATCHDOG_STALE_CONTENT_MS || '', 10) || 90_000;  // 90 seconds (was 45s)

  // Shared recovery flow: abort stuck turn, reload session, send follow_up.
  // Used by both the automatic watchdog (tiered) and the manual "中断并继续" button.
  const executeRecovery = useCallback(async (sid: string, attempt = 1) => {
    if (autoContinueSentRef.current) return;
    autoContinueSentRef.current = true;
    setStallLevel("recovering");
    const fallbackModel = autoRecoveryModelsRef.current[attempt - 1] ?? null;

    autoContinueInProgressRef.current = true;
    abortCompletedRef.current = false;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch {
      abortCompletedRef.current = true;
    }

    // Wait for the old turn's agent_end so it doesn't kill the new follow-up
    if (!abortCompletedRef.current) {
      const MAX_WAIT_MS = 8_000;
      const startWait = Date.now();
      while (!abortCompletedRef.current && (Date.now() - startWait) < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // If we timed out without seeing abort's agent_end, mark it as
      // handled so the follow_up's agent_end isn't swallowed by the gate.
      if (!abortCompletedRef.current) {
        abortCompletedRef.current = true;
      }
    }

    await loadSession(sid);

    turnIdRef.current += 1;
    resetTurnTracking();
    setRetryInfo(null);
    setAgentPhase({ kind: "waiting_model" });
    dispatch({ type: "reset" });
    dispatch({ type: "start" });

    agentRunningRef.current = true;
    setAgentRunning(true);
    setMessages((prev) => [...prev, { role: "user", content: `[continue] ${AUTO_CONTINUE_MESSAGE}`, timestamp: Date.now() } as AgentMessage]);

    connectEvents(sid);
    // Settle before firing follow_up so the server-side subscription is ready
    await new Promise((r) => setTimeout(r, 150));

    try {
      if (fallbackModel) {
        await sendAgentCommand(sid, {
          type: "set_model",
          provider: fallbackModel.provider,
          modelId: fallbackModel.modelId,
        });
        setCurrentModelOverride(fallbackModel);
      }
      await sendAgentCommand(sid, { type: "follow_up", message: AUTO_CONTINUE_MESSAGE });
      setStallLevel(null);
      // Recovery succeeded — close the gate so the follow_up's agent_end
      // is processed normally (not swallowed).
      autoContinueInProgressRef.current = false;
    } catch (e) {
      console.error("Recovery follow_up failed:", e);
      autoContinueInProgressRef.current = false;
      autoContinueSentRef.current = false;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setStallLevel(null);
      dispatch({ type: "end" });
    }
  }, [connectEvents, loadSession]);

  // Keep a lightweight UI-facing counter so users can see when the watchdog is
  // getting close to intervening.
  useEffect(() => {
    if (!agentRunning) {
      setWatchdogInfo(null);
      return;
    }

    const update = () => {
      const now = Date.now();
      setWatchdogInfo({
        eventIdleMs: now - lastAgentEventAtRef.current,
        contentIdleMs: now - lastContentChangedAtRef.current,
        eventThresholdMs: WATCHDOG_STALE_EVENT_MS,
        contentThresholdMs: WATCHDOG_STALE_CONTENT_MS,
      });
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [agentRunning, WATCHDOG_STALE_CONTENT_MS, WATCHDOG_STALE_EVENT_MS]);

  // Tiered business watchdog: detects stalled model turns and provides
  // configurable auto-recovery (off / conservative / aggressive).
  //
  // Phase 1 (warning):  show UI banner with manual "续跑" button
  // Phase 2 (reconnect): auto reconnect SSE
  // Phase 3 (auto-recover): abort + follow_up with continue message
  //
  // Skips when: tools are running, compacting, retrying, or mode is "off".
  // Uses longer thresholds for high/xhigh thinking levels.
  useEffect(() => {
    if (!agentRunning || autoRecoveryMode === "off") return;

    // Base thresholds per mode
    const isAggressive = autoRecoveryMode === "aggressive";
    const baseWarningMs = isAggressive ? 30_000 : 60_000;
    const baseReconnectMs = isAggressive ? 60_000 : 120_000;
    const baseRecoverMs = isAggressive ? 120_000 : 0; // 0 = never auto-recover in conservative

    // Scale thresholds up for high/xhigh thinking (reasoning models)
    const thinkingMultiplier =
      thinkingLevel === "xhigh" ? 2.0 :
      thinkingLevel === "high" ? 1.5 : 1.0;
    const warningMs = Math.round(baseWarningMs * thinkingMultiplier);
    const reconnectMs = Math.round(baseReconnectMs * thinkingMultiplier);
    const recoverMs = baseRecoverMs > 0 ? Math.round(baseRecoverMs * thinkingMultiplier) : 0;

    const CHECK_INTERVAL_MS = 5_000;

    // Recover: abort current stuck stream, reload session, and send
    // follow_up with a clear continue instruction so the model resumes
    // without duplicating completed content.
    const recoverWithContinue = async (sid: string) => {
      await executeRecovery(sid, autoRecoveryAttemptsRef.current);
    };

    // Session already finished — just reload and stop gracefully
    const recoverStop = async (sid: string) => {
      await loadSession(sid);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setStallLevel(null);
      dispatch({ type: "end" });
      autoContinueSentRef.current = false;
    };

    const id = setInterval(async () => {
      const sid = sessionIdRef.current;
      if (!sid || !agentRunningRef.current || watchdogCheckingRef.current) return;

      // Never trigger recovery while tools are running or compacting or retrying
      if (agentPhaseRef.current?.kind === "running_tools") {
        lastAgentEventAtRef.current = Date.now();
        lastContentChangedAtRef.current = Date.now();
        return;
      }
      if (retryInfo) {
        lastAgentEventAtRef.current = Date.now();
        return;
      }

      const now = Date.now();
      const contentIdleMs = now - lastContentChangedAtRef.current;
      // Primary signal: streaming content hasn't changed
      const noContentGrowth = lastContentLengthRef.current > 0 && contentIdleMs > warningMs;
      // Secondary signal: no events at all, with empty content
      const noEventNoContent = lastContentLengthRef.current === 0 && now - lastAgentEventAtRef.current > warningMs;
      if (!noContentGrowth && !noEventNoContent) return;

      // User dismissed the warning for this turn — don't escalate
      if (stallDismissedRef.current) return;

      console.log('[Watchdog] Stale detected:', {
        contentIdleMs,
        eventIdleMs: now - lastAgentEventAtRef.current,
        contentLength: lastContentLengthRef.current,
        stallRecoveries: stallRecoveriesRef.current,
        mode: autoRecoveryMode,
        warningMs,
        reconnectMs,
        recoverMs,
      });

      watchdogCheckingRef.current = true;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { cache: "no-store" });
        const d = await res.json().catch(() => ({})) as { running?: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean }; status?: AgentStatus };
        const status = d.status;

        // Backend compacting — reconnect and wait
        if (d.running && (d.state?.isCompacting || status?.isCompacting)) {
          connectEvents(sid);
          lastAgentEventAtRef.current = Date.now();
          lastContentChangedAtRef.current = Date.now();
          return;
        }

        // Backend already stopped — reload and stop.
        // Use isRunning (tracks active turn: agent_start → agent_end)
        // instead of isStreaming, which is false during normal gaps like
        // waiting-for-model or between tool-execution batches.
        if (!d.running || d.status?.isRunning === false) {
          console.log('[Watchdog] Backend stopped, calling recoverStop');
          await recoverStop(sid);
          return;
        }

        // If the last backend event is a completed assistant message, the model
        // is done and the UI is only missing the final agent_end bookkeeping.
        // Do not auto-send "continue" here: the assistant may be waiting for the
        // user to confirm the proposed next step.
        if (
          receivedAssistantMessageRef.current
          && status?.lastEventType === "message_end"
          && d.state?.isStreaming !== true
          && status?.isStreaming !== true
        ) {
          console.log('[Watchdog] Assistant message completed without agent_end, stopping locally');
          await recoverStop(sid);
          return;
        }

        // Backend still streaming — check tiered actions
        stallRecoveriesRef.current += 1;

        // Phase 1: Show warning banner (first detection)
        if (contentIdleMs >= warningMs && stallLevel !== "warning" && stallLevel !== "recovering") {
          console.log('[Watchdog] Phase 1: showing warning');
          setStallLevel("warning");
        }

        // Phase 2: Auto reconnect SSE (conservative: +60s, aggressive: +60s after warning)
        if (contentIdleMs >= reconnectMs) {
          console.log('[Watchdog] Phase 2: reconnecting SSE');
          connectEvents(sid);
          lastAgentEventAtRef.current = Date.now();
        }

        // Phase 3: Auto recover (aggressive mode only, after recoverMs)
        // Circuit breaker: max 3 auto-recoveries per logical user turn.
        // Without this, aggressive mode could loop indefinitely when the
        // model consistently fails (bad API key, persistent provider error).
        if (recoverMs > 0 && contentIdleMs >= recoverMs && !autoContinueSentRef.current) {
          const MAX_AUTO_RECOVERIES = 3;
          if (autoRecoveryAttemptsRef.current >= MAX_AUTO_RECOVERIES) {
            console.log('[Watchdog] Max auto-recoveries (%d) reached, stopping', MAX_AUTO_RECOVERIES);
            await recoverStop(sid);
            return;
          }
          autoRecoveryAttemptsRef.current += 1;
          console.log('[Watchdog] Phase 3: auto-recovering (attempt %d/%d)', autoRecoveryAttemptsRef.current, MAX_AUTO_RECOVERIES);
          await recoverWithContinue(sid);
          return;
        }

      } catch (e) {
        console.error("Agent watchdog failed:", e);
      } finally {
        watchdogCheckingRef.current = false;
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(id);
  }, [agentRunning, autoRecoveryMode, thinkingLevel, connectEvents, loadSession, retryInfo, stallLevel, executeRecovery]);

  // Manual recovery trigger — user clicks "中断并继续" when stall warning shown
  const handleAutoRecover = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !agentRunningRef.current) return;
    stallDismissedRef.current = true;
    // Reset auto-recovery counter — a manual user action indicates the user
    // is actively engaged and the watchdog should get a fresh allowance.
    autoRecoveryAttemptsRef.current = 0;
    await executeRecovery(sid, 1);
  }, [executeRecovery]);

  // User dismissed the stall warning — suppress further escalation this turn
  const handleDismissStall = useCallback(() => {
    stallDismissedRef.current = true;
    setStallLevel(null);
  }, []);

  // Persist auto-recovery mode to localStorage
  const handleAutoRecoveryModeChange = useCallback((mode: AutoRecoveryMode) => {
    setAutoRecoveryModeState(mode);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("deerhux.auto-recovery-mode", mode);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    const previousLevel = thinkingLevel;
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves DeerHux's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      // Roll back to the previous level on failure so the UI doesn't
      // show a stale selection that doesn't match backend reality.
      setThinkingLevel(previousLevel);
    }
  }, [thinkingLevel]);

  const handleToolPresetChange = useCallback(async (preset: Exclude<ToolPreset, "custom">) => {
    const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/ToolPanel");
    const toolNames = preset === "none" ? PRESET_NONE : preset === "default" ? PRESET_DEFAULT : PRESET_FULL;
    const previousPreset = toolPreset;
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
      // Roll back to the previous preset on failure.
      setToolPresetState(previousPreset);
    }
  }, [setToolPresetState, toolPreset]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const activeSessionId = session?.id;

  // Load or reset session when the active tab changes. Previously AppShell
  // forced a full ChatWindow remount via key={sessionKey}; responding to prop
  // changes here keeps the component tree alive and makes tab switches cheaper.
  useEffect(() => {
    const sessionId = activeSessionId;
    // If a brand-new session just received its real id, handleSend has already
    // connected SSE and populated optimistic messages. Do not tear it down just
    // because AppShell replaced the placeholder tab with the real session tab.
    if (sessionId && sessionId === sessionIdRef.current) return;
    if (sessionId && sessionId === optimisticSessionIdRef.current) return;
    if (sessionId && sessionId === adoptingCreatedSessionRef.current) {
      adoptingCreatedSessionRef.current = null;
      return;
    }

    let cancelled = false;

    // Cancel any pending SSE reconnect timer from the previous session
    if (sseReconnectTimerRef.current) {
      clearTimeout(sseReconnectTimerRef.current);
      sseReconnectTimerRef.current = null;
    }
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    agentRunningRef.current = false;
    awaitingAgentStartRef.current = false;
    optimisticSessionIdRef.current = null;
    adoptingCreatedSessionRef.current = null;
    autoContinueSentRef.current = false;
    watchdogStaleRecoveriesRef.current = 0;
    autoRecoveryAttemptsRef.current = 0;
    stallDismissedRef.current = false;
    stallRecoveriesRef.current = 0;
    setStallLevel(null);
    initialScrollDoneRef.current = false;
    pendingScrollToUserRef.current = false;
    changedFilesRef.current.clear();
    lastAgentEventAtRef.current = Date.now();
    lastContentChangedAtRef.current = Date.now();
    lastContentLengthRef.current = 0;
    lastModelErrorRef.current = null;
    setLastModelError(null);
    receivedAssistantMessageRef.current = false;
    setRetryInfo(null);
    setContextUsage(null);
    setSystemPrompt(null);
    setForkingEntryId(null);
    setIsCompacting(false);
    setCompactError(null);
    setAgentPhase(null);
    setWatchdogInfo(null);
    dispatch({ type: "reset" });

    if (!sessionId) {
      sessionIdRef.current = null;
      setData(null);
      setMessages([]);
      setEntryIds([]);
      setCurrentModelOverride(null);
      setPendingModel(null);
      setAgentRunning(false);
      setError(null);
      setLoading(false);
      return () => { cancelled = true; };
    }

    sessionIdRef.current = sessionId;
    setData(null);
    setMessages([]);
    setEntryIds([]);
    setCurrentModelOverride(null);
    setPendingModel(null);
    setAgentRunning(false);
    setError(null);

    loadSession(sessionId, true, true).then((agentState) => {
      if (cancelled || sessionIdRef.current !== sessionId) return;

      // 远程连接（例如微信 Bot）可能会在当前 session 空闲时从外部发起 prompt。
      // 之前只有“加载时已在运行”的 session 才连接 SSE，导致手机刚发来的 user 消息
      // 不能实时出现在已打开的 session 里，只能等手动刷新/回合结束后重新加载。
      // 这里改为：打开已有 session 时始终保持 SSE 连接，以便接收未来的外部消息事件。
      connectEvents(sessionId);

      if (agentState?.running) {
        loadTools(sessionId);
        // Reconnect SSE whenever a turn is active — isRunning stays true
        // across gaps (waiting-for-model, between tool batches, auto-retry
        // backoff) where isStreaming is temporarily false.
        // Falls back to true for pre-isRunning servers (undefined !== false).
        if (agentState.state?.isRunning !== false) {
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "waiting_model" });
        }
      }
      if (agentState?.state) {
        if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
        if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
        if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
        if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
      }
    });

    return () => {
      cancelled = true;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [connectEvents, loadSession, loadTools, activeTabId, newSessionCwd, activeSessionId]);

  useEffect(() => {
    entryIdsRef.current = entryIds;
  }, [entryIds]);

  // 兜底同步：远程连接（微信 Bot 等）可能从服务端直接写入当前 session，
  // 在某些 dev/runtime 场景下 SSE 事件不会可靠到达浏览器。这里对当前打开的
  // 已有 session 做轻量轮询，只在 entryIds 变化时刷新消息，避免必须右键 reload。
  useEffect(() => {
    if (!activeSessionId || newSessionCwd) return;
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      if (stopped || inFlight || sessionIdRef.current !== activeSessionId) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json() as SessionData;
        if (stopped || sessionIdRef.current !== activeSessionId) return;
        const prevKey = entryIdsRef.current.join("\0");
        const nextEntryIds = d.context.entryIds ?? [];
        const nextKey = nextEntryIds.join("\0");
        if (nextKey && nextKey !== prevKey) {
          setData(d);
          setMessages(normalizeCompletedMessages(d.context.messages.map(compressMessageContent)));
          setEntryIds(nextEntryIds);
          setCurrentModelOverride(null);
          setError(null);
        }
      } catch {
        // ignore transient polling errors
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(tick, 900);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeSessionId, newSessionCwd]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Load the configured model list fresh so ChatInput tracks ModelsConfig.
  useEffect(() => {
    let cancelled = false;
    fetchModels().then((d) => {
      if (cancelled) return;
      setModelNames(d.models);
      setAutoRecoveryModels(d.autoRecoveryModels ?? []);
      if (d.thinkingLevels) setModelThinkingLevels(d.thinkingLevels);
      if (d.thinkingLevelMaps) setModelThinkingLevelMaps(d.thinkingLevelMaps);
      if (d.modelList) {
        setModelList(d.modelList);
        if (isNew && d.modelList.length > 0) {
          const def = d.defaultModel;
          const match = def && d.modelList.find((m) => m.id === def.modelId && m.provider === def.provider);
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: d.modelList[0].provider, modelId: d.modelList[0].id };
          setNewSessionModel(selected);
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isNew, modelsRefreshKey, modelsConfigVersion, setNewSessionModel]);

  useEffect(() => {
    window.addEventListener("deerhux.models-updated", bumpModelsConfigVersion);
    return () => window.removeEventListener("deerhux.models-updated", bumpModelsConfigVersion);
  }, []);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  return {
    // State
    data, loading, error, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, lastModelError, currentModel, displayModel, sessionStats,
    agentPhase, watchdogInfo, stallLevel, autoRecoveryMode,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, setData, setMessages,
    setSystemPrompt, setLastModelError, handleAutoRecover, handleDismissStall, handleAutoRecoveryModeChange,
    dispatch, setAgentRunning, setForkingEntryId,
  };
}
