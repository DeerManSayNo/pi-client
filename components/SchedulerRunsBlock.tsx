"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScheduledTask, TaskLog } from "@/lib/scheduler/types";
import type { SessionInfo } from "@/lib/types";

type TaskWithJobStatus = ScheduledTask & {
  jobStatus?: { scheduled: boolean; nextRun: string | Date | null };
};

type TaskRun = TaskLog & {
  taskId: string;
  taskName: string;
  taskCwd: string;
};

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
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

export function SchedulerRunsBlock({ selectedSessionId, onSelectSession }: Props) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskWithJobStatus[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wechatRestarting, setWechatRestarting] = useState(false);
  const [wechatRestartDone, setWechatRestartDone] = useState(false);

  const runs = useMemo<TaskRun[]>(() => {
    return tasks
      .flatMap((task) => (task.logs ?? []).map((log) => ({
        ...log,
        taskId: task.id,
        taskName: task.name,
        taskCwd: task.config.cwd,
      })))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 50);
  }, [tasks]);

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionInfo>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const scheduledSessions = useMemo(() => {
    const used = new Set<string>();

    function inferSessionForRun(run: TaskRun): SessionInfo | null {
      if (run.sessionId) return sessionById.get(run.sessionId) ?? null;

      // Backward compatibility for logs written before sessionId was recorded:
      // task log time is written at the end of execution, so the session should
      // have been created around timestamp - durationMs in the same cwd.
      const expectedStart = new Date(run.timestamp).getTime() - (Number.isFinite(run.durationMs) ? run.durationMs : 0);
      if (!Number.isFinite(expectedStart)) return null;

      const candidates = sessions
        .filter((session) => session.cwd === run.taskCwd && !used.has(session.id))
        .map((session) => ({ session, delta: Math.abs(new Date(session.created).getTime() - expectedStart) }))
        .filter((item) => Number.isFinite(item.delta) && item.delta < 5 * 60_000)
        .sort((a, b) => a.delta - b.delta);
      return candidates[0]?.session ?? null;
    }

    const items: Array<{ run: TaskRun; session: SessionInfo }> = [];
    for (const run of runs) {
      const session = inferSessionForRun(run);
      if (!session) continue;
      used.add(session.id);
      items.push({ run, session });
    }
    return items;
  }, [runs, sessionById, sessions]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schedulerRes, sessionsRes] = await Promise.all([
        fetch("/api/scheduler"),
        fetch("/api/sessions"),
      ]);
      if (!schedulerRes.ok) throw new Error("Failed to fetch scheduler tasks");
      if (!sessionsRes.ok) throw new Error("Failed to fetch sessions");

      const schedulerData = (await schedulerRes.json()) as { tasks?: TaskWithJobStatus[] };
      const sessionsData = (await sessionsRes.json()) as { sessions?: SessionInfo[] };
      setTasks(schedulerData.tasks ?? []);
      setSessions(sessionsData.sessions ?? []);
    } catch {
      setError("加载定时任务 Session 失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchData();
    const timer = window.setInterval(() => void fetchData(), 15_000);
    return () => window.clearInterval(timer);
  }, [open, fetchData]);

  const restartWechatPolling = useCallback(async () => {
    setWechatRestarting(true);
    setWechatRestartDone(false);
    setError(null);
    try {
      const res = await fetch("/api/wechat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "重启微信消息接收失败");
      }
      setWechatRestartDone(true);
      window.setTimeout(() => setWechatRestartDone(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWechatRestarting(false);
    }
  }, []);

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
            {scheduledSessions.length > 0 ? `${scheduledSessions.length} 个 Session` : `${tasks.length} 个任务`}
          </span>
        </button>
        <button
          onClick={() => void restartWechatPolling()}
          title="重启微信消息接收"
          disabled={wechatRestarting}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            padding: 0,
            marginRight: open ? 2 : 6,
            background: wechatRestartDone ? "rgba(34,197,94,0.14)" : "none",
            border: "none",
            color: wechatRestartDone ? "#22c55e" : wechatRestarting ? "var(--text-dim)" : "var(--text-muted)",
            cursor: wechatRestarting ? "default" : "pointer",
            borderRadius: 5,
            flexShrink: 0,
            transition: "color 0.15s, background 0.15s",
          }}
        >
          {wechatRestartDone ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: wechatRestarting ? 0.55 : 1 }}>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M16 8h5V3" />
            </svg>
          )}
        </button>
        {open && (
          <button
            onClick={() => void fetchData()}
            title="刷新定时任务 Session"
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
        <div style={{ maxHeight: 220, overflowY: "auto", overflowX: "hidden", padding: "2px 0 8px" }}>
          {loading && scheduledSessions.length === 0 && (
            <div style={{ padding: "10px 14px", color: "var(--text-muted)", fontSize: 12 }}>加载中...</div>
          )}
          {error && (
            <div style={{ padding: "10px 14px", color: "#f87171", fontSize: 12 }}>{error}</div>
          )}
          {!loading && !error && scheduledSessions.length === 0 && (
            <div style={{ padding: "10px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              暂无可打开的定时任务 Session
            </div>
          )}
          {scheduledSessions.map(({ run, session }) => {
            const title = session.name || session.firstMessage.slice(0, 50) || run.taskName || session.id.slice(0, 12);
            const isSelected = session.id === selectedSessionId;
            const isSuccess = run.result === "success";
            return (
              <button
                key={`${run.taskId}-${run.id}-${session.id}`}
                onClick={() => onSelectSession(session)}
                title={title}
                style={{
                  height: 54,
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  paddingLeft: 14,
                  paddingRight: 8,
                  cursor: "pointer",
                  background: isSelected ? "var(--bg-selected)" : "transparent",
                  border: "none",
                  borderLeft: isSelected ? "2px solid var(--accent)" : "2px solid transparent",
                  color: "var(--text)",
                  textAlign: "left",
                  transition: "background 0.1s",
                  gap: 6,
                  overflow: "hidden",
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
              >
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
                  >
                    {title}
                  </div>
                  <div style={{ marginTop: 2, display: "flex", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
                    <span title={session.modified}>{formatRelativeTime(session.modified)}</span>
                    <span>{session.messageCount} 条消息</span>
                    <span style={{ color: isSuccess ? "#22c55e" : "#ef4444" }}>{isSuccess ? "成功" : "失败"}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
