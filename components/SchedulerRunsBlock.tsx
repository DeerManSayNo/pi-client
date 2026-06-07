"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScheduledTask, TaskLog } from "@/lib/scheduler/types";

type TaskWithJobStatus = ScheduledTask & {
  jobStatus?: { scheduled: boolean; nextRun: string | Date | null };
};

type TaskRun = TaskLog & {
  taskId: string;
  taskName: string;
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "--";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function truncate(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

export function SchedulerRunsBlock() {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskWithJobStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runs = useMemo<TaskRun[]>(() => {
    return tasks
      .flatMap((task) => (task.logs ?? []).map((log) => ({ ...log, taskId: task.id, taskName: task.name })))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 50);
  }, [tasks]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scheduler");
      if (!res.ok) throw new Error("Failed to fetch scheduler tasks");
      const data = (await res.json()) as { tasks?: TaskWithJobStatus[] };
      setTasks(data.tasks ?? []);
    } catch {
      setError("加载定时任务执行记录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchTasks();
    const timer = window.setInterval(() => void fetchTasks(), 15_000);
    return () => window.clearInterval(timer);
  }, [open, fetchTasks]);

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        borderBottom: open ? "1px solid var(--border)" : "none",
        background: "var(--bg-subtle)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", paddingTop: 2 }}>
        <button
          onClick={() => setOpen((v) => !v)}
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
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
          定时任务
          <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, letterSpacing: 0, textTransform: "none" }}>
            {runs.length > 0 ? `${runs.length} 次执行` : `${tasks.length} 个任务`}
          </span>
        </button>
        {open && (
          <button
            onClick={() => void fetchTasks()}
            title="刷新定时任务执行记录"
            disabled={loading}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              marginRight: 6,
              background: "none",
              border: "none",
              color: loading ? "var(--text-dim)" : "var(--text-muted)",
              cursor: loading ? "default" : "pointer",
              borderRadius: 5,
              flexShrink: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div style={{ maxHeight: 220, overflowY: "auto", overflowX: "hidden", padding: "2px 8px 8px" }}>
          {loading && runs.length === 0 && (
            <div style={{ padding: "10px 6px", color: "var(--text-muted)", fontSize: 12 }}>加载中...</div>
          )}
          {error && (
            <div style={{ padding: "10px 6px", color: "#f87171", fontSize: 12 }}>{error}</div>
          )}
          {!loading && !error && runs.length === 0 && (
            <div style={{ padding: "10px 6px", color: "var(--text-muted)", fontSize: 12 }}>
              暂无执行记录
            </div>
          )}
          {runs.map((run) => (
            <div
              key={`${run.taskId}-${run.id}`}
              style={{
                padding: "7px 8px",
                marginBottom: 5,
                borderRadius: 8,
                background: "var(--bg)",
                border: "1px solid var(--border)",
              }}
              title={run.error || run.output || run.taskName}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{ color: run.result === "success" ? "#22c55e" : "#ef4444", fontSize: 12, fontWeight: 700 }}>
                  {run.result === "success" ? "✓" : "✗"}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12, fontWeight: 600 }}>
                  {run.taskName}
                </span>
                <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{formatDuration(run.durationMs)}</span>
              </div>
              <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 10 }}>{formatTime(run.timestamp)}</div>
              {(run.error || run.output) && (
                <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.35 }}>
                  {truncate(run.error || run.output || "")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
