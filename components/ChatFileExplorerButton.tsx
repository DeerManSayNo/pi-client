"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getLocalStorageItem } from "@/lib/client-storage";
import { FileExplorer } from "./FileExplorer";

interface Props {
  cwd: string | null;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  refreshKey?: number;
}

interface ExplorerProjectState {
  expandedPaths: string[];
  activePath: string | null;
}

const FILE_EXPLORER_STATE_STORAGE_KEY = "deerhux.file-explorer-state";
const EMPTY_EXPLORER_PROJECT_STATE: ExplorerProjectState = { expandedPaths: [], activePath: null };

function sanitizeExplorerProjectState(value: unknown): ExplorerProjectState {
  if (!value || typeof value !== "object") return EMPTY_EXPLORER_PROJECT_STATE;
  const state = value as Partial<ExplorerProjectState>;
  return {
    expandedPaths: Array.isArray(state.expandedPaths)
      ? [...new Set(state.expandedPaths.filter((path): path is string => typeof path === "string" && path.length > 0))]
      : [],
    activePath: typeof state.activePath === "string" && state.activePath.length > 0 ? state.activePath : null,
  };
}

function areExplorerProjectStatesEqual(a: ExplorerProjectState, b: ExplorerProjectState): boolean {
  if (a.activePath !== b.activePath || a.expandedPaths.length !== b.expandedPaths.length) return false;
  return a.expandedPaths.every((path, index) => path === b.expandedPaths[index]);
}

function readFileExplorerState(cwd: string): ExplorerProjectState {
  if (typeof window === "undefined") return EMPTY_EXPLORER_PROJECT_STATE;
  try {
    const parsedValue = JSON.parse(getLocalStorageItem(FILE_EXPLORER_STATE_STORAGE_KEY) ?? "{}") as unknown;
    const parsed = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, unknown>
      : {};
    return sanitizeExplorerProjectState(parsed[cwd]);
  } catch {
    return EMPTY_EXPLORER_PROJECT_STATE;
  }
}

function writeFileExplorerState(cwd: string, state: ExplorerProjectState) {
  if (typeof window === "undefined") return;
  try {
    const parsedValue = JSON.parse(getLocalStorageItem(FILE_EXPLORER_STATE_STORAGE_KEY) ?? "{}") as unknown;
    const parsed = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, unknown>
      : {};
    parsed[cwd] = { ...state, updatedAt: Date.now() };
    window.localStorage.setItem(FILE_EXPLORER_STATE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore quota / private mode errors
  }
}

export function ChatFileExplorerButton({ cwd, onOpenFile, onAtMention, refreshKey }: Props) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [refreshDone, setRefreshDone] = useState(false);
  const [explorerState, setExplorerState] = useState<ExplorerProjectState>(EMPTY_EXPLORER_PROJECT_STATE);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (refreshKey !== undefined) setLocalRefreshKey((key) => key + 1);
  }, [refreshKey]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!cwd) {
      setExplorerState(EMPTY_EXPLORER_PROJECT_STATE);
      return;
    }
    setExplorerState(readFileExplorerState(cwd));
  }, [cwd]);

  const handleRefresh = useCallback(() => {
    setLocalRefreshKey((key) => key + 1);
    setRefreshDone(true);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setRefreshDone(false), 1600);
  }, []);

  const handleOpen = useCallback(() => {
    setHasOpened(true);
    setOpen(true);
  }, []);

  const handleExplorerStateChange = useCallback((state: ExplorerProjectState) => {
    if (!cwd) return;
    const next = sanitizeExplorerProjectState(state);
    setExplorerState((prev) => areExplorerProjectStatesEqual(prev, next) ? prev : next);
    writeFileExplorerState(cwd, next);
  }, [cwd]);

  if (!cwd) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 16,
        bottom: 16,
        zIndex: 42,
        display: "flex",
        alignItems: "flex-end",
      }}
      onMouseEnter={handleOpen}
      onMouseLeave={() => setOpen(false)}
      onFocus={handleOpen}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        title="资源管理器"
        aria-label="资源管理器"
        aria-expanded={open}
        style={{
          width: 36,
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: "50%",
          border: "none",
          background: "none",
          color: open ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          opacity: 1,
          transition: "background 0.12s, color 0.12s, opacity 0.12s, transform 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = "none";
          event.currentTarget.style.color = "var(--text)";
          event.currentTarget.style.opacity = "1";
          event.currentTarget.style.transform = "translateY(-1px)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = "none";
          event.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
          event.currentTarget.style.opacity = "1";
          event.currentTarget.style.transform = "none";
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </button>

      {hasOpened && (
        <div
          style={{
            position: "absolute",
            left: 0,
            bottom: 36,
            width: "min(420px, calc(100vw - 48px))",
            maxHeight: "min(62vh, 620px)",
            display: open ? "flex" : "none",
            flexDirection: "column",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--bg-panel)",
            boxShadow: "0 18px 48px rgba(15,23,42,0.18)",
          }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 34,
              padding: "4px 6px 4px 10px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-subtle)",
              flexShrink: 0,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                资源管理器
              </div>
              <div title={cwd} style={{ marginTop: 1, fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {cwd}
              </div>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              title="刷新资源管理器"
              aria-label="刷新资源管理器"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                padding: 0,
                border: "none",
                borderRadius: 7,
                background: refreshDone ? "rgba(74,222,128,0.18)" : "transparent",
                color: refreshDone ? "#4ade80" : "var(--text-dim)",
                cursor: "pointer",
                flexShrink: 0,
                transition: "color 0.2s, background 0.2s",
              }}
              onMouseEnter={(event) => {
                if (refreshDone) return;
                event.currentTarget.style.color = "var(--text-muted)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                if (refreshDone) return;
                event.currentTarget.style.color = "var(--text-dim)";
                event.currentTarget.style.background = "transparent";
              }}
            >
              {refreshDone ? (
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
          <div style={{ flex: 1, minHeight: 160, overflowY: "auto", overflowX: "hidden", padding: "4px 2px" }}>
            <FileExplorer
              cwd={cwd}
              onOpenFile={onOpenFile ?? (() => {})}
              onAtMention={onAtMention}
              refreshKey={localRefreshKey}
              initialExpandedPaths={explorerState.expandedPaths}
              activePath={explorerState.activePath}
              onExplorerStateChange={handleExplorerStateChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}
