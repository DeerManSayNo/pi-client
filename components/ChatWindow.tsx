"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle, type ChatInputState, type AttachedImage } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ChangedFilesList } from "./ChangedFilesList";
import { useAgentSession, type AgentPhase, type WatchdogInfo } from "@/hooks/useAgentSession";
import { useAgentStatus, type ServerStatus } from "@/hooks/useAgentStatus";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { logEventStore } from "@/lib/log-event-store";
import { agentEventBus } from "@/lib/agent-event-bus";

interface AgentRole {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  blocks: Record<string, { id: string; text: string; createdAt: string }[]>;
  builtIn?: boolean;
  sourceInfo?: { scope?: string; filePath?: string };
}

interface Props {
  activeTabId?: string | null;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: (sessionId: string, changedFiles?: string[]) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionStarted?: (session: SessionInfo | null) => void;
  onAgentRunningChange?: (sessionId: string | null | undefined, running: boolean) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onSessionStatsChange?: (stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onOpenRoleConfig?: () => void;
}

function phaseLabel(phase: AgentPhase): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return "正在运行工具...";
    if (names.length === 1) return `正在运行 ${names[0]}...`;
    if (names.length <= 3) return `正在运行 ${names.join(", ")}...`;
    return `正在运行 ${names.slice(0, 2).join(", ")} (+${names.length - 2})...`;
  }
  if (phase?.kind === "waiting_model") return "正在等待模型响应...";
  return "正在思考...";
}

// ============================================================================
// AgentStatusTicker — 模型等待时展示详细的实时状态信息
// ============================================================================

