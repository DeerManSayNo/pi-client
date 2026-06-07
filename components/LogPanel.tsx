"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getLocalStorageItem } from "@/lib/client-storage";
import { logEventStore, type LogEntry, type ThinkingBlock } from "@/lib/log-event-store";

/** Format timestamp to HH:MM:SS.mmm */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

/** Truncate text to max length */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** Strip ANSI codes */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Entry color mapping ──
function getEntryColor(type: LogEntry["type"]): string {
  switch (type) {
    case "thinking": return "var(--text-dim)";
    case "tool_start": return "#60a5fa";
    case "tool_end": return "#4ade80";
    case "text": return "var(--text)";
    case "error": return "#f87171";
    case "info": return "#a78bfa";
    case "system": return "#fbbf24";
    default: return "var(--text-muted)";
  }
}

function getEntryPrefix(type: LogEntry["type"]): string {
  switch (type) {
    case "thinking": return "💭";
    case "tool_start": return "🔧";
    case "tool_end": return "✅";
    case "text": return "📝";
    case "error": return "❌";
    case "info": return "ℹ️";
    case "system": return "⚡";
    default: return "·";
  }
}

// ── Thinking Entry Card ──
function ThinkingCard({ entry, isNewest }: { entry: LogEntry; isNewest: boolean }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        marginBottom: 4,
        borderRadius: 6,
        background: isNewest ? "color-mix(in srgb, var(--accent) 6%, var(--bg))" : "var(--bg-panel)",
        border: `1px solid ${isNewest ? "color-mix(in srgb, var(--accent) 18%, var(--border))" : "var(--border)"}`,
        transition: "background 0.2s, border-color 0.2s",
      }}
    >
      <div
        style={{
          fontSize: 11,
          lineHeight: 1.6,
          color: "var(--text-muted)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {stripAnsi(entry.content)}
      </div>
    </div>
  );
}

// ── Log Entry Row ──
function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: "2px 8px",
        fontSize: 11,
        lineHeight: 1.5,
        fontFamily: "var(--font-mono)",
        color: getEntryColor(entry.type),
        borderBottom: "1px solid color-mix(in srgb, var(--border) 30%, transparent)",
      }}
    >
      <span style={{ flexShrink: 0, fontSize: 10, opacity: 0.7, minWidth: 8 }}>
        {getEntryPrefix(entry.type)}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, minWidth: 72 }}>
        {formatTime(entry.timestamp)}
      </span>
      {entry.toolName && (
        <span
          style={{
            flexShrink: 0,
            padding: "0 4px",
            borderRadius: 3,
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            color: "var(--accent)",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {entry.toolName}
        </span>
      )}
      <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
        {truncate(stripAnsi(entry.content), 400)}
      </span>
    </div>
  );
}

function cloneThinkingBlock(block: ThinkingBlock | null): ThinkingBlock | null {
  if (!block) return null;
  return {
    ...block,
    tools: block.tools.map((tool) => ({ ...tool })),
  };
}

