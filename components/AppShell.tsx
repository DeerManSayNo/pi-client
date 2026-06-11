"use client";

import { useState, useCallback, useRef, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { SchedulerPanel } from "./SchedulerPanel";
import { RoleConfig } from "./RoleConfig";
import { MemoryConfig } from "./MemoryConfig";
import { McpConfig } from "./McpConfig";
import { ExtensionsConfig } from "./ExtensionsConfig";
import { LogPanel } from "./LogPanel";
import { WeChatConfig } from "./WeChatConfig";
import { getLocalStorageItem } from "@/lib/client-storage";
import { getRelativeFilePath } from "@/lib/file-paths";
import { useTheme } from "@/hooks/useTheme";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SessionInfo } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";

type DraggableStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };
type SidebarMode = "open" | "closed";
type RunningSessionStatus = {
  sessionId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  lastEventType: string;
  eventCount: number;
  eventRate: number;
  eventIdleMs: number | null;
  contentIdleMs: number | null;
};

const AUTO_OPEN_EXTENSIONS = new Set([".html", ".htm", ".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml", ".env", ".xml", ".ini", ".cfg", ".conf"]);

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function shouldAutoOpenFile(filePath: string): boolean {
  const name = fileNameFromPath(filePath).toLowerCase();
  const ext = "." + (name.split(".").pop() ?? "");
  return Boolean(name) && AUTO_OPEN_EXTENSIONS.has(ext);
}

function getProjectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

const CUSTOM_CWDS_STORAGE_KEY = "deerhux.custom-cwds";

function readCustomCwds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(getLocalStorageItem(CUSTOM_CWDS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
  } catch {
    return [];
  }
}

