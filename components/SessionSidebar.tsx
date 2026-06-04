"use client";

import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, useCallback, useRef, useMemo, type CSSProperties } from "react";
import type { SessionInfo } from "@/lib/types";
import { FileExplorer } from "./FileExplorer";

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

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  optimisticSession?: SessionInfo | null;
  runningSessionStatuses?: Map<string, RunningSessionStatus>;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  compact?: boolean;
  onProjectsChange?: (projects: { cwd: string; displayName: string }[]) => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  return date.toLocaleDateString();
}

function formatSecondsFromMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "--";
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

function formatRunningStatus(status: RunningSessionStatus): string {
  const eventName = status.isCompacting ? "compacting" : status.lastEventType || "running";
  const rate = Number.isFinite(status.eventRate) ? status.eventRate : 0;
  return `${eventName} · ${rate.toFixed(1)}/s · 事件 ${formatSecondsFromMs(status.eventIdleMs)} · 内容 ${formatSecondsFromMs(status.contentIdleMs)}`;
}

interface ProjectGroup {
  cwd: string;
  sessions: SessionInfo[];
  latestModified: string;
  displayName?: string;
  note?: string;
  pinned?: boolean;
}

const PROJECT_META_STORAGE_KEY = "pi-agent.project-meta";
const CUSTOM_CWDS_STORAGE_KEY = "pi-agent.custom-cwds";

interface ProjectMeta {
  hiddenCwds: string[];
  pinnedCwds: string[];
  notes: Record<string, string>;
  defaultPinInitializedCwds: string[];
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as unknown;
    return parsed && typeof parsed === "object" ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function readCustomCwds(): string[] {
  const value = readJson<unknown[]>(CUSTOM_CWDS_STORAGE_KEY, []);
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function writeCustomCwds(cwds: string[]) {
  writeJson(CUSTOM_CWDS_STORAGE_KEY, [...new Set(cwds)]);
}

function readProjectMeta(): ProjectMeta {
  const meta = readJson<Partial<ProjectMeta>>(PROJECT_META_STORAGE_KEY, {});
  return {
    hiddenCwds: Array.isArray(meta.hiddenCwds) ? meta.hiddenCwds.filter((v): v is string => typeof v === "string") : [],
    pinnedCwds: Array.isArray(meta.pinnedCwds) ? meta.pinnedCwds.filter((v): v is string => typeof v === "string") : [],
    notes: meta.notes && typeof meta.notes === "object" ? meta.notes as Record<string, string> : {},
    defaultPinInitializedCwds: Array.isArray(meta.defaultPinInitializedCwds) ? meta.defaultPinInitializedCwds.filter((v): v is string => typeof v === "string") : [],
  };
}

function writeProjectMeta(meta: ProjectMeta) {
  writeJson(PROJECT_META_STORAGE_KEY, meta);
}

/** Group projects by cwd and sort by their newest message/session activity. */
function buildProjectGroups(sessions: SessionInfo[]): ProjectGroup[] {
  const byCwd = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const list = byCwd.get(s.cwd) ?? [];
    list.push(s);
    byCwd.set(s.cwd, list);
  }

  return [...byCwd.entries()]
    .map(([cwd, list]) => {
      const sorted = [...list].sort((a, b) => b.modified.localeCompare(a.modified));
      return { cwd, sessions: sorted, latestModified: sorted[0]?.modified ?? "" };
    })
    .sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

function getProjectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

function getInitial(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  return Array.from(trimmed)[0]?.toUpperCase() ?? "•";
}


interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiAgentTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Client";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, optimisticSession, runningSessionStatuses = new Map(), onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onAtMention, compact = false, onProjectsChange }: Props) {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [customCwds, setCustomCwds] = useState<string[]>([]);
  const [projectMeta, setProjectMeta] = useState<ProjectMeta>({ hiddenCwds: [], pinnedCwds: [], notes: {}, defaultPinInitializedCwds: [] });
  const [clientReady, setClientReady] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ cwd: string; x: number; y: number } | null>(null);
  const [expandedCwds, setExpandedCwds] = useState<Set<string>>(new Set());
  const [allProjectsState, setAllProjectsState] = useState<"expanded" | "compact" | "collapsed">("expanded");
  const [showAllCwds, setShowAllCwds] = useState<Set<string>>(new Set());
  const autoExpandedRef = useRef(false);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  // Sync client-only localStorage state after mount to avoid hydration mismatch
  useEffect(() => {
    setCustomCwds(readCustomCwds());
    setProjectMeta(readProjectMeta());
    setClientReady(true);
  }, []);

  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const splitterRef = useRef<HTMLDivElement>(null);
  const splitPercentRef = useRef(50);
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const [isHoveringSplitter, setIsHoveringSplitter] = useState(false);
  const [splitPercent, setSplitPercent] = useState(() => {
    if (typeof window === "undefined") return 50;
    try {
      const stored = localStorage.getItem("pi-agent.sidebar-split-percent");
      if (stored) {
        const n = Number(stored);
        if (n >= 10 && n <= 90) return n;
      }
    } catch { /* ignore */ }
    return 50;
  });

