"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CollaborationRunSnapshot, CollaborationWorkerState, CollaborationRunStatus, CollaborationWorkerStatus, WorkerToolActivity } from "@/lib/parallel-agent/collaboration-types";

interface Props {
  run: CollaborationRunSnapshot;
  onOpenSession?: (sessionId: string) => void;
}

const TERMINAL_STATUSES: ReadonlySet<CollaborationRunStatus> = new Set(["complete", "aborted", "error", "applied"]);

type AnyRunStatus = CollaborationRunStatus | CollaborationWorkerStatus;

function statusColor(status?: AnyRunStatus): string {
  switch (status) {
    case "complete":
    case "applied":
      return "#16a34a";
    case "error":
    case "aborted":
      return "#f87171";
    case "running":
    case "setting_up":
    case "applying":
      return "#3b82f6";
    default:
      return "var(--text-dim)";
  }
}

function statusLabel(status?: AnyRunStatus): string {
  switch (status) {
    case "complete": return "完成";
    case "applied": return "已应用";
    case "error": return "失败";
    case "aborted": return "已中止";
    case "running": return "运行中";
    case "setting_up": return "准备中";
    case "applying": return "应用中";
    case "pending": return "等待中";
    default: return status ?? "未知";
  }
}

/**
 * 在触发 spawn_subagent 的消息下方展示轻量 subagent 标签。
 *
 * 设计约束：worker session 是内部执行上下文，不在左侧 session 列表展示；
 * 但 worker tag 本身可点击跳转打开对应 session（在新 tab 查看 worker 的完整对话）。
 * 运行中的 worker 还会流式展示当前正在执行的工具调用（工具名 + 文件/命令）。
 */
// 注入工具活动脉动动画（仅一次）
let toolPulseStyleInjected = false;
function injectToolPulseStyle() {
  if (typeof document === "undefined" || toolPulseStyleInjected) return;
  toolPulseStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes tool-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  `;
  document.head.appendChild(style);
}

export function SubagentRunCard({ run, onOpenSession }: Props) {
  const [latest, setLatest] = useState<CollaborationRunSnapshot>(run);
  const closedRef = useRef(false);

  // 注入 CSS 动画
  useEffect(() => { injectToolPulseStyle(); }, []);

  useEffect(() => {
    setLatest((prev) => {
      if (!run.updatedAt || run.updatedAt < (prev.updatedAt ?? "")) return prev;
      return { ...run, workers: run.workers ?? prev.workers };
    });
  }, [run]);

  // 实时状态：先拉一次，未终结则订阅 SSE。
  useEffect(() => {
    closedRef.current = false;
    let es: EventSource | null = null;
    let cancelled = false;

    async function refresh() {
      try {
        const res = await fetch(`/api/agent-runs/${run.runId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as CollaborationRunSnapshot;
        if (cancelled || closedRef.current) return;
        if (data?.updatedAt && data.updatedAt >= (latest.updatedAt ?? "")) {
          setLatest({ ...data, workers: data.workers ?? latest.workers });
        }
        if (TERMINAL_STATUSES.has(data?.status ?? latest.status)) return;
        es = new EventSource(`/api/agent-runs/${run.runId}/events`);
        es.onmessage = (e: MessageEvent<string>) => {
          if (closedRef.current) { es?.close(); return; }
          // 方案 A：SSE 直推完整快照，直接 JSON.parse 消费，不再 fetch。
          // 心跳注释行（":\n\n"）不会触发 onmessage，这里只处理真正的 data 帧。
          let snap: CollaborationRunSnapshot | null = null;
          try {
            snap = JSON.parse(e.data) as CollaborationRunSnapshot;
          } catch {
            return; // 异常帧忽略，等下一帧
          }
          if (cancelled || closedRef.current) return;
          // SSE 推送有序，直接覆盖；保留 workers 回退以防某帧缺失。
          setLatest({ ...snap, workers: snap.workers ?? latest.workers });
          if (TERMINAL_STATUSES.has(snap.status)) es?.close();
        };
        es.onerror = () => { es?.close(); };
      } catch {
        /* 网络错误：保持初始快照即可 */
      }
    }
    void refresh();

    return () => {
      cancelled = true;
      closedRef.current = true;
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.runId]);

  const workers = useMemo(() => latest.workers ?? [], [latest.workers]);
  const doneCount = useMemo(
    () => workers.filter((w) => w.status === "complete" || w.status === "error" || w.status === "aborted").length,
    [workers],
  );

  if (workers.length === 0) return null;

  return (
    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <RunTag title={latest.title ?? "Subagents"} status={latest.status} text={`Subagents ${doneCount}/${workers.length}`} />
      {workers.map((worker) => {
        const latestTool = worker.status === "running" ? worker.activeTool ?? worker.recentTools?.[0] : undefined;
        const key = worker.workerId ?? worker.name;
        return (
          <Fragment key={key}>
            <WorkerTag worker={worker} onOpenSession={onOpenSession} />
            {latestTool && <ToolActivityPill tool={latestTool} workerLabel={worker.title ?? worker.name} />}
          </Fragment>
        );
      })}
    </div>
  );
}