interface TickerProps {
  serverStatus: ServerStatus | null;
  watchdog: WatchdogInfo | null;
  agentPhase: AgentPhase;
  thinkingLevel: string;
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  isCompacting: boolean;
  stallLevel: string | null;
  autoRecoveryMode: string;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function formatRate(rate: number): string {
  if (rate >= 100) return rate.toFixed(0);
  if (rate >= 10) return rate.toFixed(1);
  return rate.toFixed(2);
}

function StatusPill({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none font-mono border whitespace-nowrap ${accent ? "bg-accent/10 border-accent/30 text-accent" : "bg-bg-hover border-border text-text-muted"}`}
      title={title ?? `${label}: ${value}`}
    >
      <span className="opacity-60">{label}</span>
      <span className={accent ? "font-semibold" : ""}>{value}</span>
    </span>
  );
}

function AgentStatusTicker(props: TickerProps) {
  const { serverStatus, watchdog, thinkingLevel, retryInfo,
    contextUsage, isCompacting, stallLevel, autoRecoveryMode } = props;
  // 构建状态条目列表
  const items: { label: string; value: string; accent?: boolean; title?: string; priority: number }[] = [];

  // 1. 事件静默时间（服务端）
  if (serverStatus?.eventIdleMs != null && serverStatus.eventIdleMs > 0) {
    const idleSec = (serverStatus.eventIdleMs / 1000).toFixed(1);
    items.push({
      label: "静默",
      value: `${idleSec}s`,
      accent: serverStatus.eventIdleMs > 30_000,
      title: `距上次事件 ${formatMs(serverStatus.eventIdleMs)}`,
      priority: 1,
    });
  }

  // 2. 内容停滞时间（服务端）
  if (serverStatus?.contentIdleMs != null && serverStatus.contentIdleMs > 0) {
    const contentSec = (serverStatus.contentIdleMs / 1000).toFixed(1);
    items.push({
      label: "内容停滞",
      value: `${contentSec}s`,
      accent: serverStatus.contentIdleMs > 30_000,
      title: `距上次内容变更 ${formatMs(serverStatus.contentIdleMs)}`,
      priority: 2,
    });
  }

  // 3. 事件速率 + 总数
  if (serverStatus?.eventCount != null && serverStatus.eventCount > 0) {
    const rate = typeof serverStatus.eventRate === "number" ? formatRate(serverStatus.eventRate) : "?";
    items.push({
      label: "事件",
      value: `${rate}/s · ${serverStatus.eventCount}`,
      title: `事件速率 ${rate}/s，共 ${serverStatus.eventCount} 个`,
      priority: 3,
    });
  }

  // 4. 最后事件类型
  if (serverStatus?.lastEventType) {
    const typeMap: Record<string, string> = {
      agent_start: "回合开始", agent_end: "回合结束",
      message_start: "消息开始", message_update: "消息更新", message_end: "消息结束",
      tool_execution_start: "工具开始", tool_execution_end: "工具结束",
      auto_retry_start: "重试开始", auto_retry_end: "重试结束",
      compaction_start: "压缩开始", compaction_end: "压缩结束",
      auto_compaction_start: "压缩开始", auto_compaction_end: "压缩结束",
    };
    const displayType = typeMap[serverStatus.lastEventType] ?? serverStatus.lastEventType;
    items.push({
      label: "最后事件",
      value: displayType,
      title: `最后事件类型: ${serverStatus.lastEventType}`,
      priority: 4,
    });
  }

  // 5. 思考等级
  if (thinkingLevel && thinkingLevel !== "auto") {
    const levelMap: Record<string, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高" };
    items.push({ label: "思考", value: levelMap[thinkingLevel] ?? thinkingLevel, accent: thinkingLevel === "xhigh", priority: 5 });
  }

  // 6. 上下文使用率
  if (contextUsage?.percent != null) {
    const pct = Math.round(contextUsage.percent);
    const tokensStr = contextUsage.tokens != null ? `${(contextUsage.tokens / 1000).toFixed(0)}k` : "?";
    items.push({
      label: "上下文",
      value: `${pct}% (${tokensStr}/${(contextUsage.contextWindow / 1000).toFixed(0)}k)`,
      accent: pct > 80,
      title: `上下文窗口使用 ${pct}%，${tokensStr} / ${(contextUsage.contextWindow / 1000).toFixed(0)}k tokens`,
      priority: 6,
    });
  }

  // 7. 自动重试
  if (retryInfo) {
    items.push({
      label: "重试",
      value: `${retryInfo.attempt}/${retryInfo.maxAttempts}`,
      accent: true,
      title: retryInfo.errorMessage ? `第 ${retryInfo.attempt} 次重试：${retryInfo.errorMessage}` : `第 ${retryInfo.attempt} 次重试`,
      priority: 7,
    });
  }

  // 8. 压缩状态
  if (isCompacting) {
    items.push({ label: "压缩中", value: "⏳", accent: true, priority: 8 });
  }

  // 9. 卡顿告警
  if (stallLevel === "warning") {
    items.push({ label: "卡顿", value: "⚠️", accent: true, title: "检测到模型响应卡顿", priority: 9 });
  } else if (stallLevel === "recovering") {
    items.push({ label: "恢复中", value: "🔄", accent: true, title: "正在自动恢复连接", priority: 9 });
  }

  // 10. 自动恢复模式
  if (autoRecoveryMode !== "conservative") {
    items.push({
      label: "恢复",
      value: autoRecoveryMode === "aggressive" ? "激进" : "关闭",
      accent: autoRecoveryMode === "aggressive",
      priority: 10,
    });
  }

  // 11. 看门狗剩余时间（客户端）
  if (watchdog && watchdog.eventIdleMs > 5000) {
    const eventLeft = Math.max(0, Math.ceil((watchdog.eventThresholdMs - watchdog.eventIdleMs) / 1000));
    const contentLeft = Math.max(0, Math.ceil((watchdog.contentThresholdMs - watchdog.contentIdleMs) / 1000));
    items.push({
      label: "看门狗",
      value: `事件${eventLeft}s 内容${contentLeft}s`,
      accent: eventLeft <= 10 || contentLeft <= 15,
      title: `看门狗触发倒计时：事件 ${eventLeft}s，内容 ${contentLeft}s`,
      priority: 11,
    });
  }

  // 按优先级排序
  items.sort((a, b) => a.priority - b.priority);

  if (items.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-1 ml-2 overflow-x-auto max-w-[480px] scrollbar-none">
      {items.map((item, i) => (
        <StatusPill key={i} label={item.label} value={item.value} accent={item.accent} title={item.title} />
      ))}
    </span>
  );
}

const TYPEWRITER_PHRASES = [
  "随时准备为您服务。",
  "问我任何问题。",
  "让我们一起构建酷炫的项目。",
  "探索您的代码库。",
  "撰写一封邮件。",
  "总结那篇论文。",
  "规划您的周末。",
  "用最通俗的话向我解释。",
  "和我结对编程。",
  "修复那个烦人的Bug。",
  "翻译成中文。",
  "写一首俳句。",
  "头脑风暴构思创意。",
  "审查我的拉取请求。",
  "今晚吃什么？",
  "发布上线。",
  "让它更美观。",
  "做您的小黄鸭。",
];

const AUTO_SCROLL_THRESHOLD = 80;

function Typewriter({ phrases }: { phrases: string[] }) {
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * phrases.length));
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [caretOn, setCaretOn] = useState(true);

  useEffect(() => {
    const blink = setInterval(() => setCaretOn((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const current = phrases[phraseIdx];
    let timeout: ReturnType<typeof setTimeout>;
    if (!deleting && text === current) {
      timeout = setTimeout(() => setDeleting(true), 1800);
    } else if (deleting && text === "") {
      setDeleting(false);
      setPhraseIdx((i) => (i + 1) % phrases.length);
    } else {
      const next = deleting ? current.slice(0, text.length - 1) : current.slice(0, text.length + 1);
      timeout = setTimeout(() => setText(next), deleting ? 28 : 55);
    }
    return () => clearTimeout(timeout);
  }, [text, deleting, phraseIdx, phrases]);

  return (
    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
      {text}
      <span style={{ opacity: caretOn ? 1 : 0, color: "var(--accent)", marginLeft: 1 }}>▍</span>
    </span>
  );
}

export function ChatWindow({ activeTabId, session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionStarted, onAgentRunningChange, onSessionForked, modelsRefreshKey, chatInputRef, onSessionStatsChange, onContextUsageChange, onOpenFile, onOpenRoleConfig }: Props) {
  // Track changed files from agent_end event per session so switching chats
  // does not show another session's bottom "x files modified" banner.
  const [changedFilesBySession, setChangedFilesBySession] = useState<Record<string, string[]>>({});
  const activeSessionKey = session?.id ?? null;
  const changedFiles = activeSessionKey ? (changedFilesBySession[activeSessionKey] ?? []) : [];
  const [currentRoleId, setCurrentRoleId] = useState("default");
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [pendingRoleSetting, setPendingRoleSetting] = useState<{ roleId: string; roleName: string; block: string; setting: string } | null>(null);
  const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);
  const [lastUserMsgExpanded, setLastUserMsgExpanded] = useState(false);
  const wrappedOnAgentEnd = useCallback((sessionId: string, cf?: string[]) => {
    setChangedFilesBySession((prev) => ({
      ...prev,
      [sessionId]: cf && cf.length > 0 ? cf : [],
    }));
    onAgentEnd?.(sessionId, cf);
  }, [onAgentEnd]);

  const {
    loading, error, data, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId, watchdogInfo,
    isCompacting, compactError, lastModelError, displayModel: displayModelValue, sessionStats,
    agentPhase,
    isNew,
    stallLevel, autoRecoveryMode,
    handleAutoRecover, handleDismissStall, handleAutoRecoveryModeChange,
    messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange,
    systemPrompt, setSystemPrompt, setLastModelError,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionStarted, onSessionForked,
    modelsRefreshKey,
    activeTabId,
  });

  // 实时轮询服务端 agent 状态（用于状态 ticker）
  const { server: serverStatus } = useAgentStatus(session?.id, agentRunning, watchdogInfo);

  const currentCwd = session?.cwd ?? newSessionCwd ?? undefined;

  const applyRoleToSession = useCallback(async (roleId: string) => {
    if (!session?.id) return;
    const res = await fetch(`/api/agent/${encodeURIComponent(session.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "set_role", roleId }),
    }).catch(() => null);
    if (!res?.ok) return;
    const json = await res.json().catch(() => null) as { data?: { systemPrompt?: string | null } } | null;
    if (json?.data && json.data.systemPrompt !== undefined) {
      setSystemPrompt(json.data.systemPrompt ?? null);
    }
  }, [session?.id, setSystemPrompt]);

  useEffect(() => {
    if (!data) return;
    const loadedRoleId = data.context.roleId || "default";
    setCurrentRoleId(loadedRoleId);
    localStorage.setItem("deerhux.current-role", loadedRoleId);
    if (data.context.roleId) void applyRoleToSession(loadedRoleId);
  }, [data, applyRoleToSession]);

  useEffect(() => {
    const handler = () => {
      void applyRoleToSession(currentRoleId);
    };
    window.addEventListener("deerhux.roles-updated", handler);
    return () => window.removeEventListener("deerhux.roles-updated", handler);
  }, [applyRoleToSession, currentRoleId]);

  const handleRoleChange = useCallback((roleId: string) => {
    setCurrentRoleId(roleId);
    localStorage.setItem("deerhux.current-role", roleId);
    void applyRoleToSession(roleId);
  }, [applyRoleToSession]);

  const detectSetting = useCallback((message: string) => {
    const hasIntent = /(给.*角色.*(加|新增|保存|存入|设定)|以后.*角色|角色.*以后|存到.*角色|记住.*角色设定|把.*存到.*角色|当前角色.*设定)/.test(message);
    if (!hasIntent) return null;
    const mentioned = roles.find((r) => r.name !== "默认角色" && message.includes(r.name));
    const role = mentioned ?? roles.find((r) => r.id === currentRoleId) ?? roles.find((r) => r.id === "default");
    if (!role) return null;
    const block = /工具|修改代码前|执行|命令/.test(message) ? "Tools" : /语气|风格|简洁|详细|先给结论|表达/.test(message) ? "Soul" : /身份|扮演|像一个|专家|经理|审查员/.test(message) ? "Identity" : /用户|偏好|协作/.test(message) ? "User" : /记住|长期|背景信息/.test(message) ? "Memory" : "Rules";
    const setting = (message.match(/[：:](.+)$/)?.[1] ?? message).replace(/^(给)?(当前)?角色(加|新增|保存|存入)?(一个|一条)?设定[：:]?/, "").trim();
    return { roleId: role.id, roleName: role.name, block, setting: setting.length > 160 ? setting.slice(0, 160) + "…" : setting };
  }, [roles, currentRoleId]);

  const sendWithRole = useCallback((message: string, images?: AttachedImage[]) => {
    const detected = detectSetting(message);
    if (detected) setPendingRoleSetting(detected);
    handleSend(message, images, currentRoleId);
  }, [detectSetting, handleSend, currentRoleId]);

  const confirmRoleSetting = useCallback(async (mode: "save" | "temporary" | "cancel") => {
    const pending = pendingRoleSetting;
    if (!pending) return;
    setPendingRoleSetting(null);
    if (mode === "save") {
      const rolesUrl = currentCwd ? `/api/roles?cwd=${encodeURIComponent(currentCwd)}` : "/api/roles";
      const settingsUrl = currentCwd
        ? `/api/roles/${encodeURIComponent(pending.roleId)}/settings?cwd=${encodeURIComponent(currentCwd)}`
        : `/api/roles/${encodeURIComponent(pending.roleId)}/settings`;
      await fetch(settingsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block: pending.block, text: pending.setting }),
      });
      const data = await fetch(rolesUrl).then((r) => r.json()).catch(() => null) as { roles?: AgentRole[] } | null;
      if (data?.roles) setRoles(data.roles);
      if (session?.id) await applyRoleToSession(pending.roleId);
    } else if (mode === "temporary" && session?.id) {
      const res = await fetch(`/api/agent/${encodeURIComponent(session.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "add_temporary_role_setting", text: pending.setting }) }).catch(() => null);
      if (res?.ok) {
        const json = await res.json().catch(() => null) as { data?: { systemPrompt?: string | null } } | null;
        if (json?.data && json.data.systemPrompt !== undefined) setSystemPrompt(json.data.systemPrompt ?? null);
      }
    }
  }, [pendingRoleSetting, currentCwd, session?.id, applyRoleToSession, setSystemPrompt]);

  const handleResend = useCallback((message: string) => {
    if (agentRunning && handleSteer) {
      handleSteer(message);
    } else if (!agentRunning) {
      handleSend(message, undefined, currentRoleId);
    }
  }, [agentRunning, handleSteer, handleSend, currentRoleId]);

  useEffect(() => {
    onAgentRunningChange?.(session?.id, agentRunning);
  }, [agentRunning, onAgentRunningChange, session?.id]);

  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  // Subscribe to the global event bus for sound effects and log forwarding.
  // This avoids wrapping handleAgentEventRef which has closure/stale-ref issues.
  const sessionIdRef2 = useRef(session?.id);
  sessionIdRef2.current = session?.id;
  useEffect(() => {
    const unsubscribe = agentEventBus.subscribe((event) => {
      if (event.type === "agent_start") {
        const id = sessionIdRef2.current;
        if (id) {
          setChangedFilesBySession((prev) => ({ ...prev, [id]: [] }));
        }
      }
      if (event.type === "agent_end" && soundEnabledRef.current) {
        playDoneSoundRef.current();
      }
    });
    return unsubscribe;
  }, []);

  // Forward agent events to the log store (independent of useAgentSession handler).
  // Track per-block content lengths to correctly handle multiple blocks per message.
  const logContentLenRef = useRef<{ thinking: number[]; text: number[] }>({ thinking: [], text: [] });
  useEffect(() => {
    const unsubscribe = agentEventBus.subscribe((event) => {
      const logGroupKey = `session-${sessionIdRef2.current ?? "new"}`;
      switch (event.type) {
        case "agent_start": {
          logContentLenRef.current = { thinking: [], text: [] };
          logEventStore.push({ type: "system", content: "Agent 启动", groupKey: logGroupKey });
          break;
        }
        case "agent_end":
          logEventStore.finalizeBlock();
          break;
        case "message_start":
        case "message_update": {
          const msg = event.message as { role?: string; content?: unknown } | undefined;
          if (msg?.role === "assistant" && Array.isArray(msg.content)) {
            const blocks = msg.content as Array<{ type?: string; text?: string; thinking?: string }>;
            let thinkingIdx = 0;
            let textIdx = 0;
            for (const block of blocks) {
              if (block.type === "thinking" && block.thinking) {
                const idx = thinkingIdx++;
                const prevLen = logContentLenRef.current.thinking[idx] ?? 0;
                const newLen = block.thinking.length;
                if (newLen > prevLen) {
                  logEventStore.push({ type: "thinking", content: block.thinking.slice(prevLen), groupKey: logGroupKey });
                  logContentLenRef.current.thinking[idx] = newLen;
                }
              } else if (block.type === "text" && block.text) {
                const idx = textIdx++;
                const prevLen = logContentLenRef.current.text[idx] ?? 0;
                const newLen = block.text.length;
                if (newLen > prevLen) {
                  logEventStore.push({ type: "text", content: block.text.slice(prevLen), groupKey: logGroupKey });
                  logContentLenRef.current.text[idx] = newLen;
                }
              }
            }
          }
          break;
        }
        case "tool_execution_start": {
          const toolName = (event.toolName ?? event.name ?? "unknown") as string;
          const toolCallId = (event.toolCallId ?? "") as string;
          logEventStore.push({ type: "tool_start", content: `开始执行: ${toolName}`, toolName, toolCallId, groupKey: logGroupKey });
          break;
        }
        case "tool_execution_end": {
          const toolName = (event.toolName ?? event.name ?? "unknown") as string;
          const toolCallId = (event.toolCallId ?? "") as string;
          const result = typeof event.result === "string" ? event.result : "";
          logEventStore.push({ type: "tool_end", content: result ? `完成: ${result.slice(0, 200)}` : "完成", toolName, toolCallId, groupKey: logGroupKey });
          break;
        }
        case "auto_retry_start":
          logEventStore.push({ type: "error", content: `自动重试 (第 ${event.attempt}/${event.maxAttempts} 次): ${event.errorMessage ?? ""}`, groupKey: logGroupKey });
          break;
        case "auto_retry_end":
          if ((event as { success?: boolean }).success === false) {
            logEventStore.push({ type: "error", content: `重试失败: ${(event as { finalError?: string }).finalError ?? ""}`, groupKey: logGroupKey });
          }
          break;
        case "auto_compaction_start":
        case "compaction_start":
          logEventStore.push({ type: "info", content: "上下文压缩开始", groupKey: logGroupKey });
          break;
        case "auto_compaction_end":
        case "compaction_end":
          logEventStore.push({ type: "info", content: "上下文压缩完成", groupKey: logGroupKey });
          break;
      }
    });
    return unsubscribe;
  }, []);

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? `${sessionStats.tokens.input}|${sessionStats.tokens.output}|${sessionStats.tokens.cacheRead}|${sessionStats.tokens.cacheWrite}|${sessionStats.cost ?? 0}`
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = useMemo(() => messages.filter((m) => m.role === "user" || m.role === "assistant"), [messages]);
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, import("@/lib/types").ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as import("@/lib/types").ToolResultMessage).toolCallId, msg as import("@/lib/types").ToolResultMessage);
      }
    }
    return map;
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);

  // 所有 user 消息在 messages 中的索引
  const userMsgIndices = useMemo(() => {
    return messages.reduce<number[]>((arr, m, i) => {
      if (m.role === "user") arr.push(i);
      return arr;
    }, []);
  }, [messages]);

  // user 消息在 messages 中的索引 → 在 messageRefs 中的索引
  const userMsgIdxToRefIdx = useMemo(() => {
    const map = new Map<number, number>();
    let refIdx = 0;
    for (let i = 0; i < messages.length; i++) {
      const isVisible = messages[i].role === "user" || messages[i].role === "assistant";
      if (messages[i].role === "user") map.set(i, refIdx);
      if (isVisible) refIdx++;
    }
    return map;
  }, [messages]);

  // 当前悬浮面板钉住的 user 消息在 messages 中的索引
  const [pinnedUserMsgIdx, setPinnedUserMsgIdx] = useState<number>(-1);
  const prevUserMsgCountRef = useRef(0);

  // 仅在 user 消息数量变化时重置为最后一条（避免 streaming 等场景频繁重置）
  useEffect(() => {
    const count = userMsgIndices.length;
    if (count !== prevUserMsgCountRef.current) {
      prevUserMsgCountRef.current = count;
      if (count > 0) {
        setPinnedUserMsgIdx(userMsgIndices[count - 1]);
      } else {
        setPinnedUserMsgIdx(-1);
      }
    }
  }, [userMsgIndices.length]);

  // 钉住的 user 消息文本
  const pinnedUserMsgText = useMemo(() => {
    if (pinnedUserMsgIdx < 0) return "";
    const msg = messages[pinnedUserMsgIdx] as import("@/lib/types").UserMessage | undefined;
    if (!msg || msg.role !== "user") return "";
    const content = msg.content;
    if (typeof content === "string") return content;
    return content.filter((b): b is import("@/lib/types").TextContent => b.type === "text").map((b) => b.text).join("\n");
  }, [messages, pinnedUserMsgIdx]);

  const scrollToPinnedUserMsg = useCallback(() => {
    const refIdx = userMsgIdxToRefIdx.get(pinnedUserMsgIdx);
    if (refIdx === undefined) return;
    const el = messageRefs.current[refIdx];
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [pinnedUserMsgIdx, userMsgIdxToRefIdx, messageRefs]);
  const liveStreamEndRef = useRef<HTMLDivElement | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const shouldAutoScrollRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    userScrollIntentTimerRef.current = setTimeout(() => {
      userScrollIntentRef.current = false;
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (userScrollIntentTimerRef.current) clearTimeout(userScrollIntentTimerRef.current);
    };
  }, []);

  const setAutoScroll = useCallback((enabled: boolean) => {
    shouldAutoScrollRef.current = enabled;
    setShouldAutoScroll(enabled);
  }, []);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;

    const liveEnd = liveStreamEndRef.current;
    if (agentRunning && liveEnd) {
      const containerRect = container.getBoundingClientRect();
      const liveEndRect = liveEnd.getBoundingClientRect();
      return liveEndRect.bottom - containerRect.bottom < AUTO_SCROLL_THRESHOLD;
    }

    return container.scrollHeight - container.scrollTop - container.clientHeight < AUTO_SCROLL_THRESHOLD;
  }, [agentRunning, scrollContainerRef]);

  const scrollToLiveBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const liveEnd = liveStreamEndRef.current;
    if (agentRunning && liveEnd) {
      liveEnd.scrollIntoView({ block: "end", behavior });
      return;
    }

    container.scrollTo({ top: container.scrollHeight - container.clientHeight, behavior });
  }, [agentRunning, scrollContainerRef]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    if (nearBottom) {
      setAutoScroll(true);
      // 在底部时，始终钉住最后一条 user 消息
      if (userMsgIndices.length > 0) {
        const lastIdx = userMsgIndices[userMsgIndices.length - 1];
        setPinnedUserMsgIdx((prev) => prev !== lastIdx ? lastIdx : prev);
      }
      return;
    }

    // Only user-initiated upward scrolling pauses tracking.
    if (userScrollIntentRef.current) {
      setAutoScroll(false);
    }

    // 根据滚动位置更新钉住的 user 消息：
    // 从旧到新遍历，找第一条顶部仍在容器顶部之下的消息
    const containerTop = container.getBoundingClientRect().top;
    for (let i = 0; i < userMsgIndices.length; i++) {
      const msgIdx = userMsgIndices[i];
      const refIdx = userMsgIdxToRefIdx.get(msgIdx);
      if (refIdx === undefined) continue;
      const el = messageRefs.current[refIdx];
      if (el && el.getBoundingClientRect().top >= containerTop) {
        // 第一条满足条件的就是最旧的 user 消息
        if (i === 0) {
          // 还需确认最后一条也在容器下方 → 用户确实在底部附近
          const lastIdx = userMsgIndices[userMsgIndices.length - 1];
          const lastRefIdx = userMsgIdxToRefIdx.get(lastIdx);
          const lastEl = lastRefIdx !== undefined ? messageRefs.current[lastRefIdx] : null;
          if (lastEl && lastEl.getBoundingClientRect().top >= containerTop) {
            // 最后一条也在下方 → 用户在底部，显示最后一条
            setPinnedUserMsgIdx((prev) => prev !== lastIdx ? lastIdx : prev);
          } else {
            // 只有第一条在下方 → 用户真的滚到了第一条
            setPinnedUserMsgIdx((prev) => prev !== msgIdx ? msgIdx : prev);
          }
        } else {
          setPinnedUserMsgIdx((prev) => prev !== msgIdx ? msgIdx : prev);
        }
        return;
      }
    }
    // 所有 user 消息都已滚出顶部，保持不变（"如果没有就不变"）
  }, [isNearBottom, setAutoScroll, userMsgIndices, userMsgIdxToRefIdx, messageRefs, scrollContainerRef]);

  const handleResumeAutoScroll = useCallback(() => {
    setAutoScroll(true);
    scrollToLiveBottom("smooth");
  }, [scrollToLiveBottom, setAutoScroll]);

  useEffect(() => {
    setAutoScroll(true);
  }, [session?.id, isNew, setAutoScroll]);

  useEffect(() => {
    if (!agentRunning) return;
    if (!shouldAutoScrollRef.current) return;

    const frame = requestAnimationFrame(() => {
      if (shouldAutoScrollRef.current) {
        scrollToLiveBottom("auto");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [agentRunning, streamState.streamingMessage, agentPhase, scrollToLiveBottom]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !agentRunning;

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  // Input state cache — preserves text / images / selected skill across tab switches
  const inputStateCache = useRef<Map<string, ChatInputState>>(new Map());
  const currentInputKey = session?.id ?? `new:${newSessionCwd ?? ""}:${activeTabId ?? ""}`;
  const savedInputState = inputStateCache.current.get(currentInputKey) ?? null;
  const currentInputKeyRef = useRef(currentInputKey);
  currentInputKeyRef.current = currentInputKey;
  const saveInputStateRef = useRef<((state: ChatInputState) => void) | null>(null);
  saveInputStateRef.current = (state: ChatInputState) => {
    inputStateCache.current.set(currentInputKeyRef.current, state);
  };

  const chatInputElement = (
    <>
      {pendingRoleSetting && (
        <div style={{ maxWidth: 820, margin: "0 auto 8px", padding: "0 16px", paddingRight: 52 }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)", padding: 12, boxShadow: "0 4px 14px rgba(0,0,0,0.08)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>识别到角色设定</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              当前目标角色：<b style={{ color: "var(--text)" }}>{pendingRoleSetting.roleName}</b><br />
              建议分块：<b style={{ color: "var(--text)" }}>{pendingRoleSetting.block}</b><br />
              建议存入的设定：<span style={{ color: "var(--text)" }}>「{pendingRoleSetting.setting}」</span>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button onClick={() => confirmRoleSetting("save")} style={{ padding: "7px 11px", border: "none", borderRadius: 8, background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 12 }}>确认存入</button>
              <button onClick={() => confirmRoleSetting("temporary")} style={{ padding: "7px 11px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>仅本次对话使用</button>
              <button onClick={() => confirmRoleSetting("cancel")} style={{ padding: "7px 11px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>取消</button>
            </div>
          </div>
        </div>
      )}
      <ChatInput
        key={session?.id ?? `new:${newSessionCwd ?? ""}:${activeTabId ?? ""}`}
        ref={chatInputRef}
      onSend={sendWithRole}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      isStreaming={agentRunning}
      model={displayModelValue}
      modelNames={modelNames}
      modelList={modelList}
      onModelChange={handleModelChange}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      lastModelError={lastModelError}
      onClearModelError={() => setLastModelError(null)}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      cwd={session?.cwd ?? newSessionCwd}
      currentRoleId={currentRoleId}
      onRoleChange={handleRoleChange}
      onRolesLoaded={setRoles}
      onOpenRoleConfig={onOpenRoleConfig}
      stallLevel={stallLevel}
      autoRecoveryMode={autoRecoveryMode}
      onAutoRecover={handleAutoRecover}
      onDismissStall={handleDismissStall}
      onAutoRecoveryModeChange={handleAutoRecoveryModeChange}
      initialInputState={savedInputState}
      saveInputStateRef={saveInputStateRef}
    />
    </>
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        正在加载会话...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4 }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text)" }}>π</span>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: "-0.01em" }}>DeerHux</span>
                <span style={{ fontSize: 14, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  <Typewriter phrases={TYPEWRITER_PHRASES} />
                </span>
              </div>
            </div>
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      {systemPrompt !== null && (
        <div
          style={{
            flexShrink: 0,
            width: "100%",
            boxSizing: "border-box",
            paddingLeft: 16,
            paddingRight: 52, // 16px base + 36px for ChatMinimap alignment
          }}
        >
          <div style={{
            maxWidth: 820,
            margin: "8px auto 0",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}>
            <button
              onClick={() => setSystemPromptExpanded(!systemPromptExpanded)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "currentColor", flexShrink: 0 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
              </svg>
              <span style={{ fontWeight: 500 }}>系统提示词</span>
              {systemPrompt && (
                <span style={{
                  maxWidth: 280,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  opacity: 0.6,
                  fontSize: 10,
                }}>
                  {systemPrompt.slice(0, 60).replace(/\n/g, " ")}{systemPrompt.length > 60 ? "…" : ""}
                </span>
              )}
              {systemPrompt === "" && (
                <span style={{ opacity: 0.5, fontStyle: "italic", fontSize: 10 }}>为空（已禁用工具）</span>
              )}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: "auto", flexShrink: 0, transform: systemPromptExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {systemPromptExpanded && (
              <div style={{
                padding: "8px 10px 10px",
                borderTop: "1px solid var(--border)",
                fontSize: 11,
                lineHeight: 1.65,
                color: "var(--text-muted)",
                whiteSpace: "pre-wrap",
                fontFamily: "var(--font-mono)",
                maxHeight: 240,
                overflowY: "auto",
              }}>
                {systemPrompt || "（空）"}
              </div>
            )}
          </div>
        </div>
      )}
      {pinnedUserMsgIdx >= 0 && pinnedUserMsgText && (
        <div
          style={{
            flexShrink: 0,
            width: "100%",
            boxSizing: "border-box",
            paddingLeft: 16,
            paddingRight: 52,
          }}
        >
          <div style={{
            maxWidth: 820,
            margin: "4px auto 0",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
              }}
            >
              <button
                onClick={() => scrollToPinnedUserMsg()}
                title="点击定位到消息位置"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 10px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "inherit",
                  minWidth: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent)", flexShrink: 0 }}>
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span style={{ fontWeight: 500, flexShrink: 0 }}>最新提示词</span>
                <span style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  opacity: 0.6,
                  fontSize: 10,
                }}>
                  {pinnedUserMsgText.slice(0, 60).replace(/\n/g, " ")}{pinnedUserMsgText.length > 60 ? "…" : ""}
                </span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setLastUserMsgExpanded(!lastUserMsgExpanded); }}
                title={lastUserMsgExpanded ? "收起" : "展开查看完整内容"}
                style={{
                  padding: "5px 10px",
                  border: "none",
                  borderLeft: "1px solid var(--border)",
                  background: "transparent",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: lastUserMsgExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
            {lastUserMsgExpanded && (
              <div style={{
                padding: "8px 10px 10px",
                borderTop: "1px solid var(--border)",
                fontSize: 11,
                lineHeight: 1.65,
                color: "var(--text-muted)",
                whiteSpace: "pre-wrap",
                fontFamily: "var(--font-mono)",
                maxHeight: 240,
                overflowY: "auto",
              }}>
                {pinnedUserMsgText}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="relative flex flex-1 overflow-hidden">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onWheel={markUserScrollIntent}
          onTouchStart={markUserScrollIntent}
          className="flex-1 overflow-y-auto pt-4 [scrollbar-width:none]"
        >
          <div className="mx-auto max-w-[820px] px-4">

            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              let refIdx = 0;
              return messages.map((msg, idx) => {
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = isVisible ? refIdx++ : -1;
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                const view = (
                  <MessageView
                    key={idx}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    entryId={entryIds[idx]}
                    onFork={agentRunning || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as import("@/lib/types").AgentMessage & { timestamp?: number }).timestamp : undefined}
                    onResend={session && entryIds[idx] ? handleResend : undefined}
                  />
                );
                if (!isVisible) return view;
                return (
                  <div key={idx} ref={(el) => {
                    messageRefs.current[currentRefIdx] = el;
                    if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
                  }}>
                    {view}
                  </div>
                );
              });
            })()}

            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} watchdogInfo={watchdogInfo} />
            )}

            {agentRunning && !streamState.streamingMessage && (
              <div className="py-2 text-[13px] text-text-muted">
                <div className="flex items-center gap-0 flex-wrap">
                  <span className="animate-[pulse_1.5s_infinite] shrink-0">{phaseLabel(agentPhase)}</span>
                  <AgentStatusTicker
                    serverStatus={serverStatus}
                    watchdog={watchdogInfo}
                    agentPhase={agentPhase}
                    thinkingLevel={thinkingLevel}
                    retryInfo={retryInfo}
                    contextUsage={contextUsage}
                    isCompacting={isCompacting}
                    stallLevel={stallLevel}
                    autoRecoveryMode={autoRecoveryMode}
                  />
                </div>
              </div>
            )}

            {agentRunning && <div ref={liveStreamEndRef} />}

            {!agentRunning && changedFiles.length > 0 && (
              <ChangedFilesList
                files={changedFiles}
                cwd={session?.cwd ?? newSessionCwd ?? null}
                onOpenFile={onOpenFile ? (fp) => {
                  const name = fp.split(/[\\/]/).filter(Boolean).pop() ?? fp;
                  onOpenFile(fp, name);
                } : undefined}
              />
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
        {!shouldAutoScroll && agentRunning && (
          <button
            type="button"
            onClick={handleResumeAutoScroll}
            className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-bg-panel px-3 py-1.5 text-xs text-text shadow-lg transition hover:bg-bg-hover"
          >
            回到底部
          </button>
        )}
        <ChatMinimap
          messages={messages}
          streamingMessage={streamState.streamingMessage}
          scrollContainer={scrollContainerRef}
          messageRefs={messageRefs}
        />
      </div>

      <div className="relative">
        {chatInputElement}
      </div>
      </>
      )}
    </div>
  );
}