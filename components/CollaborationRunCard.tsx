"use client";

import { useMemo, useState } from "react";
import { useCollaborationRun } from "@/hooks/useCollaborationRun";
import type { CollaborationRunSnapshot, CollaborationWorkerState } from "@/lib/parallel-agent/collaboration-types";

interface Props {
  snapshot: CollaborationRunSnapshot;
  onOpenSession?: (sessionId: string) => void;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    setting_up: "准备中",
    running: "运行中",
    complete: "已完成",
    aborted: "已中止",
    error: "出错",
    applying: "应用中",
    applied: "已应用",
    recoverable: "可恢复",
    pending: "等待中",
  };
  return labels[status] ?? status;
}

function workerPreview(worker: CollaborationWorkerState): string {
  return (worker.result || worker.error || "").trim().slice(0, 420);
}

function modeLabel(run: { taskMode?: string; mode: string }): string {
  if (run.taskMode === "parallel") return "Parallel Attempts";
  if (run.taskMode === "review") return "Review";
  if (run.taskMode === "code" || run.mode === "isolated_coding") return "Code in Isolation";
  if (run.taskMode === "custom") return "Custom";
  return "Ask";
}

function elapsed(createdAt?: string, updatedAt?: string): string {
  if (!createdAt) return "";
  const start = Date.parse(createdAt);
  const end = updatedAt ? Date.parse(updatedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function filesFromDiffStats(stats?: string): string[] {
  if (!stats) return [];
  return stats
    .split("\n")
    .map((line) => line.split("|")[0]?.trim())
    .filter((file): file is string => Boolean(file) && !/files? changed/.test(file));
}

export function CollaborationRunCard({ snapshot, onOpenSession }: Props) {
  const { state, error, abort, applyPatches, continueWorker } = useCollaborationRun(snapshot);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState<string | null>(null);
  const [continueOpen, setContinueOpen] = useState<string | null>(null);
  const [continuePrompt, setContinuePrompt] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const run = state ?? {
    runId: snapshot.runId,
    title: snapshot.title,
    mode: snapshot.mode,
    taskMode: snapshot.taskMode,
    runPlacement: snapshot.runPlacement,
    status: snapshot.status,
    message: snapshot.message,
    workers: snapshot.workers,
    summary: snapshot.summary,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    events: [],
  };
  const workers = Array.isArray(run.workers) ? run.workers : [];
  const events = Array.isArray(run.events) ? run.events : [];
  const canAbort = run.status === "setting_up" || run.status === "running" || run.status === "recoverable";
  const patchWorkers = useMemo(
    () => workers.filter((worker) => !!worker.diff?.trim()),
    [workers],
  );
  const recommendation = run.summary?.match(/推荐优先审阅并应用[^\n。]*(?:。)?/)?.[0] ?? "";
  const canApply = run.mode === "isolated_coding" && (run.status === "complete" || run.status === "error") && patchWorkers.length > 0;

  const toggleWorker = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleApply = async () => {
    const names = [...selected];
    if (names.length === 0) return;
    setActionError(null);
    setActionMessage(null);
    try {
      const files = [...selectedFiles];
      const result = await applyPatches(names, files.length > 0 ? files : undefined);
      setActionMessage(result.success ? `已应用：${result.applied.join(", ")}` : `部分应用失败：${result.failed.map((item) => item.workerName).join(", ")}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleFile = (file: string) => {
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const handleContinue = async (worker: CollaborationWorkerState) => {
    const workerId = worker.workerId ?? worker.name;
    setActionError(null);
    setActionMessage(null);
    try {
      await continueWorker(workerId, continuePrompt);
      setActionMessage(`已继续：${worker.title ?? worker.name}`);
      setContinueOpen(null);
      setContinuePrompt("");
      onOpenSession?.(worker.sessionId ?? workerId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ marginBottom: 24, display: "flex", justifyContent: "center", width: "100%" }}>
      <div style={{
        width: "min(100%, 72rem)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        background: "var(--bg-panel)",
        color: "var(--text)",
        overflow: "hidden",
      }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Subagent Task · {modeLabel(run)}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {run.title ?? run.message}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{statusLabel(run.status)}{elapsed(run.createdAt, run.updatedAt) ? ` · ${elapsed(run.createdAt, run.updatedAt)}` : ""}</span>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              style={{ padding: "5px 9px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
            >
              {expanded ? "收起" : "展开"}
            </button>
            {canAbort && (
              <button
                type="button"
                onClick={() => abort().catch((err) => setActionError(err instanceof Error ? err.message : String(err)))}
                style={{ padding: "5px 9px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
              >
                中止
              </button>
            )}
          </div>
        </div>

        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          {workers.map((worker) => {
            const preview = workerPreview(worker);
            const hasDiff = !!worker.diff?.trim();
            const changedFiles = filesFromDiffStats(worker.diffStats);
            return (
              <div key={worker.name} style={{ border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", borderRadius: 10, padding: 10, background: "var(--bg)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{worker.title ?? worker.name}</div>
                    <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>{worker.capability ?? (run.mode === "isolated_coding" ? "isolated_coding" : "readonly")}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{statusLabel(worker.status)}</div>
                    {worker.sessionId && (
                      <button
                        type="button"
                        onClick={() => onOpenSession?.(worker.sessionId!)}
                        style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12, cursor: onOpenSession ? "pointer" : "not-allowed" }}
                      >
                        打开子会话
                      </button>
                    )}
                    {worker.sessionId && (
                      <button
                        type="button"
                        onClick={() => setContinueOpen((current) => current === worker.name ? null : worker.name)}
                        style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
                      >
                        继续此 Agent
                      </button>
                    )}
                  </div>
                </div>
                {continueOpen === worker.name && (
                  <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                    <textarea
                      value={continuePrompt}
                      onChange={(event) => setContinuePrompt(event.target.value)}
                      placeholder="继续指令（留空则让子 Agent 自行补充遗漏并更新摘要）"
                      style={{ width: "100%", minHeight: 54, resize: "vertical", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)", padding: 8, fontSize: 12, outline: "none" }}
                    />
                    <div>
                      <button
                        type="button"
                        onClick={() => handleContinue(worker)}
                        style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, cursor: "pointer" }}
                      >
                        发送继续指令
                      </button>
                    </div>
                  </div>
                )}
                {expanded && <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>{worker.instructions ?? worker.task}</div>}
                {(preview && (expanded || worker.status !== "complete")) && (
                  <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
                    {preview}{preview.length >= 420 ? "..." : ""}
                  </div>
                )}
                {worker.diffStats && (
                  <pre style={{ marginTop: 8, padding: 8, borderRadius: 8, background: "var(--tool-bg)", color: "var(--text-muted)", fontSize: 11, overflowX: "auto" }}>{worker.diffStats}</pre>
                )}
                {hasDiff && (
                  <button
                    type="button"
                    onClick={() => setDiffOpen((current) => current === worker.name ? null : worker.name)}
                    style={{ marginTop: 8, padding: "5px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
                  >
                    {diffOpen === worker.name ? "隐藏 diff" : "查看 diff"}
                  </button>
                )}
                {diffOpen === worker.name && worker.diff && (
                  <pre style={{ marginTop: 8, maxHeight: 260, overflow: "auto", padding: 10, borderRadius: 8, background: "var(--tool-bg)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{worker.diff}</pre>
                )}
                {canApply && hasDiff && (
                  <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
                      <input type="checkbox" checked={selected.has(worker.name)} onChange={() => toggleWorker(worker.name)} />
                      选择应用此子 Agent 的补丁
                    </label>
                    {changedFiles.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {changedFiles.map((file) => (
                          <label key={file} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 6px", borderRadius: 999, border: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>
                            <input type="checkbox" checked={selectedFiles.has(file)} onChange={() => toggleFile(file)} />
                            {file}
                          </label>
                        ))}
                      </div>
                    )}
                    {!!worker.appliedFiles?.length && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>已应用文件：{worker.appliedFiles.join(", ")}</div>}
                    {!!worker.conflictFiles?.length && <div style={{ fontSize: 11, color: "var(--accent)" }}>冲突文件：{worker.conflictFiles.join(", ")}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {(run.summary || error || actionError || actionMessage || canApply || events.length > 0) && (
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--text-muted)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                {actionMessage || actionError || error || recommendation || (run.summary ? "任务结果已汇总。" : "")}
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                {events.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setLogOpen((value) => !value)}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
                  >
                    {logOpen ? "隐藏日志" : `查看日志 (${events.length})`}
                  </button>
                )}
                {canApply && (
                  <button
                    type="button"
                    disabled={selected.size === 0}
                    onClick={handleApply}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: selected.size > 0 ? "var(--accent)" : "var(--bg-hover)", color: selected.size > 0 ? "white" : "var(--text-dim)", fontSize: 12, cursor: selected.size > 0 ? "pointer" : "not-allowed", flexShrink: 0 }}
                  >
                    应用选中补丁
                  </button>
                )}
              </div>
            </div>
            {run.summary && expanded && (
              <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", fontFamily: "inherit", lineHeight: 1.55, color: "var(--text-muted)" }}>{run.summary}</pre>
            )}
            {logOpen && (
              <pre style={{ margin: "10px 0 0", maxHeight: 220, overflow: "auto", padding: 10, borderRadius: 8, background: "var(--bg)", color: "var(--text-dim)", fontSize: 11 }}>
                {events.map((event) => `${event.timestamp ?? ""} ${event.workerId ? `[${event.workerId}] ` : ""}${event.type}${event.error ? `: ${event.error}` : ""}`).join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
