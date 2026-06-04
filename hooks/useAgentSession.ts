"use client";

import { useState, useCallback, useRef, useEffect, useReducer, useMemo } from "react";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { normalizeCompletedMessage, normalizeCompletedMessages, normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ToolEntry } from "@/components/ToolPanel";

/**
 * Compress expanded skill content back to /skill:name form for display.
 * The pi SDK's _expandSkillCommand replaces /skill:name args with the full
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
  modelList?: { id: string; name: string; provider: string }[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
}

let modelsCache: ModelsResponse | null = null;
let modelsCacheKey: string | null = null;
let modelsPromise: Promise<ModelsResponse> | null = null;

function fetchModelsCached(cacheKey: string): Promise<ModelsResponse> {
  if (modelsCache && modelsCacheKey === cacheKey) return Promise.resolve(modelsCache);
  if (modelsPromise && modelsCacheKey === cacheKey) return modelsPromise;

  const requestedKey = cacheKey;
  modelsCacheKey = requestedKey;
  modelsPromise = fetch("/api/models")
    .then((r) => r.json() as Promise<ModelsResponse>)
    .then((data) => {
      if (modelsCacheKey === requestedKey) modelsCache = data;
      return data;
    })
    .finally(() => {
      if (modelsCacheKey === requestedKey) modelsPromise = null;
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
  onAgentEnd?: (changedFiles?: string[]) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionStarted?: (session: SessionInfo | null) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onSystemPromptChange?: (prompt: string | null) => void;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
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
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      return { type: "text", text: compressSkillText(block.text).trim() };
    }
    if (block.type === "image" && "source" in block && typeof block.source === "object" && block.source !== null) {
      const source = block.source as { media_type?: unknown; data?: unknown; url?: unknown };
      return {
        type: "image",
        mediaType: typeof source.media_type === "string" ? source.media_type : "",
        data: typeof source.data === "string" ? source.data : "",
        url: typeof source.url === "string" ? source.url : "",
      };
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
    } else if (block.type === "toolCall" && "input" in block) {
      chars += JSON.stringify(block.input ?? {}).length;
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

type AgentStatus = {
  isStreaming?: boolean;
  isCompacting?: boolean;
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
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
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

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const agentRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const changedFilesRef = useRef<Set<string>>(new Set());
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastAgentEventAtRef = useRef(Date.now());
  const lastContentChangedAtRef = useRef(Date.now());
  const lastContentLengthRef = useRef(0);
  const watchdogCheckingRef = useRef(false);
  const watchdogStaleRecoveriesRef = useRef(0);
  const autoContinueSentRef = useRef(false);
  const receivedAssistantMessageRef = useRef(false);

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
      const d = await res.json() as SessionData & { agentState?: { running: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean; contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; thinkingLevel?: string } } };
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
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        handleAgentEventRef.current?.(event);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      if (eventSourceRef.current === es && agentRunningRef.current) {
        es.close();
        eventSourceRef.current = null;
        setTimeout(() => {
          if (agentRunningRef.current) connectEvents(sid);
        }, 1000);
      }
    };
  }, []);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

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
        watchdogStaleRecoveriesRef.current = 0;
        lastAgentEventAtRef.current = Date.now();
        lastContentChangedAtRef.current = Date.now();
        lastContentLengthRef.current = 0;
        lastModelErrorRef.current = null;
        setLastModelError(null);
        receivedAssistantMessageRef.current = false;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end": {
        watchdogStaleRecoveriesRef.current = 0;
        const eventData = event as { willRetry?: boolean; error?: string };
        const willRetry = eventData.willRetry ?? true;
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
        onAgentEnd?.(changedFiles);
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
            // pi may later emit a message_end for that same user message; don't append it again.
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
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end": {
        const retryEndEvent = event as { success?: boolean; finalError?: string };
        if (retryEndEvent.success === false && retryEndEvent.finalError) {
          lastModelErrorRef.current = retryEndEvent.finalError;
          setLastModelError(retryEndEvent.finalError);
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
    autoContinueSentRef.current = false;
    watchdogStaleRecoveriesRef.current = 0;
    lastModelErrorRef.current = null;
    setLastModelError(null);
    receivedAssistantMessageRef.current = false;
    lastAgentEventAtRef.current = Date.now();
    lastContentChangedAtRef.current = Date.now();
    lastContentLengthRef.current = 0;

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
      optimisticNewSession = {
        id: `pending-${Date.now().toString(36)}`,
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
            type: "prompt",
            message,
            toolNames,
            ...(piImages?.length ? { images: piImages } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
            ...(roleId ? { roleId } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json() as { sessionId: string };
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        connectEvents(realId);
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
      } else if (session) {
        connectEvents(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
          ...(roleId ? { roleId } : {}),
        });
      }
    } catch (e) {
      if (optimisticNewSession) onSessionStarted?.(null);
      console.error("Failed to send message:", e);
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, toolPreset, thinkingLevel, session, connectEvents, onSessionCreated, onSessionStarted]);

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
    autoContinueSentRef.current = false;
    watchdogStaleRecoveriesRef.current = 0;
    lastModelErrorRef.current = null;
    setLastModelError(null);
    receivedAssistantMessageRef.current = false;
    lastAgentEventAtRef.current = Date.now();
    lastContentChangedAtRef.current = Date.now();
    lastContentLengthRef.current = 0;
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

  const WATCHDOG_STALE_EVENT_MS = 30_000;
  const WATCHDOG_STALE_CONTENT_MS = 45_000;
  const WATCHDOG_CHECK_INTERVAL_MS = 5_000;

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
  }, [agentRunning]);

  // Business watchdog for cases where the SSE connection is alive but the
  // streaming turn appears stuck or the terminal events were missed. It first
  // asks the server for the authoritative AgentSession state/status. A first
  // stale hit only reconnects SSE; if both frontend and backend remain stale on
  // the next hit, treat `isStreaming=true` as unreliable, abort the stuck run,
  // reload the session, and send one automatic "continue" follow-up.
  //
  // If the backend reports that the session has already stopped (isStreaming
  // is false or the session wrapper is gone), just reload the data and stop
  // the UI — do NOT send "continue", because the turn has already ended.
  useEffect(() => {
    if (!agentRunning) return;
    const STALE_EVENT_MS = WATCHDOG_STALE_EVENT_MS;
    const STALE_CONTENT_MS = WATCHDOG_STALE_CONTENT_MS;
    const CHECK_INTERVAL_MS = WATCHDOG_CHECK_INTERVAL_MS;

    // Recovery for genuinely stuck sessions (backend still thinks it's
    // streaming but no progress is being made). Aborts first, then
    // reloads and sends "continue" so the model picks up where it left off.
    const recoverWithContinue = async (sid: string, abortFirst: boolean) => {
      if (abortFirst) {
        try {
          await sendAgentCommand(sid, { type: "abort" });
        } catch (e) {
          console.error("Agent watchdog abort failed:", e);
        }
      }

      await loadSession(sid);
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });

      if (autoContinueSentRef.current) return;
      autoContinueSentRef.current = true;
      watchdogStaleRecoveriesRef.current = 0;
      lastAgentEventAtRef.current = Date.now();
      lastContentChangedAtRef.current = Date.now();
      lastContentLengthRef.current = 0;
      agentRunningRef.current = true;
      setMessages((prev) => [...prev, { role: "user", content: "continue", timestamp: Date.now() } as AgentMessage]);
      setAgentRunning(true);
      setAgentPhase({ kind: "waiting_model" });
      dispatch({ type: "start" });
      connectEvents(sid);
      try {
        await sendAgentCommand(sid, { type: "follow_up", message: "continue" });
      } catch (e) {
        console.error("Agent watchdog auto-continue failed:", e);
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
      }
    };

    // Recovery for sessions that the backend says have already finished.
    // This happens when the frontend missed the `agent_end` SSE event
    // (e.g. backgrounded tab, network hiccup) or the RPC wrapper was
    // destroyed by idle timeout. Just reload data from disk and stop the
    // UI — no need (and harmful) to send "continue".
    const recoverStop = async (sid: string) => {
      await loadSession(sid);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      autoContinueSentRef.current = false;
    };

    const id = setInterval(async () => {
      const sid = sessionIdRef.current;
      if (!sid || !agentRunningRef.current || watchdogCheckingRef.current) return;

      const now = Date.now();
      const noRecentEvent = now - lastAgentEventAtRef.current > STALE_EVENT_MS;
      const noContentGrowth = lastContentLengthRef.current > 0 && now - lastContentChangedAtRef.current > STALE_CONTENT_MS;
      if (!noRecentEvent && !noContentGrowth) return;

      watchdogCheckingRef.current = true;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { cache: "no-store" });
        const d = await res.json().catch(() => ({})) as { running?: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean }; status?: AgentStatus };
        const status = d.status;
        const backendNoRecentEvent = typeof status?.eventIdleMs === "number" && status.eventIdleMs > STALE_EVENT_MS;
        const backendNoContentGrowth = typeof status?.contentIdleMs === "number" && status.contentIdleMs > STALE_CONTENT_MS;
        const backendStale = backendNoRecentEvent || backendNoContentGrowth;

        if (d.running && (d.state?.isCompacting || status?.isCompacting)) {
          connectEvents(sid);
          lastAgentEventAtRef.current = Date.now();
          return;
        }

        if (d.running && d.state?.isStreaming !== false) {
          watchdogStaleRecoveriesRef.current += 1;

          // If only the browser has gone stale, this is probably an SSE hiccup.
          // Reconnect once (or repeatedly while backend is still visibly active).
          if (!backendStale || watchdogStaleRecoveriesRef.current <= 1) {
            connectEvents(sid);
            lastAgentEventAtRef.current = Date.now();
            return;
          }

          // Both frontend and backend agree the session is stuck while the
          // backend still thinks it's streaming — abort and send "continue".
          await recoverWithContinue(sid, true);
          return;
        }

        // Backend reports session has already finished (isStreaming is false
        // or the RPC wrapper is gone). The turn ended — just reload and stop.
        await recoverStop(sid);
      } catch (e) {
        console.error("Agent watchdog failed:", e);
      } finally {
        watchdogCheckingRef.current = false;
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(id);
  }, [agentRunning, connectEvents, loadSession]);

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
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, []);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/ToolPanel");
    const toolNames = preset === "none" ? PRESET_NONE : preset === "default" ? PRESET_DEFAULT : PRESET_FULL;
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

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

  // Load or reset session when the active tab changes. Previously AppShell
  // forced a full ChatWindow remount via key={sessionKey}; responding to prop
  // changes here keeps the component tree alive and makes tab switches cheaper.
  useEffect(() => {
    // If a brand-new session just received its real id, handleSend has already
    // connected SSE and populated optimistic messages. Do not tear it down just
    // because AppShell replaced the placeholder tab with the real session tab.
    if (session?.id && session.id === sessionIdRef.current) return;

    let cancelled = false;

    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    agentRunningRef.current = false;
    autoContinueSentRef.current = false;
    watchdogStaleRecoveriesRef.current = 0;
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

    if (!session) {
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

    sessionIdRef.current = session.id;
    setData(null);
    setMessages([]);
    setEntryIds([]);
    setCurrentModelOverride(null);
    setPendingModel(null);
    setAgentRunning(false);
    setError(null);

    loadSession(session.id, true, true).then((agentState) => {
      if (cancelled || sessionIdRef.current !== session.id) return;
      if (agentState?.running) {
        loadTools(session.id);
        if (agentState.state?.isStreaming) {
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "waiting_model" });
          connectEvents(session.id);
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
  }, [connectEvents, loadSession, loadTools, activeTabId, newSessionCwd, session?.id]);

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

  // Load model list (cached across ChatWindow tab switches)
  useEffect(() => {
    let cancelled = false;
    fetchModelsCached(String(modelsRefreshKey ?? 0)).then((d) => {
      if (cancelled) return;
      setModelNames(d.models);
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
  }, [isNew, modelsRefreshKey, setNewSessionModel]);

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
    agentPhase, watchdogInfo,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, setData, setMessages,
    setSystemPrompt, setLastModelError,
    dispatch, setAgentRunning, setForkingEntryId,
    // Subscriptions
    handleAgentEventRef,
  };
}