export function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [blocks, setBlocks] = useState<ThinkingBlock[]>([]);
  const [currentBlock, setCurrentBlock] = useState<ThinkingBlock | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [splitPercent, setSplitPercent] = useState(() => {
    if (typeof window === "undefined") return 55;
    try {
      const stored = getLocalStorageItem("deerhux.log-split-percent");
      if (stored) {
        const n = Number(stored);
        if (n >= 20 && n <= 80) return n;
      }
    } catch { /* ignore */ }
    return 55;
  });

  const topPanelRef = useRef<HTMLDivElement>(null);
  const bottomPanelRef = useRef<HTMLDivElement>(null);
  const splitterRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const splitPercentRef = useRef(splitPercent);
  splitPercentRef.current = splitPercent;

  // Subscribe to log events
  useEffect(() => {
    const allEntries = logEventStore.getEntries();
    setEntries([...allEntries]);
    setBlocks(logEventStore.getCompletedBlocks().filter((block) => block.thinking.trim().length > 0));
    setCurrentBlock(cloneThinkingBlock(logEventStore.getCurrentBlock()));

    const unsubEntry = (entry: LogEntry) => {
      setEntries((prev) => [...prev, entry]);
      setCurrentBlock(cloneThinkingBlock(logEventStore.getCurrentBlock()));
    };

    const unsubscribeEntry = logEventStore.subscribe(unsubEntry);

    const unsubscribeBlock = logEventStore.subscribeBlock((block) => {
      if (block.thinking.trim().length > 0) {
        setBlocks((prev) => [...prev, cloneThinkingBlock(block)!]);
      }
      setCurrentBlock(null);
    });

    const unsubClear = logEventStore.subscribeClear(() => {
      setEntries([]);
      setBlocks([]);
      setCurrentBlock(null);
    });

    return () => {
      unsubscribeEntry();
      unsubscribeBlock();
      unsubClear();
    };
  }, []);

  // Auto-scroll bottom panel
  useEffect(() => {
    if (autoScroll && bottomPanelRef.current) {
      const el = bottomPanelRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [entries, autoScroll]);

  // Auto-scroll top panel
  useEffect(() => {
    if (topPanelRef.current) {
      const el = topPanelRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [blocks, currentBlock]);

  const handleBottomScroll = useCallback(() => {
    if (!bottomPanelRef.current) return;
    const el = bottomPanelRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  // Splitter drag
  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startPercent = splitPercentRef.current;
    const container = splitterRef.current?.parentElement;
    if (!container) return;
    const containerHeight = container.offsetHeight;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    setIsDragging(true);

    const handleMove = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      const deltaPercent = (delta / containerHeight) * 100;
      const newPercent = Math.max(20, Math.min(80, startPercent + deltaPercent));
      setSplitPercent(newPercent);
    };

    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsDragging(false);
      try {
        localStorage.setItem("deerhux.log-split-percent", String(splitPercentRef.current));
      } catch { /* ignore */ }
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, []);

  const handleClear = useCallback(() => {
    logEventStore.clear();
  }, []);

  // Thinking entries for the top panel. Derive directly from the live raw log stream so it
  // updates whenever the lower log updates, without relying on block aggregation state.
  const thinkingEntries = entries.filter((entry) => entry.type === "thinking" && entry.content.trim().length > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
            AI Log
          </span>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            {entries.length} 条记录 · {thinkingEntries.length} 段思考
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={handleClear}
            title="清空日志"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              background: "transparent",
              border: "none",
              borderRadius: 4,
              color: "var(--text-dim)",
              cursor: "pointer",
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#f87171"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Top panel: streaming thinking only */}
      <div
        ref={topPanelRef}
        style={{
          flex: `${splitPercent} 1 0`,
          overflowY: "auto",
          overflowX: "hidden",
          minHeight: 0,
          padding: "4px 6px",
        }}
      >
        {thinkingEntries.length === 0 && (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 8,
              color: "var(--text-dim)",
              fontSize: 12,
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>等待 AI 思考...</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>AI 的思考内容会在这里实时流式展示</span>
          </div>
        )}
        {thinkingEntries.map((entry, i) => (
          <ThinkingCard key={entry.id} entry={entry} isNewest={i === thinkingEntries.length - 1} />
        ))}
      </div>

      {/* Splitter */}
      <div
        ref={splitterRef}
        onMouseDown={handleSplitterMouseDown}
        style={{
          height: 5,
          flexShrink: 0,
          cursor: "row-resize",
          borderTop: `1px solid ${isDragging ? "var(--accent)" : "var(--border)"}`,
          borderBottom: `1px solid ${isDragging ? "var(--accent)" : "var(--border)"}`,
          background: isDragging ? "color-mix(in srgb, var(--accent) 10%, var(--bg))" : "var(--bg-panel)",
          transition: isDragging ? "none" : "background 0.15s, border-color 0.15s",
        }}
      />

      {/* Bottom panel: raw log entries */}
      <div
        ref={bottomPanelRef}
        onScroll={handleBottomScroll}
        style={{
          flex: `${100 - splitPercent} 1 0`,
          overflowY: "auto",
          overflowX: "hidden",
          minHeight: 0,
          background: "color-mix(in srgb, var(--bg) 96%, #000)",
        }}
      >
        {entries.length === 0 && (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 8,
              color: "var(--text-dim)",
              fontSize: 12,
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span>日志为空</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>发送消息后，实时日志将在此处滚动显示</span>
          </div>
        )}
        {entries.map((entry) => (
          <LogRow key={entry.id} entry={entry} />
        ))}
      </div>

      {/* Auto-scroll indicator */}
      {!autoScroll && entries.length > 0 && (
        <button
          onClick={() => {
            setAutoScroll(true);
            if (bottomPanelRef.current) {
              bottomPanelRef.current.scrollTop = bottomPanelRef.current.scrollHeight;
            }
          }}
          style={{
            position: "absolute",
            bottom: 8,
            right: 12,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            borderRadius: 999,
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 500,
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
          滚动到底部
        </button>
      )}
    </div>
  );
}
