"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
 * 在触发 spawn_subagent 的消息下方展示 subagent 小卡片。
 *
 * 每个 subagent 一张卡片：实时展示状态 + 当前工具调用 + 输出摘要，
 * 可点击跳转打开对应 worker session（在新 tab 查看完整对话）。
 * worker session 仍不在左侧 session 列表展示。
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
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <RunSummaryTag title={latest.title ?? "Subagents"} status={latest.status} text={`Subagents ${doneCount}/${workers.length}`} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {workers.map((worker) => (
          <WorkerCard
            key={worker.workerId ?? worker.name}
            worker={worker}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
    </div>
  );
}

/** 顶部总状态徽标 */
function RunSummaryTag({ title, status, text }: { title: string; status: CollaborationRunStatus; text: string }) {
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
        padding: "3px 10px",
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.2,
        alignSelf: "flex-start",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {text}
    </span>
  );
}

const MODE_LABELS: Partial<Record<string, string>> = {
  ask: "分析",
  code: "编码",
  parallel: "并行",
  review: "审查",
  custom: "自定义",
};

/** 单个 subagent 小卡片：实时展示状态 + 工具调用 + 输出摘要 */
function WorkerCard({ worker, onOpenSession }: { worker: CollaborationWorkerState; onOpenSession?: (sessionId: string) => void }) {
  const color = statusColor(worker.status);
  const label = worker.title ?? worker.name;
  const isRunning = worker.status === "running";
  const isTerminal = worker.status === "complete" || worker.status === "error" || worker.status === "aborted";
  const latestTool = isRunning ? (worker.activeTool ?? worker.recentTools?.[0]) : undefined;
  const canClick = Boolean(worker.sessionId && onOpenSession);
  const modeLabel = worker.agentType ? MODE_LABELS[worker.agentType] : undefined;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      title={canClick ? `点击查看 ${label} 的会话` : worker.error ? `${label} · ${worker.error}` : undefined}
      onClick={canClick ? () => onOpenSession!(worker.sessionId!) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 252,
        borderRadius: 10,
        border: `1px solid ${hovered && canClick ? "color-mix(in srgb, var(--accent) 50%, var(--border))" : "var(--border)"}`,
        background: "var(--bg-hover)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: canClick ? "pointer" : "default",
        transition: "border-color 0.12s, box-shadow 0.12s",
        boxShadow: hovered && canClick ? "0 2px 8px rgba(0,0,0,0.08)" : "none",
      }}
    >
      {/* header：状态点 + 名称 + 模式标签 + 状态文字 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
            animation: isRunning ? "tool-pulse 1.4s ease-in-out infinite" : "none",
          }}
        />
        <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {label}
        </span>
        {modeLabel && (
          <span style={{ fontSize: 9.5, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", flexShrink: 0, lineHeight: 1.5 }}>
            {modeLabel}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color, fontWeight: 700, fontSize: 11, flexShrink: 0 }}>{statusLabel(worker.status)}</span>
      </div>

      {/* body：按状态展示不同内容 */}
      {isRunning && latestTool && <ToolLine tool={latestTool} />}
      {isRunning && !latestTool && (
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>思考中…</span>
      )}
      {worker.status === "error" && worker.error && (
        <span style={{ fontSize: 11, color: "#f87171", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {worker.error}
        </span>
      )}
      {isTerminal && worker.result && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.5 }}>
          {worker.result}
        </span>
      )}
      {worker.diffStats && (
        <span style={{ fontSize: 10.5, color: "#16a34a", fontWeight: 600 }}>{worker.diffStats}</span>
      )}

      {/* footer：跳转提示 */}
      {canClick && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 3, marginTop: 1 }}>
          ↗ 点击查看会话
        </span>
      )}
    </div>
  );
}

/** 卡片内的工具调用行：圆点 + 工具名 + 文件/命令摘要 */
function ToolLine({ tool }: { tool: WorkerToolActivity }) {
  const isRunning = tool.status === "running";
  const dotColor = tool.status === "running" ? "#3b82f6" : tool.status === "error" ? "#f87171" : "var(--text-dim)";
  const summary = tool.summary.trim() || "无文件/命令摘要";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 8px",
        borderRadius: 6,
        background: isRunning ? "rgba(59, 130, 246, 0.09)" : "var(--bg-hover, var(--bg-subtle))",
        border: `1px solid ${tool.status === "error" ? "#f8717133" : "transparent"}`,
        fontSize: 11,
        minWidth: 0,
      }}
    >
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
      <span style={{ fontWeight: 700, color: isRunning ? "#2563eb" : "var(--text-muted)", flexShrink: 0 }}>{tool.toolName}</span>
      <span
        title={summary}
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
    </div>
  );
}
