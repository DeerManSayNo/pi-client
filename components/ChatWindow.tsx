"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle, type AttachedImage } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ChangedFilesList } from "./ChangedFilesList";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";

interface AgentRole {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  blocks: Record<string, { id: string; text: string; createdAt: string }[]>;
  builtIn?: boolean;
}

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: (changedFiles?: string[]) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionStarted?: (session: SessionInfo | null) => void;
  onAgentRunningChange?: (sessionId: string | null | undefined, running: boolean) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onSystemPromptChange?: (prompt: string | null) => void;
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

export function ChatWindow({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionStarted, onAgentRunningChange, onSessionForked, modelsRefreshKey, chatInputRef, onSystemPromptChange, onSessionStatsChange, onContextUsageChange, onOpenFile, onOpenRoleConfig }: Props) {
  // Track changed files from agent_end event
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [currentRoleId, setCurrentRoleId] = useState("default");
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [pendingRoleSetting, setPendingRoleSetting] = useState<{ roleId: string; roleName: string; block: string; setting: string } | null>(null);
  const wrappedOnAgentEnd = useCallback((cf?: string[]) => {
    if (cf && cf.length > 0) {
      setChangedFiles(cf);
    }
    onAgentEnd?.(cf);
  }, [onAgentEnd]);

  const {
    loading, error, data, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId, watchdogInfo,
    isCompacting, compactError, displayModel: displayModelValue, sessionStats,
    agentPhase,
    isNew,
    messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange, handleAgentEventRef,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionStarted, onSessionForked,
    modelsRefreshKey, onSystemPromptChange,
  });

  useEffect(() => {
    if (!data) return;
    const loadedRoleId = data.context.roleId || "default";
    setCurrentRoleId(loadedRoleId);
    localStorage.setItem("pi-agent.current-role", loadedRoleId);
  }, [data]);

  useEffect(() => {
    const handler = () => {
      if (!session?.id) return;
      fetch(`/api/agent/${encodeURIComponent(session.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "set_role", roleId: currentRoleId }),
      }).catch(() => {});
    };
    window.addEventListener("pi-agent.roles-updated", handler);
    return () => window.removeEventListener("pi-agent.roles-updated", handler);
  }, [session?.id, currentRoleId]);

  const handleRoleChange = useCallback((roleId: string) => {
    setCurrentRoleId(roleId);
    localStorage.setItem("pi-agent.current-role", roleId);
    if (session?.id) {
      fetch(`/api/agent/${encodeURIComponent(session.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "set_role", roleId }),
      }).catch(() => {});
    }
  }, [session?.id]);

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
      await fetch(`/api/roles/${encodeURIComponent(pending.roleId)}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block: pending.block, text: pending.setting }),
      });
      const data = await fetch("/api/roles").then((r) => r.json()).catch(() => null) as { roles?: AgentRole[] } | null;
      if (data?.roles) setRoles(data.roles);
      if (session?.id) await fetch(`/api/agent/${encodeURIComponent(session.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "set_role", roleId: pending.roleId }) }).catch(() => {});
    } else if (mode === "temporary" && session?.id) {
      await fetch(`/api/agent/${encodeURIComponent(session.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "add_temporary_role_setting", text: pending.setting }) }).catch(() => {});
    }
  }, [pendingRoleSetting, session?.id]);

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

  // Wrap agent event handler to play sound on agent_end and clear changed files on agent_start
  const origHandler = handleAgentEventRef.current;
  useEffect(() => {
    handleAgentEventRef.current = (event) => {
      if (event.type === "agent_start") {
        setChangedFiles([]);
      }
      if (event.type === "agent_end" && soundEnabledRef.current) {
        playDoneSoundRef.current();
      }
      origHandler?.(event);
    };
  }, [origHandler, handleAgentEventRef]);

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

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const messageRefs = useMessageRefs(visibleMessages.length);
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

    // During streaming we track the live tail, not the temporary bottom spacer.
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
      const containerRect = container.getBoundingClientRect();
      const liveEndRect = liveEnd.getBoundingClientRect();
      const nextTop = container.scrollTop + (liveEndRect.bottom - containerRect.bottom);
      container.scrollTo({ top: nextTop, behavior });
      return;
    }

    container.scrollTo({ top: container.scrollHeight - container.clientHeight, behavior });
  }, [agentRunning, scrollContainerRef]);

  const handleScroll = useCallback(() => {
    const nearBottom = isNearBottom();
    if (nearBottom) {
      setAutoScroll(true);
      return;
    }

    // Only user-initiated upward scrolling pauses tracking. Programmatic scrolls
    // from session loading / prompt positioning should not fight streaming follow.
    if (userScrollIntentRef.current) {
      setAutoScroll(false);
    }
  }, [isNearBottom, setAutoScroll]);

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
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: "-0.01em" }}>Pi Client</span>
                <span style={{ fontSize: 14, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  <Typewriter phrases={TYPEWRITER_PHRASES} />
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
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
              const toolResultsMap = new Map<string, import("@/lib/types").ToolResultMessage>();
              for (const msg of messages) {
                if (msg.role === "toolResult") {
                  toolResultsMap.set((msg as import("@/lib/types").ToolResultMessage).toolCallId, msg as import("@/lib/types").ToolResultMessage);
                }
              }
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
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase)}</span>
              </div>
            )}

            {agentRunning && <div ref={liveStreamEndRef} />}

            {agentRunning && (
              <div style={{ height: scrollContainerRef.current ? scrollContainerRef.current.clientHeight : "80vh" }} />
            )}

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