function RunTag({ title, status, text }: { title: string; status: CollaborationRunStatus; text: string }) {
  const color = statusColor(status);
  return (
    <span
      title={`${title} · ${statusLabel(status)}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: `1px solid ${color}44`,
        background: `${color}12`,
        color,
        borderRadius: 999,
        padding: "3px 8px",
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.2,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {text}
    </span>
  );
}

function WorkerTag({ worker, onOpenSession }: { worker: CollaborationWorkerState; onOpenSession?: (sessionId: string) => void }) {
  const color = statusColor(worker.status);
  const label = worker.title ?? worker.name;
  const detail = worker.error ? `${label} · ${worker.error}` : `${label} · ${statusLabel(worker.status)}`;
  const [hovered, setHovered] = useState(false);
  const canClick = Boolean(worker.sessionId && onOpenSession);

  return (
    <span
      title={canClick ? `点击查看 ${label} 的会话` : detail}
      onClick={canClick ? () => onOpenSession!(worker.sessionId!) : undefined}
      onMouseEnter={() => canClick && setHovered(true)}
      onMouseLeave={() => canClick && setHovered(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: 220,
        border: `1px solid ${hovered ? "color-mix(in srgb, var(--accent) 42%, var(--border))" : "var(--border)"}`,
        background: hovered ? "var(--bg-hover)" : "var(--bg-subtle)",
        color: "var(--text-muted)",
        borderRadius: 999,
        padding: "3px 8px",
        fontSize: 11,
        lineHeight: 1.2,
        cursor: canClick ? "pointer" : "default",
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ color, fontWeight: 700, flexShrink: 0 }}>{statusLabel(worker.status)}</span>
    </span>
  );
}

/** 独立胶囊：只展示最新一个工具调用，重点展示对应文件/命令/查询 */
function ToolActivityPill({ tool, workerLabel }: { tool: WorkerToolActivity; workerLabel: string }) {
  const dotColor = tool.status === "running" ? "#3b82f6" : tool.status === "error" ? "#f87171" : "var(--text-dim)";
  const textColor = tool.status === "running" ? "color-mix(in srgb, #3b82f6 82%, var(--text-muted))" : "var(--text-muted)";
  const isRunning = tool.status === "running";
  const summary = tool.summary.trim() || "无文件/命令摘要";
  return (
    <span
      title={`${workerLabel} · ${tool.toolName} · ${summary}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: 460,
        minWidth: 0,
        border: `1px solid ${tool.status === "error" ? "#f8717144" : "var(--border)"}`,
        background: tool.status === "running" ? "rgba(59, 130, 246, 0.08)" : "var(--bg-subtle)",
        color: textColor,
        borderRadius: 999,
        padding: "3px 8px",
        fontSize: 11,
        lineHeight: 1.2,
      }}
    >
      {/* 状态圆点 */}
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
          animation: isRunning ? "tool-pulse 1.4s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ fontWeight: 700, color: tool.status === "running" ? "#2563eb" : "var(--text-muted)", flexShrink: 0 }}>{tool.toolName}</span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text-muted)",
          minWidth: 0,
        }}
      >
        {summary}
      </span>
    </span>
  );
}