  useEffect(() => { splitPercentRef.current = splitPercent; }, [splitPercent]);

  const loadSessions = useCallback(async (showLoading = false) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions", { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[] };
      setAllSessions(data.sessions);
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? "加载会话超时" : String(e));
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startPercent = splitPercentRef.current;
    const sidebarEl = sidebarRef.current;
    const headerEl = headerRef.current;
    if (!sidebarEl) return;
    const sidebarHeight = sidebarEl.offsetHeight;
    const headerHeight = headerEl?.offsetHeight ?? 0;
    const availableHeight = sidebarHeight - headerHeight;
    if (availableHeight <= 0) return;

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    setIsDraggingSplitter(true);

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - startY;
      const deltaPercent = (deltaY / availableHeight) * 100;
      const newPercent = Math.max(10, Math.min(90, startPercent + deltaPercent));
      setSplitPercent(newPercent);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsDraggingSplitter(false);
      try {
        localStorage.setItem("pi-agent.sidebar-split-percent", String(splitPercentRef.current));
      } catch { /* ignore */ }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  const restoredRef = useRef(false);

  useEffect(() => {
    onCwdChange?.(selectedCwd);
  }, [selectedCwd, onCwdChange]);

  const ensureDefaultCwd = useCallback(async () => {
    if (defaultCwd) return defaultCwd;
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setDefaultCwd(data.cwd);
        return data.cwd;
      }
    } catch {
      // ignore
    }
    return null;
  }, [defaultCwd]);

  const handleDefaultCwd = useCallback(async () => {
    const cwd = await ensureDefaultCwd();
    if (cwd) {
      setSelectedCwd(cwd);
      setExpandedCwds((prev) => new Set(prev).add(cwd));
    }
  }, [ensureDefaultCwd]);

  useEffect(() => {
    if (!loading && !defaultCwd) {
      void ensureDefaultCwd();
    }
  }, [loading, defaultCwd, ensureDefaultCwd]);

  const displayedSessions = useMemo(() => {
    if (!optimisticSession) return allSessions;
    const existing = allSessions.find((s) => s.id === optimisticSession.id);
    if (existing) return allSessions;
    return [optimisticSession, ...allSessions];
  }, [allSessions, optimisticSession]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (loading) return;

    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = displayedSessions.find((s) => s.id === initialSessionId);
      if (target) {
        setSelectedCwd(target.cwd);
        onSelectSession(target, true);
        return;
      }
      onInitialRestoreDone?.();
    }

    if (selectedCwd === null) {
      const projects = buildProjectGroups(displayedSessions);
      if (projects.length > 0) {
        setSelectedCwd(projects[0].cwd);
      } else {
        handleDefaultCwd();
      }
    }
  }, [loading, displayedSessions, selectedCwd, initialSessionId, onSelectSession, onInitialRestoreDone, handleDefaultCwd]);

  const handleCustomPath = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择项目目录",
    });

    if (typeof selected === "string") {
      setSelectedCwd(selected);
      setExpandedCwds((prev) => new Set(prev).add(selected));
      setCustomCwds((prev) => {
        const next = [selected, ...prev.filter((cwd) => cwd !== selected)];
        writeCustomCwds(next);
        return next;
      });
    }
  }, []);

  const handleNewSession = useCallback(async () => {
    const recentCwd = buildProjectGroups(displayedSessions)[0]?.cwd;
    const cwd = selectedCwdProp ?? selectedCwd ?? recentCwd ?? await ensureDefaultCwd();
    if (!cwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd);
  }, [selectedCwdProp, selectedCwd, displayedSessions, ensureDefaultCwd, onNewSession]);

  const sessionProjects = useMemo(() => buildProjectGroups(displayedSessions), [displayedSessions]);
  const projects = useMemo(() => {
    const byCwd = new Map<string, ProjectGroup>();
    for (const project of sessionProjects) byCwd.set(project.cwd, project);
    for (const cwd of customCwds) {
      if (!byCwd.has(cwd)) byCwd.set(cwd, { cwd, sessions: [], latestModified: "" });
    }
    if (defaultCwd && !byCwd.has(defaultCwd)) {
      byCwd.set(defaultCwd, { cwd: defaultCwd, sessions: [], latestModified: "" });
    }

    return [...byCwd.values()]
      .filter((project) => project.cwd === defaultCwd || !projectMeta.hiddenCwds.includes(project.cwd))
      .map((project) => ({
        ...project,
        displayName: project.cwd === defaultCwd ? "默认" : project.displayName,
        note: projectMeta.notes[project.cwd]?.trim() || undefined,
        pinned: projectMeta.pinnedCwds.includes(project.cwd),
      }))
      .sort((a, b) => {
        const aIdx = projectMeta.pinnedCwds.indexOf(a.cwd);
        const bIdx = projectMeta.pinnedCwds.indexOf(b.cwd);
        const aPinned = aIdx !== -1;
        const bPinned = bIdx !== -1;
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        if (aPinned) return aIdx - bIdx;
        return b.latestModified.localeCompare(a.latestModified);
      });
  }, [sessionProjects, customCwds, defaultCwd, projectMeta]);
  const activeSelectedCwd = selectedCwdProp ?? selectedCwd;

  useEffect(() => {
    onProjectsChange?.(projects.map((project) => ({
      cwd: project.cwd,
      displayName: project.displayName ?? getProjectName(project.cwd),
    })));
  }, [projects, onProjectsChange]);

  const updateProjectMeta = useCallback((updater: (prev: ProjectMeta) => ProjectMeta) => {
    setProjectMeta((prev) => {
      const next = updater(prev);
      writeProjectMeta(next);
      return next;
    });
  }, []);

  const handleProjectNote = useCallback((cwd: string) => {
    const current = projectMeta.notes[cwd] ?? "";
    const nextNote = window.prompt("项目备注", current);
    if (nextNote === null) return;
    updateProjectMeta((prev) => ({
      ...prev,
      notes: { ...prev.notes, [cwd]: nextNote.trim() },
    }));
  }, [projectMeta.notes, updateProjectMeta]);

  useEffect(() => {
    if (!defaultCwd || projectMeta.defaultPinInitializedCwds.includes(defaultCwd)) return;
    updateProjectMeta((prev) => ({
      ...prev,
      pinnedCwds: prev.pinnedCwds.includes(defaultCwd) ? prev.pinnedCwds : [defaultCwd, ...prev.pinnedCwds],
      defaultPinInitializedCwds: [...prev.defaultPinInitializedCwds, defaultCwd],
    }));
  }, [defaultCwd, projectMeta.defaultPinInitializedCwds, updateProjectMeta]);

  const handleToggleProjectPinned = useCallback((cwd: string) => {
    updateProjectMeta((prev) => {
      const pinned = prev.pinnedCwds.includes(cwd)
        ? prev.pinnedCwds.filter((item) => item !== cwd)
        : [cwd, ...prev.pinnedCwds];
      return { ...prev, pinnedCwds: pinned };
    });
  }, [updateProjectMeta]);

  const handleRemoveProjectReference = useCallback((cwd: string) => {
    if (cwd === defaultCwd) return;
    updateProjectMeta((prev) => ({
      ...prev,
      hiddenCwds: prev.hiddenCwds.includes(cwd) ? prev.hiddenCwds : [...prev.hiddenCwds, cwd],
      pinnedCwds: prev.pinnedCwds.filter((item) => item !== cwd),
    }));
    setCustomCwds((prev) => {
      const next = prev.filter((item) => item !== cwd);
      writeCustomCwds(next);
      return next;
    });
    if ((selectedCwdProp ?? selectedCwd) === cwd) void handleDefaultCwd();
  }, [defaultCwd, selectedCwdProp, selectedCwd, updateProjectMeta, handleDefaultCwd]);

  const handleReselectProjectPath = useCallback(async (cwd: string) => {
    const selected = await open({ directory: true, multiple: false, title: "重新选定项目路径" });
    if (typeof selected !== "string" || selected === cwd) return;
    updateProjectMeta((prev) => {
      const notes = { ...prev.notes };
      if (notes[cwd] && !notes[selected]) notes[selected] = notes[cwd];
      delete notes[cwd];
      return {
        hiddenCwds: prev.hiddenCwds.includes(cwd) ? prev.hiddenCwds : [...prev.hiddenCwds, cwd],
        pinnedCwds: prev.pinnedCwds.includes(cwd)
          ? [selected, ...prev.pinnedCwds.filter((item) => item !== cwd && item !== selected)]
          : prev.pinnedCwds.filter((item) => item !== selected),
        notes,
        defaultPinInitializedCwds: prev.defaultPinInitializedCwds.map((item) => item === cwd ? selected : item),
      };
    });
    setCustomCwds((prev) => {
      const next = [selected, ...prev.filter((item) => item !== cwd && item !== selected)];
      writeCustomCwds(next);
      return next;
    });
    setSelectedCwd(selected);
    setExpandedCwds((prev) => {
      const next = new Set(prev);
      next.delete(cwd);
      next.add(selected);
      return next;
    });
  }, [updateProjectMeta]);

  useEffect(() => {
    if (!projectMenu) return;
    const close = () => setProjectMenu(null);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("click", close);
    };
  }, [projectMenu]);

  useEffect(() => {
    if (!defaultCwd) return;
    setExpandedCwds((prev) => {
      if (prev.has(defaultCwd)) return prev;
      const next = new Set(prev);
      next.add(defaultCwd);
      return next;
    });
  }, [defaultCwd]);

  useEffect(() => {
    if (loading || projects.length === 0 || autoExpandedRef.current) return;
    autoExpandedRef.current = true;
    setExpandedCwds((prev) => new Set([...prev, ...projects.slice(0, 3).map((p) => p.cwd)]));
  }, [loading, projects]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const session = displayedSessions.find((s) => s.id === selectedSessionId);
    if (!session?.cwd) return;
    setExpandedCwds((prev) => {
      if (prev.has(session.cwd)) return prev;
      const next = new Set(prev);
      next.add(session.cwd);
      return next;
    });
  }, [selectedSessionId, displayedSessions]);

  const toggleProject = useCallback((cwd: string) => {
    setExpandedCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  const toggleShowAll = useCallback((cwd: string) => {
    setShowAllCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  return (
    <div ref={sidebarRef} style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        ref={headerRef}
        style={{
          padding: compact ? "8px 6px" : "12px 10px 8px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: compact ? "center" : "space-between", marginBottom: compact ? 0 : 6 }}>
          {!compact && <PiAgentTitle />}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleNewSession}
              disabled={false}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: compact ? "var(--bg-hover)" : "transparent",
                border: compact ? "1px solid var(--border)" : "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                height: compact ? 34 : 32,
                width: compact ? 34 : undefined,
                paddingLeft: compact ? 0 : 10,
                paddingRight: compact ? 0 : 12,
                borderRadius: compact ? 999 : 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s",
              }}
              title={activeSelectedCwd ? `在 ${activeSelectedCwd} 中新建会话` : "新建会话（将使用最近项目或默认项目）"}
              aria-label="新建会话"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = compact ? "var(--bg-hover)" : "transparent";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              {!compact && "新建"}
            </button>

          </div>
        </div>

      </div>

      {/* 全部项目 — collapse entire project list */}
      {projects.length > 0 && (
        <div
          onClick={() => setAllProjectsState((prev) => prev === "expanded" ? "compact" : prev === "compact" ? "collapsed" : "expanded")}
          style={{
            padding: compact ? "5px 0" : "2px 14px 4px",
            fontSize: 12,
            color: "var(--text-muted)",
            cursor: "pointer",
            userSelect: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: compact ? "center" : undefined,
            gap: compact ? 0 : 6,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          title={compact ? (allProjectsState === "expanded" ? "收起" : allProjectsState === "compact" ? "折叠" : "展开全部") : undefined}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {allProjectsState === "expanded" ? (
              <polyline points="6 9 12 15 18 9" />
            ) : allProjectsState === "compact" ? (
              <><line x1="8" y1="12" x2="16" y2="12" /></>
            ) : (
              <polyline points="18 15 12 9 6 15" />
            )}
          </svg>
          {!compact && "全部项目"}
        </div>
      )}

      {/* Project/session list */}
      <div style={{ flex: compact ? "1 1 auto" : explorerOpen && activeSelectedCwd ? `${splitPercent} 1 0` : "1 1 auto", overflowY: "auto", padding: compact ? "6px 0" : "0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: compact ? "8px 0" : "16px 14px", color: "var(--text-muted)", fontSize: 12, textAlign: compact ? "center" : undefined }}>
            {compact ? "…" : "加载中..."}
          </div>
        )}
        {error && (
          <div style={{ padding: compact ? "8px 4px" : "12px 14px", color: "#f87171", fontSize: 12, textAlign: compact ? "center" : undefined }}>
            {compact ? "!" : error}
          </div>
        )}
        {!loading && !error && projects.length === 0 && (
          <div style={{ padding: compact ? "8px 4px" : "16px 14px", color: "var(--text-muted)", fontSize: 12, textAlign: compact ? "center" : undefined }}>
            {compact ? "—" : "未找到任何会话"}
          </div>
        )}
        {!loading && !error && (
          <>
            {allProjectsState !== "collapsed" && (allProjectsState === "compact" ? projects.slice(0, 2) : projects).map((project, i) => (
          <ProjectSection
            key={project.cwd}
            project={project}
            expanded={expandedCwds.has(project.cwd)}
            showAll={showAllCwds.has(project.cwd)}
            selectedSessionId={selectedSessionId}
            runningSessionStatuses={runningSessionStatuses}
            onToggle={() => toggleProject(project.cwd)}
            onToggleShowAll={() => toggleShowAll(project.cwd)}
            onSelectSession={onSelectSession}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id);
              loadSessions();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setProjectMenu({ cwd: project.cwd, x: event.clientX, y: event.clientY });
            }}
            compact={compact}
            isActiveProject={project.cwd === activeSelectedCwd}
            maxSessions={allProjectsState === "compact" ? 2 : undefined}
          />
        ))}
          </>
        )}
        <div style={{ padding: compact ? "6px 0" : "4px 14px 6px", display: "flex", justifyContent: "center" }}>
          <button
            onClick={handleCustomPath}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: compact ? "center" : undefined,
              gap: compact ? 0 : 4,
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              padding: compact ? 0 : "3px 6px",
              width: compact ? 30 : undefined,
              height: compact ? 30 : undefined,
              borderRadius: 5,
              transition: "color 0.15s, background 0.15s",
            }}
            title="添加自定义路径"
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
            {!compact && <span>添加项目</span>}
          </button>
        </div>
      </div>

      {projectMenu && (() => {
        const project = projects.find((p) => p.cwd === projectMenu.cwd);
        if (!project) return null;
        const isDefault = project.cwd === defaultCwd;
        const pinned = projectMeta.pinnedCwds.includes(project.cwd);
        const itemStyle: CSSProperties = {
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
        return (
          <div
            style={{
              position: "fixed",
              left: projectMenu.x,
              top: projectMenu.y,
              zIndex: 1000,
              width: 178,
              padding: 6,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div style={{ padding: "5px 8px 7px", color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={project.cwd}>
              {project.displayName ?? getProjectName(project.cwd)}
            </div>
            <button style={itemStyle} onClick={() => { setProjectMenu(null); void handleReselectProjectPath(project.cwd); }}>
              重新选定路径
            </button>
            <button style={itemStyle} onClick={() => { setProjectMenu(null); handleProjectNote(project.cwd); }}>
              备注
            </button>
            <button
              style={itemStyle}
              onClick={() => { setProjectMenu(null); handleToggleProjectPinned(project.cwd); }}
            >
              {pinned ? "取消置顶" : "置顶"}
            </button>
            <div style={{ height: 1, background: "var(--border)", margin: "5px 4px" }} />
            <button
              style={{ ...itemStyle, color: isDefault ? "var(--text-dim)" : "#ef4444", cursor: isDefault ? "default" : "pointer", opacity: isDefault ? 0.45 : 1 }}
              disabled={isDefault}
              onClick={() => { setProjectMenu(null); handleRemoveProjectReference(project.cwd); }}
            >
              删除项目引入
            </button>
          </div>
        );
      })()}

      {/* Draggable splitter handle */}
      {explorerOpen && !compact && (selectedCwdProp || selectedCwd) && (
        <div
          ref={splitterRef}
          onMouseDown={handleSplitterMouseDown}
          style={{
            height: 6,
            flexShrink: 0,
            cursor: 'row-resize',
            borderTop: `1px solid ${isDraggingSplitter || isHoveringSplitter ? 'var(--text-muted)' : 'transparent'}`,
            background: 'var(--bg-subtle)',
            transition: isDraggingSplitter ? 'none' : 'border-color 0.15s',
          }}
          onMouseEnter={() => setIsHoveringSplitter(true)}
          onMouseLeave={() => setIsHoveringSplitter(false)}
        />
      )}

      {/* File Explorer section */}
      {!compact && (selectedCwdProp || selectedCwd) && (
        <div
          style={{
            background: "var(--bg-subtle)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? `${100 - splitPercent} 1 0` : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0, paddingTop: 2 }}>
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              资源管理器
            </button>
            <button
              onClick={() => {
                setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title="刷新资源管理器"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, padding: 0, marginRight: 6,
                background: explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none",
                border: "none",
                color: explorerRefreshDone ? "#4ade80" : "var(--text-dim)",
                cursor: "pointer",
                borderRadius: 5,
                flexShrink: 0,
                transition: "color 0.3s, background 0.3s",
              }}
              onMouseEnter={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                cwd={selectedCwdProp ?? selectedCwd!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function ProjectSection({
  project,
  expanded,
  showAll,
  selectedSessionId,
  runningSessionStatuses,
  onToggle,
  onToggleShowAll,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onContextMenu,
  compact = false,
  isActiveProject = false,
  maxSessions,
}: {
  project: ProjectGroup;
  expanded: boolean;
  showAll: boolean;
  selectedSessionId: string | null;
  runningSessionStatuses: Map<string, RunningSessionStatus>;
  onToggle: () => void;
  onToggleShowAll: () => void;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  compact?: boolean;
  isActiveProject?: boolean;
  maxSessions?: number;
}) {
  const selectedInProject = selectedSessionId ? project.sessions.find((s) => s.id === selectedSessionId) : undefined;
  const limit = maxSessions ?? (showAll ? project.sessions.length : 2);
  let visibleSessions = project.sessions.slice(0, limit);
  if (selectedInProject && !visibleSessions.some((s) => s.id === selectedInProject.id)) {
    visibleSessions = [...visibleSessions, selectedInProject];
  }
  const hiddenSessionCount = maxSessions !== undefined ? Math.max(0, project.sessions.length - maxSessions) : Math.max(0, project.sessions.length - (showAll ? project.sessions.length : 2));
  const sessionTree = buildSessionTree(project.sessions);
  const projectTitle = project.displayName ?? getProjectName(project.cwd);
  const projectInitial = getInitial(projectTitle);

  return (
    <div
      style={{ borderBottom: "none", marginBottom: 2 }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
      onMouseDown={(event) => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
    >
      <button
        onClick={() => {
          if (compact && project.sessions.length > 0) {
            onSelectSession(project.sessions[0]);
          } else {
            onToggle();
          }
        }}
        style={{
          margin: compact ? "3px 6px" : undefined,
          borderRadius: compact ? 999 : 0,
          width: compact ? "calc(100% - 12px)" : "100%",
          display: "flex",
          alignItems: "center",
          height: compact ? 30 : undefined,
          justifyContent: compact ? "center" : undefined,
          gap: compact ? 0 : 7,
          padding: compact ? "0" : "5px 10px",
          background: compact
            ? (isActiveProject ? "var(--bg-selected)" : "transparent")
            : "var(--bg-subtle)",
          border: "none",
          color: "var(--text)",
          cursor: "pointer",
          textAlign: "left",
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = compact ? (isActiveProject ? "var(--bg-selected)" : "transparent") : "var(--bg-subtle)"; }}
        title={project.cwd}
      >
        {compact ? (
          <span
            aria-hidden="true"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: selectedInProject || isActiveProject ? "var(--accent)" : project.pinned ? "var(--text-muted)" : "var(--bg)",
              color: selectedInProject || isActiveProject || project.pinned ? "#fff" : "var(--text)",
              border: selectedInProject || isActiveProject ? "1px solid var(--accent)" : "1px solid var(--border)",
              boxShadow: selectedInProject || isActiveProject ? "0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
              flexShrink: 0,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              lineHeight: 1,
            }}
          >
            {projectInitial}
          </span>
        ) : (
          <>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0, color: "var(--text-dim)" }}>
              <polyline points="3 2 7 5 3 8" />
            </svg>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: project.pinned ? "var(--text-dim)" : "transparent", flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {projectTitle}{project.note ? ` · ${project.note}` : ""}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap", flexShrink: 0 }}>
                {project.sessions.length} 个对话{project.latestModified ? ` · ${formatRelativeTime(project.latestModified)}` : ""}
              </span>
            </div>
          </>
        )}
      </button>

      {(compact || expanded) && (
        <div>
          {showAll && !compact && maxSessions === undefined ? sessionTree.map((node) => (
            <SessionTreeItem key={node.session.id} node={node} selectedSessionId={selectedSessionId} runningSessionStatuses={runningSessionStatuses} onSelectSession={onSelectSession} onRenamed={onRenamed} onSessionDeleted={onSessionDeleted} depth={0} compact={compact} />
          )) : visibleSessions.map((session) => (
            <SessionItem key={session.id} session={session} isSelected={session.id === selectedSessionId} runningStatus={runningSessionStatuses.get(session.id)} onClick={() => onSelectSession(session)} onRenamed={onRenamed} onDeleted={(id) => onSessionDeleted?.(id)} depth={0} compact={compact} />
          ))}
          {project.sessions.length > 2 && !compact && maxSessions === undefined && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleShowAll(); }}
              style={{
                width: "100%",
                padding: "4px 14px 6px 32px",
                background: "none",
                border: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 10,
                textAlign: "left",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {showAll ? "收起" : `更多 ${hiddenSessionCount} 条`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionStatuses,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  compact = false,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionStatuses: Map<string, RunningSessionStatus>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  compact?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {depth > 0 && !compact && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          runningStatus={runningSessionStatuses.get(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          compact={compact}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionStatuses={runningSessionStatuses}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  runningStatus,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  compact = false,
}: {
  session: SessionInfo;
  isSelected: boolean;
  runningStatus?: RunningSessionStatus;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  compact?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
  const sessionInitial = getInitial(title);
  const isRunning = Boolean(runningStatus?.isStreaming || runningStatus?.isCompacting);
  const runningText = runningStatus ? formatRunningStatus(runningStatus) : null;

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = compact ? 28 : 54;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: compact ? "center" : undefined,
        paddingLeft: compact ? 0 : depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: compact ? 0 : 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: compact ? "none" : confirmDelete
          ? "2px solid #ef4444"
          : isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        borderRadius: compact ? 8 : 0,
        margin: compact ? "2px 6px" : 0,
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            确定删除会话 <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span> 吗？
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              删除
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              取消
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {compact && (
            <span
              aria-hidden="true"
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isSelected ? "transparent" : "transparent",
                color: isSelected ? "var(--accent)" : "var(--text-muted)",
                border: isSelected ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                boxShadow: isSelected ? "0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                lineHeight: 1,
                position: "relative",
              }}
            >
              {sessionInitial}
              {isRunning && <span className="session-running-dot" style={{ position: "absolute", right: -3, bottom: -3, width: 9, height: 9, borderWidth: 2 }} />}
            </span>
          )}
          {!compact && (
            <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && !compact && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text)",
              }}
              title={title}
            >
              {title}
            </div>
            <div style={{ marginTop: 2, display: "flex", gap: 8, color: isRunning ? "var(--accent)" : "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
              {runningText ? (
                <span title={runningText} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{runningText}</span>
              ) : (
                <>
                  <span title={session.modified}>{formatRelativeTime(session.modified)}</span>
                  <span>{session.messageCount} 条消息</span>
                </>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? "展开分支" : "收起分支"}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Running indicator */}
          {isRunning && (
            <span
              aria-label="会话正在运行"
              title="会话正在运行"
              className="session-running-dot"
              style={{ flexShrink: 0 }}
            />
          )}

          {/* Action buttons — shown on hover */}
          {hovered && !compact && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title="重命名"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title="删除"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
            </>
          )}
        </>
      )}
    </div>
  );
}