export function AppShell() {
  const searchParams = useSearchParams();
  const { isDark, toggleTheme } = useTheme();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  // Session tabs — browser-style in top bar
  const [sessionTabs, setSessionTabs] = useState<SessionInfo[]>([]);
  const [activeSessionTabId, setActiveSessionTabId] = useState<string | null>(null);
  const [sessionTabContextMenu, setSessionTabContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [extensionsConfigOpen, setExtensionsConfigOpen] = useState(false);
  const [quickConfigOpen, setQuickConfigOpen] = useState<"memory" | "mcp" | "role" | null>(null);
  const [schedulerPanelOpen, setSchedulerPanelOpen] = useState(false);
  const [wechatConfigOpen, setWechatConfigOpen] = useState(false);
  const [wechatStatus, setWechatStatus] = useState<{ connected: boolean; polling: boolean; accountId?: string; activeUserCount?: number } | null>(null);
  const [runningSessionStatuses, setRunningSessionStatuses] = useState<Map<string, RunningSessionStatus>>(new Map());
  const pendingSessionIdRef = useRef<string | null>(null);
  const pendingTempTabIdRef = useRef<string | null>(null);
  // Track which tab ids are genuine placeholders (not real sessions),
  // so handleSelectSession knows when to show a new-session UI vs load from API.
  const placeholderTabIdsRef = useRef<Set<string>>(new Set());
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("open");
  const sidebarOpen = sidebarMode === "open";
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 500;
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(260);

  // Right panel (file viewer) resize
  const RIGHT_PANEL_MIN = 250;
  const RIGHT_PANEL_MAX = 1000;
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(500);
  const [isResizingRightPanel, setIsResizingRightPanel] = useState(false);
  const rightPanelResizeStartX = useRef(0);
  const rightPanelResizeStartWidth = useRef(500);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const wechatAutoStartAttemptedRef = useRef(false);

  // Platform detection — only show custom window controls on Windows
  const isWindowsPlatform = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
  const handleWindowAction = useCallback((action: 'minimize' | 'maximize' | 'close') => {
    try {
      const win = getCurrentWindow();
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') win.toggleMaximize();
      else if (action === 'close') win.close();
    } catch { /* ignore in non-Tauri contexts */ }
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

  const replaceUrl = useCallback((url: string) => {
    window.history.replaceState(null, "", url);
  }, []);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(false);

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.addReference(relativePath);
  }, []);

  const handleProjectsChange = useCallback((projects: { cwd: string; displayName: string }[]) => {
    setProjectOptions(projects);
  }, []);

  const [initialSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [customCwds, setCustomCwds] = useState<string[]>([]);
  const [projectOptions, setProjectOptions] = useState<{ cwd: string; displayName: string }[]>([]);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);

  useEscapeClose(() => setProjectPickerOpen(false), projectPickerOpen);
  useEscapeClose(() => setSettingsMenuOpen(false), settingsMenuOpen);

  const effectiveProjectCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? defaultCwd;
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !searchParams.get("session"));
  // Suppresses extra cwd handling during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  // Sync client-only localStorage state after mount to avoid hydration mismatch
  useEffect(() => {
    const storedWidth = getLocalStorageItem("deerhux.sidebar-width");
    if (storedWidth) {
      const parsed = parseInt(storedWidth, 10);
      if (Number.isFinite(parsed)) setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed)));
    }
    const storedRightWidth = getLocalStorageItem("deerhux.right-panel-width");
    if (storedRightWidth) {
      const parsed = parseInt(storedRightWidth, 10);
      if (Number.isFinite(parsed)) setRightPanelWidth(Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, parsed)));
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
        .then((data: { runningSessionIds?: string[]; sessions?: RunningSessionStatus[] }) => {
          if (!cancelled) setRunningSessionStatuses(new Map((data.sessions ?? []).map((session) => [session.sessionId, session])));
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

  // Periodically refresh the sidebar session list while any session is running,
  // so newly created sessions and updated modified timestamps are reflected.
  useEffect(() => {
    if (runningSessionStatuses.size === 0) return;
    const interval = setInterval(() => {
      setRefreshKey((k) => k + 1);
    }, 4000);
    return () => clearInterval(interval);
  }, [runningSessionStatuses.size]);

  // Poll WeChat bot status for the settings dropdown inline indicator
  useEffect(() => {
    const fetchWechat = () => {
      fetch("/api/wechat", { cache: "no-store" })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => {
          if (!data) return;
          setWechatStatus(data);
          if (!wechatAutoStartAttemptedRef.current && data.connected && !data.polling) {
            wechatAutoStartAttemptedRef.current = true;
            fetch("/api/wechat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "start" }),
            })
              .then((res) => res.ok ? fetchWechat() : null)
              .catch(() => {});
          }
        })
        .catch(() => {});
    };
    fetchWechat();
    const interval = setInterval(fetchWechat, 5000);
    return () => clearInterval(interval);
  }, []);

  const setSessionRunning = useCallback((sessionId: string | null | undefined, running: boolean) => {
    if (!sessionId) return;
    setRunningSessionStatuses((prev) => {
      const next = new Map(prev);
      if (running) {
        const existing = next.get(sessionId);
        next.set(sessionId, existing ?? {
          sessionId,
          isStreaming: true,
          isCompacting: false,
          lastEventType: "agent_start",
          eventCount: 0,
          eventRate: 0,
          eventIdleMs: 0,
          contentIdleMs: 0,
        });
      } else {
        next.delete(sessionId);
      }
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
    replaceUrl("/");
  }, [replaceUrl]);

  const handleHeaderProjectSelect = useCallback((cwd: string) => {
    // Only allow changing cwd before a real session has started.
    // This is the "nothing has been input yet" state for a new-session tab.
    if (selectedSession !== null || pendingSession !== null) return;
    setProjectPickerOpen(false);
    setActiveCwd(cwd);
    setNewSessionCwd(cwd);
    setSessionTabs((prev) => prev.map((tab) => (
      tab.id === activeSessionTabId && tab.path === "" ? { ...tab, cwd } : tab
    )));
    replaceUrl("/");
  }, [activeSessionTabId, pendingSession, replaceUrl, selectedSession]);

  useEffect(() => {
    if (!projectPickerOpen) return;
    const close = () => setProjectPickerOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [projectPickerOpen]);

  useEffect(() => {
    if (!settingsMenuOpen) return;
    const close = () => setSettingsMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [settingsMenuOpen]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Do not clear pendingSession here: a newly-created session is not written
    // to disk by DeerHux until the first assistant message exists. If the user
    // switches away while that first response is still running, /api/sessions
    // cannot list it yet, so the sidebar must keep showing the optimistic row.
    // Only placeholder tabs (created by top bar "+") show the new-session UI.
    if (placeholderTabIdsRef.current.has(session.id)) {
      setNewSessionCwd(session.cwd);
      setSelectedSession(null);
      setActiveSessionTabId(session.id);
      replaceUrl("/");
      return;
    }
    setNewSessionCwd(null);
    // If the session came from the sidebar it may have updated fields (e.g. path,
    // name). Update the tab in place so subsequent tab clicks have the real data.
    setSessionTabs((prev) => {
      const existingIdx = prev.findIndex((t) => t.id === session.id);
      if (existingIdx >= 0) {
        const updated = [...prev];
        updated[existingIdx] = { ...updated[existingIdx], ...session };
        return updated;
      }
      return [...prev, session];
    });
    setSelectedSession(session);
    setActiveSessionTabId(session.id);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress redundant cwd handling that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
      setTimeout(() => { suppressCwdBumpRef.current = false; }, 0);
    }
    // Skip URL replacement when restoring from URL — the param is already correct
    // and touching App Router during production restore previously caused remount loops
    if (!isRestore) {
      replaceUrl(`?session=${encodeURIComponent(session.id)}`);
    }
  }, [replaceUrl]);

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
    // Track this as a genuine placeholder so handleSelectSession shows
    // the new-session UI, not a real session load.
    placeholderTabIdsRef.current.add(_sessionId);
    setPendingSession(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    replaceUrl("/");
  }, [replaceUrl]);

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
    // Track this as a genuine placeholder so handleSelectSession shows
    // the new-session UI, not a real session load.
    placeholderTabIdsRef.current.add(tempId);
    setPendingSession(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    replaceUrl("/");
  }, [effectiveProjectCwd, replaceUrl]);

  const handleSessionStarted = useCallback((session: SessionInfo | null) => {
    if (!session) {
      if (pendingSessionIdRef.current) {
        setSessionRunning(pendingSessionIdRef.current, false);
      }
      pendingSessionIdRef.current = null;
      setPendingSession(null);
      return;
    }
    pendingSessionIdRef.current = session.id;
    setPendingSession(session);
    setSessionRunning(session.id, true);
    setRefreshKey((k) => k + 1);
  }, [setSessionRunning]);

  // Called by ChatWindow when a new session gets its real id from DeerHux
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setSessionRunning(pendingSessionIdRef.current, false);
    pendingSessionIdRef.current = null;
    setSessionRunning(session.id, true);
    // Keep an optimistic entry with the real id until SessionManager.listAll()
    // can see the file. For brand-new sessions DeerHux delays writing the jsonl
    // until an assistant message is persisted, so clearing this immediately
    // makes the session disappear from the sidebar when switching away mid-run.
    setPendingSession(session);
    setNewSessionCwd(null);
    setSelectedSession(session);
    // Replace placeholder tab created by "+" button with real session
    const tempId = pendingTempTabIdRef.current;
    pendingTempTabIdRef.current = null;
    // The placeholder is now a real session — remove from placeholder set
    if (tempId) placeholderTabIdsRef.current.delete(tempId);
    setSessionTabs((prev) => {
      const filtered = tempId ? prev.filter((t) => t.id !== tempId) : prev;
      if (filtered.find((t) => t.id === session.id)) return filtered;
      return [...filtered, session];
    });
    setActiveSessionTabId((cur) => cur === tempId ? session.id : cur);
    setRefreshKey((k) => k + 1);
    replaceUrl(`?session=${encodeURIComponent(session.id)}`);
  }, [replaceUrl, setSessionRunning]);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    replaceUrl(`?session=${encodeURIComponent(newSessionId)}`);
  }, [replaceUrl]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  // ── Sidebar resize handlers ──
  const finishSidebarResize = useCallback(() => {
    setIsResizing(false);
    setSidebarWidth((w) => {
      if (typeof window !== "undefined") window.localStorage.setItem("deerhux.sidebar-width", String(w));
      return w;
    });
  }, []);

  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: PointerEvent) => {
      const delta = e.clientX - resizeStartX.current;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, resizeStartWidth.current + delta));
      setSidebarWidth(next);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) finishSidebarResize();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finishSidebarResize);
    window.addEventListener("pointercancel", finishSidebarResize);
    window.addEventListener("blur", finishSidebarResize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finishSidebarResize);
      window.removeEventListener("pointercancel", finishSidebarResize);
      window.removeEventListener("blur", finishSidebarResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [finishSidebarResize, isResizing]);

  // ── Right panel resize handlers ──
  const finishRightPanelResize = useCallback(() => {
    setIsResizingRightPanel(false);
    setRightPanelWidth((w) => {
      if (typeof window !== "undefined") window.localStorage.setItem("deerhux.right-panel-width", String(w));
      return w;
    });
  }, []);

  const handleRightPanelResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizingRightPanel(true);
    rightPanelResizeStartX.current = e.clientX;
    rightPanelResizeStartWidth.current = rightPanelWidth;
  }, [rightPanelWidth]);

  useEffect(() => {
    if (!isResizingRightPanel) return;
    const handleMove = (e: PointerEvent) => {
      const delta = rightPanelResizeStartX.current - e.clientX;
      const next = Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, rightPanelResizeStartWidth.current + delta));
      setRightPanelWidth(next);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) finishRightPanelResize();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finishRightPanelResize);
    window.addEventListener("pointercancel", finishRightPanelResize);
    window.addEventListener("blur", finishRightPanelResize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finishRightPanelResize);
      window.removeEventListener("pointercancel", finishRightPanelResize);
      window.removeEventListener("blur", finishRightPanelResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [finishRightPanelResize, isResizingRightPanel]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      replaceUrl("/");
    }
  }, [selectedSession, replaceUrl]);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      if (prev.find((t) => t.id === tabId)) return prev;
      return [...prev, { id: tabId, label: fileName, filePath }];
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
  }, []);

  const handleSelectFileTab = useCallback((tabId: string) => {
    if (rightPanelOpen && tabId === activeFileTabId && tabId !== "__log__") {
      const tab = fileTabs.find((t) => t.id === tabId);
      if (tab) {
        chatInputRef.current?.toggleReference(getRelativeFilePath(tab.filePath, effectiveProjectCwd ?? undefined));
        return;
      }
    }
    setActiveFileTabId(tabId);
  }, [activeFileTabId, effectiveProjectCwd, fileTabs, rightPanelOpen]);

  const handleAgentEnd = useCallback((sessionId: string, changedFiles?: string[]) => {
    setSessionRunning(sessionId, false);
    // Clear pendingSession if the ended session was being tracked as pending
    setPendingSession((prev) => (prev?.id === sessionId ? null : prev));
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    const filePath = changedFiles?.filter(shouldAutoOpenFile).at(-1);
    if (filePath) handleOpenFile(filePath, fileNameFromPath(filePath));
  }, [handleOpenFile, setSessionRunning]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    // Closing the log tab
    if (tabId === "__log__") {
      setLogPanelOpen(false);
      // If no file tabs remain, close the right panel
      if (fileTabs.length === 0) setRightPanelOpen(false);
      return;
    }
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0 && !logPanelOpen) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs, logPanelOpen]);

  const handleCloseFileTabs = useCallback((tabIds: string[]) => {
    const ids = new Set(tabIds);
    if (ids.size === 0) return;

    const closingLog = ids.has("__log__");
    if (closingLog) setLogPanelOpen(false);

    const nextFileTabs = fileTabs.filter((tab) => !ids.has(tab.id));
    setFileTabs(nextFileTabs);

    const nextTabs = [
      ...(!closingLog && logPanelOpen ? [{ id: "__log__" as string }] : []),
      ...nextFileTabs,
    ];

    setActiveFileTabId((cur) => {
      if (cur && !ids.has(cur)) return cur;
      return nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
    });

    if (nextTabs.length === 0) setRightPanelOpen(false);
  }, [fileTabs, logPanelOpen]);

  const handleCloseSessionTab = useCallback((sessionId: string) => {
    if (pendingTempTabIdRef.current === sessionId) {
      pendingTempTabIdRef.current = null;
    }
    placeholderTabIdsRef.current.delete(sessionId);
    setSessionTabs((prev) => {
      const next = prev.filter((t) => t.id !== sessionId);
      // If closing the active tab, switch to previous or clear
      const isClosingActive = selectedSession?.id === sessionId || activeSessionTabId === sessionId;
      if (isClosingActive) {
        const remaining = next.filter((t) => t.id !== sessionId);
        if (remaining.length > 0) {
          const nextSession = remaining[remaining.length - 1];
          setActiveSessionTabId(nextSession.id);
          if (placeholderTabIdsRef.current.has(nextSession.id)) {
            setSelectedSession(null);
            setNewSessionCwd(nextSession.cwd);
          } else {
            setSelectedSession(nextSession);
            setNewSessionCwd(null);
          }
        } else {
          setSelectedSession(null);
          setActiveSessionTabId(null);
          setNewSessionCwd(null);
        }
      }
      return next;
    });
  }, [activeSessionTabId, selectedSession]);

  const handleCloseSessionTabs = useCallback((sessionIds: string[]) => {
    const ids = new Set(sessionIds);
    if (ids.size === 0) return;

    if (pendingTempTabIdRef.current && ids.has(pendingTempTabIdRef.current)) {
      pendingTempTabIdRef.current = null;
    }
    ids.forEach((id) => placeholderTabIdsRef.current.delete(id));

    const next = sessionTabs.filter((tab) => !ids.has(tab.id));
    setSessionTabs(next);

    const activeId = selectedSession?.id ?? activeSessionTabId;
    if (!activeId || !ids.has(activeId)) return;

    if (next.length > 0) {
      const nextSession = next[next.length - 1];
      setActiveSessionTabId(nextSession.id);
      if (placeholderTabIdsRef.current.has(nextSession.id)) {
        setSelectedSession(null);
        setNewSessionCwd(nextSession.cwd);
      } else {
        setSelectedSession(nextSession);
        setNewSessionCwd(null);
      }
    } else {
      setSelectedSession(null);
      setActiveSessionTabId(null);
      setNewSessionCwd(null);
    }
  }, [activeSessionTabId, selectedSession, sessionTabs]);

  useEffect(() => {
    if (!sessionTabContextMenu) return;
    const close = () => setSessionTabContextMenu(null);
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleKey);
    };
  }, [sessionTabContextMenu]);

  // Show chat area only when a session tab is open and active, or when a new-session tab is active
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const hasSessionTabs = sessionTabs.length > 0;
  const showChat = hasSessionTabs && (selectedSession !== null || effectiveNewSessionCwd !== null);
  // Show watermark only when absolutely nothing is open (no tabs, no session, no new-session cwd)
  const showWatermark = !showChat && !hasSessionTabs;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat && hasSessionTabs;

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const canSwitchHeaderProject = selectedSession === null && pendingSession === null;
  const headerProjectOptions = useMemo(() => {
    const byCwd = new Map<string, string>();
    for (const project of projectOptions) byCwd.set(project.cwd, project.displayName);
    for (const cwd of customCwds) if (!byCwd.has(cwd)) byCwd.set(cwd, getProjectName(cwd));
    if (defaultCwd && !byCwd.has(defaultCwd)) byCwd.set(defaultCwd, "默认");
    if (effectiveProjectCwd && !byCwd.has(effectiveProjectCwd)) byCwd.set(effectiveProjectCwd, getProjectName(effectiveProjectCwd));
    return [...byCwd.entries()].map(([cwd, displayName]) => ({ cwd, displayName }));
  }, [customCwds, defaultCwd, effectiveProjectCwd, projectOptions]);

  const sidebarContent = (
    <div
      style={{
        width: "100%",
        minWidth: "100%",
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
        runningSessionStatuses={runningSessionStatuses}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
        onProjectsChange={handleProjectsChange}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
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
            label: "记忆",
            onClick: () => setQuickConfigOpen("memory"),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v16H6.5A2.5 2.5 0 0 1 4 17.5z" />
                <path d="M8 8h8" />
                <path d="M8 12h6" />
                <path d="M8 16h7" />
              </svg>
            ),
          },
          {
            label: "MCP",
            onClick: () => setQuickConfigOpen("mcp"),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="8.5" y="14" width="7" height="7" rx="1.5" />
                <path d="M10 6.5h4" />
                <path d="M17.5 10v2a2 2 0 0 1-2 2H12" />
                <path d="M6.5 10v2a2 2 0 0 0 2 2H12" />
              </svg>
            ),
          },
          {
            label: "角色",
            onClick: () => setQuickConfigOpen("role"),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
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
          {
            label: "定时任务",
            onClick: () => setSchedulerPanelOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: React.ReactNode }[]).map(({ label, onClick, disabled, icon }, index) => (
          <button
            key={`${label}-${index}`}
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
            style={{
              flex: 1,
              height: 32,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: 0,
              background: "none",
              border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );

  const sessionContextTab = sessionTabContextMenu ? sessionTabs.find((tab) => tab.id === sessionTabContextMenu.sessionId) : null;
  const sessionContextIndex = sessionContextTab ? sessionTabs.findIndex((tab) => tab.id === sessionContextTab.id) : -1;
  const sessionRightTabIds = sessionContextIndex >= 0 ? sessionTabs.slice(sessionContextIndex + 1).map((tab) => tab.id) : [];
  const sessionOtherTabIds = sessionContextTab ? sessionTabs.filter((tab) => tab.id !== sessionContextTab.id).map((tab) => tab.id) : [];
  const sessionAllTabIds = sessionTabs.map((tab) => tab.id);

  const sessionContextMenuItemStyle: CSSProperties = {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 9px",
    background: "transparent",
    border: "none",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 12,
  };

  const renderSessionContextMenuButton = (label: string, disabled: boolean, onClick: () => void, icon: ReactNode) => (
    <button
      style={{ ...sessionContextMenuItemStyle, opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer", color: disabled ? "var(--text-dim)" : "var(--text-muted)" }}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {icon}
      {label}
    </button>
  );

  const closeIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
  );
  const closeRightIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6l6 6-6 6" /><path d="M16 6v12" /></svg>
  );
  const closeOthersIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 9l8 8" /><path d="M16 9l-8 8" /></svg>
  );
  const closeAllIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5" /><path d="M14 11v5" /></svg>
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
      <div data-tauri-drag-region style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", opacity: 0.85, pointerEvents: "none" }}>DeerHux</div>
      <button
        data-tauri-drag-region="false"
        onClick={() => setSidebarMode((mode) => mode === "open" ? "closed" : "open")}
        title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
        aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
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
        {!sidebarOpen ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        )}
      </button>
      {/* Log panel button */}
      <button
        data-tauri-drag-region="false"
        onClick={(e) => { e.stopPropagation(); setLogPanelOpen((v) => { const next = !v; if (next) { setRightPanelOpen(true); setActiveFileTabId("__log__"); } else { if (fileTabs.length === 0) setRightPanelOpen(false); setActiveFileTabId(fileTabs.length > 0 ? fileTabs[fileTabs.length - 1].id : null); } return next; }); }}
        title={logPanelOpen ? "隐藏 AI Log" : "显示 AI Log"}
        aria-label={logPanelOpen ? "隐藏 AI Log" : "显示 AI Log"}
        aria-pressed={logPanelOpen}
        style={{
          position: "absolute",
          right: isWindowsPlatform ? 186 : 96,
          top: 2,
          width: 24,
          height: 24,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: logPanelOpen ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent",
          border: "1px solid transparent",
          borderRadius: 7,
          color: logPanelOpen ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer",
          transition: "color 0.12s, background 0.12s, border-color 0.12s",
          WebkitAppRegion: "no-drag",
        } as DraggableStyle}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = logPanelOpen ? "var(--accent)" : "var(--text-muted)"; e.currentTarget.style.background = logPanelOpen ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
      {/* Settings button */}
      <button
        data-tauri-drag-region="false"
        onClick={(e) => { e.stopPropagation(); setSettingsMenuOpen((v) => !v); }}
        title="设置"
        aria-label="设置"
        aria-haspopup="menu"
        aria-expanded={settingsMenuOpen}
        style={{
          position: "absolute",
          right: isWindowsPlatform ? 158 : 68,
          top: 2,
          width: 24,
          height: 24,
          padding: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: settingsMenuOpen ? "var(--bg-hover)" : "transparent",
          border: "1px solid transparent",
          borderRadius: 7,
          color: settingsMenuOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          transition: "color 0.12s, background 0.12s, border-color 0.12s",
          WebkitAppRegion: "no-drag",
        } as DraggableStyle}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = settingsMenuOpen ? "var(--text)" : "var(--text-muted)"; e.currentTarget.style.background = settingsMenuOpen ? "var(--bg-hover)" : "transparent"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {/* Settings dropdown */}
      {settingsMenuOpen && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: 30,
            right: isWindowsPlatform ? 154 : 64,
            width: 180,
            maxHeight: 360,
            overflowY: "auto",
            padding: 6,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 14px 36px rgba(0,0,0,0.18)",
            zIndex: 910,
            WebkitAppRegion: "no-drag",
          } as DraggableStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {([
            {
              label: "模型配置",
              onClick: () => { setSettingsMenuOpen(false); setModelsConfigOpen(true); },
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
              label: "扩展总览",
              disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
              onClick: () => { setSettingsMenuOpen(false); setExtensionsConfigOpen(true); },
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v6" /><path d="M12 16v6" /><path d="M4.93 4.93l4.24 4.24" /><path d="M14.83 14.83l4.24 4.24" />
                  <path d="M2 12h6" /><path d="M16 12h6" /><path d="M4.93 19.07l4.24-4.24" /><path d="M14.83 9.17l4.24-4.24" />
                </svg>
              ),
            },
            {
              label: "技能配置",
              disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
              onClick: () => { setSettingsMenuOpen(false); setSkillsConfigOpen(true); },
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              ),
            },
            {
              label: "定时任务",
              onClick: () => { setSettingsMenuOpen(false); setSchedulerPanelOpen(true); },
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              ),
            },
            {
              label: "角色",
              onClick: () => { setSettingsMenuOpen(false); setQuickConfigOpen("role"); },
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21a8 8 0 0 1 16 0" />
                </svg>
              ),
            },
            {
              label: "记忆",
              onClick: () => { setSettingsMenuOpen(false); setQuickConfigOpen("memory"); },
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v16H6.5A2.5 2.5 0 0 1 4 17.5z" />
                  <path d="M8 8h8" />
                  <path d="M8 12h6" />
                  <path d="M8 16h7" />
                </svg>
              ),
            },
            {
              label: "MCP",
              onClick: () => { setSettingsMenuOpen(false); setQuickConfigOpen("mcp"); },
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="8.5" y="14" width="7" height="7" rx="1.5" />
                  <path d="M10 6.5h4" />
                  <path d="M17.5 10v2a2 2 0 0 1-2 2H12" />
                  <path d="M6.5 10v2a2 2 0 0 0 2 2H12" />
                </svg>
              ),
            },
            {
              label: "微信 Bot",
              onClick: () => { setSettingsMenuOpen(false); setWechatConfigOpen(true); },
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              ),
            },
          ] as { label: string; onClick: () => void; disabled?: boolean; icon: React.ReactNode }[]).map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={item.onClick}
              disabled={item.disabled}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 9px",
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: item.disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: item.disabled ? "default" : "pointer",
                textAlign: "left",
                fontSize: 12,
                opacity: item.disabled ? 0.4 : 1,
              }}
              onMouseEnter={(e) => { if (!item.disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = item.disabled ? "var(--text-dim)" : "var(--text-muted)"; }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
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
          right: isWindowsPlatform ? 126 : 40,
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
          right: isWindowsPlatform ? 96 : 10,
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
      {/* Window control buttons — Windows only */}
      {isWindowsPlatform && (
        <>
          <button
            data-tauri-drag-region="false"
            onClick={() => handleWindowAction('minimize')}
            title="最小化"
            aria-label="最小化"
            style={{
              position: "absolute",
              right: 64,
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            data-tauri-drag-region="false"
            onClick={() => handleWindowAction('maximize')}
            title="最大化"
            aria-label="最大化"
            style={{
              position: "absolute",
              right: 36,
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
          <button
            data-tauri-drag-region="false"
            onClick={() => handleWindowAction('close')}
            title="关闭"
            aria-label="关闭"
            style={{
              position: "absolute",
              right: 8,
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
            onMouseEnter={(e) => { e.currentTarget.style.color = "#fff"; e.currentTarget.style.background = "#e81123"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </>
      )}
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
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}`}
        style={{
          width: sidebarOpen ? sidebarWidth : 0,
          minWidth: sidebarOpen ? SIDEBAR_MIN : 0,
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
          onPointerDown={handleResizeStart}
          style={{
            width: 5,
            cursor: "col-resize",
            touchAction: "none",
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSessionTabContextMenu({ sessionId: tab.id, x: e.clientX, y: e.clientY });
                    }}
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
                DeerHux
              </div>
            </div>
          )}
          {!showWatermark && effectiveProjectCwd && canSwitchHeaderProject && (
            <div
              style={{ position: "absolute", top: 18, left: 24, zIndex: 3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  if (canSwitchHeaderProject) {
                    setProjectPickerOpen((open) => !open);
                    return;
                  }
                  if (sidebarMode === "closed") setSidebarMode("open");
                }}
                title={canSwitchHeaderProject ? "切换项目" : effectiveProjectCwd}
                aria-label="当前项目"
                aria-haspopup={canSwitchHeaderProject ? "menu" : undefined}
                aria-expanded={canSwitchHeaderProject ? projectPickerOpen : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  maxWidth: "min(260px, calc(100vw - 48px))",
                  padding: "4px 8px",
                  border: "none",
                  borderRadius: 8,
                  background: projectPickerOpen ? "var(--bg-hover)" : "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: 16,
                  fontWeight: 700,
                  fontFamily: "inherit",
                  lineHeight: 1.25,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = projectPickerOpen ? "var(--bg-hover)" : "transparent"; }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {headerProjectOptions.find((project) => project.cwd === effectiveProjectCwd)?.displayName ?? getProjectName(effectiveProjectCwd)}
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-muted)", transform: projectPickerOpen ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {canSwitchHeaderProject && projectPickerOpen && (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: 34,
                    left: 0,
                    width: 260,
                    maxWidth: "calc(100vw - 48px)",
                    maxHeight: 320,
                    overflowY: "auto",
                    padding: 6,
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    boxShadow: "0 14px 36px rgba(0,0,0,0.18)",
                  }}
                >
                  {headerProjectOptions.map((project) => {
                    const active = project.cwd === effectiveProjectCwd;
                    return (
                      <button
                        key={project.cwd}
                        role="menuitem"
                        onClick={() => handleHeaderProjectSelect(project.cwd)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "8px 9px",
                          border: "none",
                          borderRadius: 8,
                          background: active ? "var(--bg-selected)" : "transparent",
                          color: active ? "var(--text)" : "var(--text-muted)",
                          cursor: active ? "default" : "pointer",
                          textAlign: "left",
                          fontSize: 12,
                        }}
                        title={project.cwd}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                      >
                        <span style={{ width: 7, height: 7, borderRadius: 999, background: active ? "var(--accent)" : "var(--border)", flexShrink: 0 }} />
                        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {project.displayName}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
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
                activeTabId={activeSessionTabId}
                session={selectedSession}
                newSessionCwd={effectiveNewSessionCwd}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleSessionCreated}
                onSessionStarted={handleSessionStarted}
                onAgentRunningChange={setSessionRunning}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onSessionStatsChange={handleSessionStatsChange}
                onContextUsageChange={handleContextUsageChange}
                onOpenFile={handleOpenFile}
                onOpenRoleConfig={() => setQuickConfigOpen("role")}
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
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>点击底部的 “模型配置” 图标配置模型
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {/* Right panel resize handle */}
      {rightPanelOpen && (
        <div
          onPointerDown={handleRightPanelResizeStart}
          style={{
            width: 5,
            cursor: "col-resize",
            touchAction: "none",
            flexShrink: 0,
            background: isResizingRightPanel ? "var(--accent)" : "transparent",
            transition: isResizingRightPanel ? "none" : "background 0.15s",
            zIndex: 201,
            marginLeft: -2,
            marginRight: -2,
          }}
          onMouseEnter={(e) => { if (!isResizingRightPanel) e.currentTarget.style.background = "var(--border)"; }}
          onMouseLeave={(e) => { if (!isResizingRightPanel) e.currentTarget.style.background = "transparent"; }}
        />
      )}

      {/* Right panel: file viewer — width via inline style, CSS class for mobile */}
      <div
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          width: rightPanelOpen ? rightPanelWidth : 0,
          minWidth: rightPanelOpen ? RIGHT_PANEL_MIN : 0,
          transition: isResizingRightPanel ? "none" : undefined,
        }}
      >
        {/* Tabs: log tab + file tabs */}
        {(logPanelOpen || fileTabs.length > 0) && (
          <TabBar
            tabs={[
              ...(logPanelOpen ? [{ id: "__log__" as string, label: "AI Log", filePath: "__log__" }] : []),
              ...fileTabs,
            ]}
            activeTabId={activeFileTabId ?? (logPanelOpen ? "__log__" : "")}
            onSelectTab={handleSelectFileTab}
            onCloseTab={handleCloseFileTab}
            onCloseTabs={handleCloseFileTabs}
            cwd={effectiveProjectCwd ?? undefined}
          />
        )}
        {/* Content: log panel or file viewer */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {activeFileTabId === "__log__" ? (
            <LogPanel />
          ) : activeFileTab?.filePath ? (
            <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              未打开任何文件
            </div>
          )}
        </div>
      </div>
    </div>
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} onSaved={() => setModelsRefreshKey((k) => k + 1)} />}
    {skillsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <SkillsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {extensionsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <ExtensionsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setExtensionsConfigOpen(false)} />
    )}
    {schedulerPanelOpen && (
      <SchedulerPanel onClose={() => setSchedulerPanelOpen(false)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} />
    )}
    {quickConfigOpen === "role" && <RoleConfig onClose={() => setQuickConfigOpen(null)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} projects={projectOptions} />}
    {quickConfigOpen === "memory" && <MemoryConfig onClose={() => setQuickConfigOpen(null)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} />}
    {quickConfigOpen === "mcp" && <McpConfig onClose={() => setQuickConfigOpen(null)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} />}
    {wechatConfigOpen && <WeChatConfig onClose={() => setWechatConfigOpen(false)} />}
    {sessionTabContextMenu && sessionContextTab && (
      <div
        style={{
          position: "fixed",
          left: sessionTabContextMenu.x,
          top: sessionTabContextMenu.y,
          zIndex: 1000,
          width: 200,
          padding: 6,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          style={{
            padding: "5px 8px 7px",
            color: "var(--text-dim)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={sessionContextTab.name || sessionContextTab.firstMessage || sessionContextTab.id}
        >
          {sessionContextTab.name || sessionContextTab.firstMessage?.slice(0, 40) || sessionContextTab.id.slice(0, 8)}
        </div>
        {renderSessionContextMenuButton("关闭此页", false, () => { handleCloseSessionTabs([sessionContextTab.id]); setSessionTabContextMenu(null); }, closeIcon)}
        {renderSessionContextMenuButton("关闭右侧标签", sessionRightTabIds.length === 0, () => { handleCloseSessionTabs(sessionRightTabIds); setSessionTabContextMenu(null); }, closeRightIcon)}
        {renderSessionContextMenuButton("关闭其他页签", sessionOtherTabIds.length === 0, () => { handleCloseSessionTabs(sessionOtherTabIds); setSessionTabContextMenu(null); }, closeOthersIcon)}
        {renderSessionContextMenuButton("关闭全部页签", sessionAllTabIds.length === 0, () => { handleCloseSessionTabs(sessionAllTabIds); setSessionTabContextMenu(null); }, closeAllIcon)}
      </div>
    )}
    </>
  );
}
