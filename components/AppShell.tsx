"use client";

import { useState, useCallback, useRef, useEffect, useMemo, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { useTheme } from "@/hooks/useTheme";
import type { SessionInfo } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";

type DraggableStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };
type SidebarMode = "open" | "compact" | "closed";

const SKIP_AUTO_OPEN_SUFFIXES = [".jsonl"];

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function shouldAutoOpenFile(filePath: string): boolean {
  const name = fileNameFromPath(filePath).toLowerCase();
  return Boolean(name) && !SKIP_AUTO_OPEN_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function getProjectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

const CUSTOM_CWDS_STORAGE_KEY = "pi-agent.custom-cwds";

function readCustomCwds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CUSTOM_CWDS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function writeCustomCwds(cwds: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CUSTOM_CWDS_STORAGE_KEY, JSON.stringify([...new Set(cwds)]));
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isDark, toggleTheme } = useTheme();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  // Session tabs — browser-style in top bar
  const [sessionTabs, setSessionTabs] = useState<SessionInfo[]>([]);
  const [activeSessionTabId, setActiveSessionTabId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const pendingSessionIdRef = useRef<string | null>(null);
  const pendingTempTabIdRef = useRef<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("open");
  const sidebarOpen = sidebarMode !== "closed";
  const sidebarCompact = sidebarMode === "compact";
  const SIDEBAR_COMPACT = 56;
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 500;
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(260);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<{ tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null>(null);
  const handleSessionStatsChange = useCallback((stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => {
    setSessionStats(stats);
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"system" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "system") => {
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, []);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.insertText("`" + relativePath + "`");
  }, []);

  const [initialSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [customCwds, setCustomCwds] = useState<string[]>([]);
  const effectiveProjectCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? defaultCwd;
  const projectLocked = selectedSession !== null || pendingSession !== null;
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !searchParams.get("session"));
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  // Sync client-only localStorage state after mount to avoid hydration mismatch
  useEffect(() => {
    const storedWidth = window.localStorage.getItem("pi-agent.sidebar-width");
    if (storedWidth) {
      const parsed = parseInt(storedWidth, 10);
      if (Number.isFinite(parsed)) setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed)));
    }
    setCustomCwds(readCustomCwds());
  }, []);

  useEffect(() => {
    fetch("/api/default-cwd", { method: "POST" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data: { cwd?: string }) => { if (data.cwd) setDefaultCwd(data.cwd); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadRunningSessions = () => {
      fetch("/api/agent/running")
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
        .then((data: { runningSessionIds?: string[] }) => {
          if (!cancelled) setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        })
        .catch(() => {});
    };
    loadRunningSessions();
    const interval = window.setInterval(loadRunningSessions, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const setSessionRunning = useCallback((sessionId: string | null | undefined, running: boolean) => {
    if (!sessionId) return;
    setRunningSessionIds((prev) => {
      const next = new Set(prev);
      if (running) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const handleCwdChange = useCallback((cwd: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd || suppressCwdBumpRef.current) return;
    // Close any session that belongs to a different cwd — it no longer
    // matches the selected project directory.
    setSelectedSession((prev) => {
      if (prev && prev.cwd !== cwd) return null;
      return prev;
    });
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Do not clear pendingSession here: a newly-created session is not written
    // to disk by pi until the first assistant message exists. If the user
    // switches away while that first response is still running, /api/sessions
    // cannot list it yet, so the sidebar must keep showing the optimistic row.
    // Placeholder sessions (created by top bar "+") have path === ""
    if (session.path === "") {
      setNewSessionCwd(session.cwd);
      setSelectedSession(null);
      setActiveSessionTabId(session.id);
      setSessionKey((k) => k + 1);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
      return;
    }
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionTabs((prev) => {
      if (prev.find((t) => t.id === session.id)) return prev;
      return [...prev, session];
    });
    setActiveSessionTabId(session.id);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
      setTimeout(() => { suppressCwdBumpRef.current = false; }, 0);
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    // Create a placeholder tab so the chat area shows up
    const placeholder: SessionInfo = {
      path: "",
      id: _sessionId,
      cwd,
      name: "新会话",
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "",
    };
    setSessionTabs((prev) => [...prev, placeholder]);
    setActiveSessionTabId(_sessionId);
    pendingTempTabIdRef.current = _sessionId;
    setPendingSession(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  const handleTopNewSession = useCallback(() => {
    const cwd = effectiveProjectCwd;
    if (!cwd) return;
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    // Add a placeholder tab immediately
    const placeholder: SessionInfo = {
      path: "",
      id: tempId,
      cwd,
      name: "新会话",
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "",
    };
    setSessionTabs((prev) => [...prev, placeholder]);
    setActiveSessionTabId(tempId);
    pendingTempTabIdRef.current = tempId;
    setPendingSession(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [effectiveProjectCwd, router]);

  const handleSessionStarted = useCallback((session: SessionInfo | null) => {
    if (!session) {
      setSessionRunning(pendingSessionIdRef.current, false);
      pendingSessionIdRef.current = null;
      setPendingSession(null);
      return;
    }
    pendingSessionIdRef.current = session.id;
    setPendingSession(session);
    setSessionRunning(session.id, true);
    setRefreshKey((k) => k + 1);
  }, [setSessionRunning]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setSessionRunning(pendingSessionIdRef.current, false);
    pendingSessionIdRef.current = null;
    setSessionRunning(session.id, true);
    // Keep an optimistic entry with the real id until SessionManager.listAll()
    // can see the file. For brand-new sessions pi delays writing the jsonl
    // until an assistant message is persisted, so clearing this immediately
    // makes the session disappear from the sidebar when switching away mid-run.
    setPendingSession(session);
    setNewSessionCwd(null);
    setSelectedSession(session);
    // Replace placeholder tab created by "+" button with real session
    const tempId = pendingTempTabIdRef.current;
    pendingTempTabIdRef.current = null;
    setSessionTabs((prev) => {
      const filtered = tempId ? prev.filter((t) => t.id !== tempId) : prev;
      if (filtered.find((t) => t.id === session.id)) return filtered;
      return [...filtered, session];
    });
    setActiveSessionTabId((cur) => cur === tempId ? session.id : cur);
    setRefreshKey((k) => k + 1);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, setSessionRunning]);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  // ── Sidebar resize handlers ──
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartX.current;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, resizeStartWidth.current + delta));
      setSidebarWidth(next);
    };
    const handleUp = () => {
      setIsResizing(false);
      setSidebarWidth((w) => {
        if (typeof window !== "undefined") window.localStorage.setItem("pi-agent.sidebar-width", String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isResizing]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      if (prev.find((t) => t.id === tabId)) return prev;
      return [...prev, { id: tabId, label: fileName, filePath }];
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
  }, []);

  const handleAgentEnd = useCallback((changedFiles?: string[]) => {
    if (selectedSession?.id) setSessionRunning(selectedSession.id, false);
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    const filePath = changedFiles?.filter(shouldAutoOpenFile).at(-1);
    if (filePath) handleOpenFile(filePath, fileNameFromPath(filePath));
  }, [handleOpenFile, selectedSession?.id, setSessionRunning]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleCloseSessionTab = useCallback((sessionId: string) => {
    if (pendingTempTabIdRef.current === sessionId) {
      pendingTempTabIdRef.current = null;
    }
    setSessionTabs((prev) => {
      const next = prev.filter((t) => t.id !== sessionId);
      // If closing the active tab, switch to previous or clear
      if (selectedSession?.id === sessionId) {
        const remaining = next.filter((t) => t.id !== sessionId);
        if (remaining.length > 0) {
          const nextSession = remaining[remaining.length - 1];
          setSelectedSession(nextSession);
          setActiveSessionTabId(nextSession.id);
          setSessionKey((k) => k + 1);
          setSystemPrompt(null);
        } else {
          setSelectedSession(null);
          setActiveSessionTabId(null);
          setNewSessionCwd(null);
        }
      }
      return next;
    });
  }, [selectedSession]);

  // Show chat area only when a session tab is open and active, or when a new-session tab is active
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const hasSessionTabs = sessionTabs.length > 0;
  const showChat = hasSessionTabs && (selectedSession !== null || effectiveNewSessionCwd !== null);
  // Show watermark only when absolutely nothing is open (no tabs, no session, no new-session cwd)
  const showWatermark = !showChat && !hasSessionTabs;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat && hasSessionTabs;

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;

  const sidebarContent = (
    <div
      style={{
        width: sidebarCompact ? SIDEBAR_COMPACT : "100%",
        minWidth: sidebarCompact ? SIDEBAR_COMPACT : "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        overflow: "hidden",
      }}
    >
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        optimisticSession={pendingSession ?? selectedSession}
        runningSessionIds={runningSessionIds}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
        compact={sidebarCompact}
      />
      <div style={{ padding: sidebarCompact ? "8px 0" : "8px", flexShrink: 0, display: "flex", flexDirection: sidebarCompact ? "column" : "row", alignItems: "center", justifyContent: sidebarCompact ? "center" : "space-between", gap: 4 }}>
        {([
          {
            label: "模型配置",
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
            label: "技能配置",
            onClick: () => setSkillsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: React.ReactNode }[]).map(({ label, onClick, disabled, icon }) => (
          <button
            key={label}
            onClick={onClick}
            disabled={disabled}
            title={label}
            style={{
              flex: sidebarCompact ? "0 0 auto" : 1,
              width: sidebarCompact ? 30 : undefined,
              height: sidebarCompact ? 30 : 32,
              display: "flex", alignItems: "center", justifyContent: "center", gap: sidebarCompact ? 0 : 6,
              padding: 0,
              background: sidebarCompact ? "var(--bg-hover)" : "none",
              border: sidebarCompact ? "1px solid var(--border)" : "none",
              borderRadius: sidebarCompact ? 999 : 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = sidebarCompact ? "var(--bg-hover)" : "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
            {!sidebarCompact && label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
    {/* Custom titlebar content — rendered in the native macOS traffic-light row. */}
    <div
      data-tauri-drag-region="deep"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 28,
        zIndex: 900,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        WebkitAppRegion: "drag",
      } as DraggableStyle}
    >
      <div data-tauri-drag-region style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", opacity: 0.85, pointerEvents: "none" }}>pi-agent</div>
      <button
        data-tauri-drag-region="false"
        onClick={() => setSidebarMode((mode) => mode === "open" ? "compact" : mode === "compact" ? "closed" : "open")}
        title={sidebarMode === "open" ? "收缩侧边栏" : sidebarMode === "compact" ? "隐藏侧边栏" : "显示侧边栏"}
        aria-label={sidebarMode === "open" ? "收缩侧边栏" : sidebarMode === "compact" ? "隐藏侧边栏" : "显示侧边栏"}
        aria-pressed={sidebarOpen}
        style={{
          position: "absolute",
          left: 78,
          top: 2,
          width: 24,
          height: 24,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: 7,
          color: "var(--text-muted)",
          cursor: "pointer",
          transition: "color 0.12s, background 0.12s, border-color 0.12s",
          WebkitAppRegion: "no-drag",
        } as DraggableStyle}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
      >
        {sidebarMode === "closed" ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        ) : sidebarMode === "compact" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="6.5" y1="3" x2="6.5" y2="21" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        )}
      </button>
      <button
        data-tauri-drag-region="false"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }}
        title={isDark ? "切换为浅色模式" : "切换为深色模式"}
        aria-label={isDark ? "切换为浅色模式" : "切换为深色模式"}
        aria-pressed={isDark}
        style={{
          position: "absolute",
          right: 40,
          top: 2,
          width: 24,
          height: 24,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: 7,
          color: "var(--text-muted)",
          cursor: "pointer",
          transition: "color 0.12s, background 0.12s, border-color 0.12s",
          WebkitAppRegion: "no-drag",
        } as DraggableStyle}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
      >
        {isDark ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </button>
      <button
        data-tauri-drag-region="false"
        onClick={() => setRightPanelOpen((v) => !v)}
        title={rightPanelOpen ? "隐藏文件面板" : "显示文件面板"}
        aria-label={rightPanelOpen ? "隐藏文件面板" : "显示文件面板"}
        aria-pressed={rightPanelOpen}
        style={{
          position: "absolute",
          right: 10,
          top: 2,
          width: 24,
          height: 24,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: rightPanelOpen ? "var(--bg-selected)" : "transparent",
          border: "1px solid transparent",
          borderRadius: 7,
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          transition: "color 0.12s, background 0.12s, border-color 0.12s",
          WebkitAppRegion: "no-drag",
        } as DraggableStyle}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; e.currentTarget.style.background = rightPanelOpen ? "var(--bg-selected)" : "transparent"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    </div>
    <div style={{ display: "flex", height: "calc(100dvh - 28px)", marginTop: 28, overflow: "hidden", background: "var(--bg)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className="sidebar-overlay-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: 0,
          pointerEvents: "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${sidebarCompact ? " sidebar-compact" : ""}`}
        style={{
          width: sidebarMode === "closed" ? 0 : sidebarCompact ? SIDEBAR_COMPACT : sidebarWidth,
          minWidth: sidebarMode === "closed" ? 0 : sidebarCompact ? SIDEBAR_COMPACT : SIDEBAR_MIN,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          transition: isResizing ? "none" : undefined,
        }}
      >
        {sidebarContent}
      </div>

      {/* Resize handle */}
      {sidebarMode === "open" && (
        <div
          onMouseDown={handleResizeStart}
          style={{
            width: 5,
            cursor: "col-resize",
            flexShrink: 0,
            background: isResizing ? "var(--accent)" : "transparent",
            transition: isResizing ? "none" : "background 0.15s",
            zIndex: 201,
            marginLeft: -2,
            marginRight: -2,
          }}
          onMouseEnter={(e) => { if (!isResizing) e.currentTarget.style.background = "var(--border)"; }}
          onMouseLeave={(e) => { if (!isResizing) e.currentTarget.style.background = "transparent"; }}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>
          {/* System prompt icon — always visible */}
          <button
            ref={systemBtnRef}
            onClick={() => toggleTopPanel("system")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, padding: 0,
              background: activeTopPanel === "system" ? "var(--bg-selected)" : "transparent",
              border: "none", borderRadius: 8,
              cursor: "pointer",
              color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
              marginLeft: 8, flexShrink: 0,
              transition: "color 0.1s, background 0.1s",
            }}
            title="系统提示词"
            aria-label="系统提示词"
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = activeTopPanel === "system" ? "var(--bg-selected)" : "transparent"; e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "currentColor" }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
          </button>
          {/* Session tabs */}
          {sessionTabs.length > 0 && (
            <div style={{ flex: 1, minWidth: 0, alignSelf: "stretch", display: "flex", alignItems: "stretch", overflowX: "auto", overflowY: "hidden", gap: 2 }}>
              {sessionTabs.map((tab) => {
                const isActive = tab.id === (selectedSession?.id ?? activeSessionTabId);
                const title = tab.name || tab.firstMessage?.slice(0, 100) || tab.id.slice(0, 16);
                return (
                  <div
                    key={tab.id}
                    onClick={() => handleSelectSession(tab)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "0 10px",
                      background: "transparent",
                      borderRadius: "6px 6px 0 0",
                      borderBottom: isActive ? "2px solid var(--text-muted)" : "2px solid transparent",
                      cursor: "pointer",
                      fontSize: 12,
                      color: isActive ? "var(--text)" : "var(--text-muted)",
                      whiteSpace: "nowrap",
                      maxWidth: 160,
                      flexShrink: 0,
                      userSelect: "none",
                      transition: "background 0.1s, color 0.1s",
                      marginBottom: -1,
                    }}
                    title={title}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {(() => {
                      const displayName = tab.name || tab.firstMessage?.slice(0, 40) || tab.id.slice(0, 8);
                      return (
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: isActive ? 500 : 400, opacity: tab.name ? 1 : 0.7 }}>
                          {displayName.length > 14 ? displayName.slice(0, 12) + "…" : displayName}
                        </span>
                      );
                    })()}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCloseSessionTab(tab.id); }}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 16, height: 16, padding: 0, flexShrink: 0,
                        background: "transparent", border: "none", borderRadius: 3,
                        color: "var(--text-dim)", cursor: "pointer",
                        fontSize: 12, lineHeight: 1,
                      }}
                      title="关闭"
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-hover)";
                        e.currentTarget.style.color = "var(--text)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "var(--text-dim)";
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {/* New session button — far right */}
          <button
            onClick={handleTopNewSession}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0, flexShrink: 0,
              background: "transparent", border: "none", borderRadius: 6,
              color: "var(--text-dim)", cursor: "pointer",
              marginLeft: "auto",
              marginRight: 4,
            }}
            title="新建会话"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-dim)";
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
            const t = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
            if (t) {
              tooltipParts.push(`in: ${t.input.toLocaleString()}`);
              tooltipParts.push(`out: ${t.output.toLocaleString()}`);
              tooltipParts.push(`cache read: ${t.cacheRead.toLocaleString()}`);
              tooltipParts.push(`cache write: ${t.cacheWrite.toLocaleString()}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <div
                title={tooltip}
                style={{
                  marginLeft: 0,
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: 12,
                  height: "100%",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "default",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {t && t.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                    {fmt(t.input)}
                  </span>
                )}
                {t && t.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {fmt(t.output)}
                  </span>
                )}
                {t && t.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                    {fmt(t.cacheRead)}
                  </span>
                )}
                {costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </div>
            );
          })()}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              zIndex: 500,
            }}>
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      系统提示词为空（已禁用工具）
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      发送一条消息以加载系统提示词
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {/* Watermark when no session tabs */}
          {!hasSessionTabs && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 0,
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 64,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  maxWidth: "96%",
                  boxSizing: "border-box",
                  color: "var(--text)",
                  opacity: isDark ? 0.035 : 0.045,
                  fontSize: "clamp(48px, 10vw, 160px)",
                  fontWeight: 900,
                  letterSpacing: "-0.05em",
                  lineHeight: 1.15,
                  padding: "0.12em 0.08em",
                  textAlign: "center",
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                  userSelect: "none",
                }}
              >
                PI Agent
              </div>
            </div>
          )}
          {!hasSessionTabs && initialSessionRestored && (
            <div
              aria-label="快速新建会话"
              style={{
                position: "absolute",
                left: "50%",
                bottom: 112,
                transform: "translateX(-50%)",
                zIndex: 2,
                width: "min(560px, calc(100% - 96px))",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                textAlign: "center",
              }}
            >
              <button
                onClick={handleTopNewSession}
                disabled={!effectiveProjectCwd}
                title={effectiveProjectCwd ? `在 ${effectiveProjectCwd} 新建会话` : "请先在左侧选择项目目录"}
                style={{
                  minHeight: 58,
                  minWidth: 300,
                  maxWidth: "100%",
                  padding: "8px 12px 8px 10px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 11,
                  borderRadius: 18,
                  border: effectiveProjectCwd
                    ? "1px solid color-mix(in srgb, var(--text) 18%, var(--border))"
                    : "1px solid var(--border)",
                  background: effectiveProjectCwd
                    ? isDark
                      ? "linear-gradient(135deg, color-mix(in srgb, var(--text) 7%, var(--bg-panel)), var(--bg-panel) 62%, color-mix(in srgb, #fff 3%, var(--bg)))"
                      : "linear-gradient(135deg, #ffffff, var(--bg-panel) 62%, color-mix(in srgb, var(--text) 3%, var(--bg)))"
                    : "var(--bg-panel)",
                  color: effectiveProjectCwd ? "var(--text)" : "var(--text-dim)",
                  boxShadow: effectiveProjectCwd
                    ? isDark
                      ? "0 18px 42px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.06)"
                      : "0 18px 42px rgba(15,23,42,0.10), inset 0 1px 0 rgba(255,255,255,0.7)"
                    : "inset 0 1px 0 rgba(255,255,255,0.08)",
                  cursor: effectiveProjectCwd ? "pointer" : "not-allowed",
                  fontSize: 14,
                  fontFamily: "inherit",
                  textAlign: "left",
                  userSelect: "none",
                  transition: "transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease",
                }}
                onMouseEnter={(e) => {
                  if (!effectiveProjectCwd) return;
                  e.currentTarget.style.transform = "translateY(-2px)";
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--text) 28%, var(--border))";
                  e.currentTarget.style.boxShadow = isDark
                    ? "0 24px 56px rgba(0,0,0,0.34), 0 0 0 4px color-mix(in srgb, #fff 7%, transparent), inset 0 1px 0 rgba(255,255,255,0.08)"
                    : "0 24px 56px rgba(15,23,42,0.14), 0 0 0 4px rgba(0,0,0,0.045), inset 0 1px 0 rgba(255,255,255,0.78)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.borderColor = effectiveProjectCwd
                    ? "color-mix(in srgb, var(--text) 18%, var(--border))"
                    : "var(--border)";
                  e.currentTarget.style.boxShadow = effectiveProjectCwd
                    ? isDark
                      ? "0 18px 42px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.06)"
                      : "0 18px 42px rgba(15,23,42,0.10), inset 0 1px 0 rgba(255,255,255,0.7)"
                    : "inset 0 1px 0 rgba(255,255,255,0.08)";
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 14,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: effectiveProjectCwd ? (isDark ? "#111" : "#fff") : "var(--text-dim)",
                    background: effectiveProjectCwd
                      ? isDark
                        ? "linear-gradient(135deg, #f3f4f6, #c7c7c7)"
                        : "linear-gradient(135deg, #111827, #3f3f46)"
                      : "var(--bg-hover)",
                    boxShadow: effectiveProjectCwd
                      ? isDark
                        ? "0 10px 24px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.45)"
                        : "0 10px 24px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.18)"
                      : "none",
                  }}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </span>
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                  <span style={{ fontSize: 15, lineHeight: 1.15, fontWeight: 750, letterSpacing: "-0.01em" }}>新建会话</span>
                  <span
                    style={{
                      maxWidth: 210,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 12,
                      lineHeight: 1.2,
                      color: "var(--text-muted)",
                    }}
                  >
                    {effectiveProjectCwd ? `在 ${getProjectName(effectiveProjectCwd)} 中开始` : "请先选择项目目录"}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: effectiveProjectCwd ? "var(--text-muted)" : "var(--text-dim)",
                    background: "var(--bg-hover)",
                    opacity: effectiveProjectCwd ? 1 : 0.55,
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14" />
                    <path d="m13 6 6 6-6 6" />
                  </svg>
                </span>
              </button>
              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  color: "var(--text-dim)",
                  background: "color-mix(in srgb, var(--bg-panel) 70%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                {effectiveProjectCwd ? "也可以点击顶部右侧 + 创建新页签" : "从左侧选择项目后，这里会变成快速入口"}
              </div>
            </div>
          )}
          {showChat && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 0,
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 64,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  maxWidth: "96%",
                  boxSizing: "border-box",
                  color: "var(--text)",
                  opacity: isDark ? 0.035 : 0.045,
                  fontSize: "clamp(48px, 10vw, 160px)",
                  fontWeight: 900,
                  letterSpacing: "-0.05em",
                  lineHeight: 1.15,
                  padding: "0.12em 0.08em",
                  textAlign: "center",
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                  userSelect: "none",
                }}
              >
                {effectiveProjectCwd ? getProjectName(effectiveProjectCwd) : ""}
              </div>
            </div>
          )}
          {showChat ? (
            <div style={{ position: "relative", zIndex: 1, height: "100%" }}>
              <ChatWindow
                key={sessionKey}
                session={selectedSession}
                newSessionCwd={effectiveNewSessionCwd}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleSessionCreated}
                onSessionStarted={handleSessionStarted}
                onAgentRunningChange={setSessionRunning}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onSystemPromptChange={handleSystemPromptChange}
                onSessionStatsChange={handleSessionStatsChange}
                onContextUsageChange={handleContextUsageChange}
                onOpenFile={handleOpenFile}
              />
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                从侧边栏中选择一个会话
              </div>
            ) : (
              <div style={{ position: "absolute", top: 64, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>开始使用</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>从侧边栏选择项目目录<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>点击底部的 “模型配置” 按钮配置模型
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {activeFileTab?.filePath ? (
            <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              未打开任何文件
            </div>
          )}
        </div>
      </div>
    </div>
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {skillsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <SkillsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setSkillsConfigOpen(false)} />
    )}
    </>
  );
}
