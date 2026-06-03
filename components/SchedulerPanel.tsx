"use client";

import { useState, useEffect, useCallback } from "react";
import type { ScheduledTask } from "@/lib/scheduler/types";

// ============================================================================
// Cron presets for quick selection
// ============================================================================

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "每分钟", cron: "* * * * *" },
  { label: "每5分钟", cron: "*/5 * * * *" },
  { label: "每15分钟", cron: "*/15 * * * *" },
  { label: "每30分钟", cron: "*/30 * * * *" },
  { label: "每小时", cron: "0 * * * *" },
  { label: "每2小时", cron: "0 */2 * * *" },
  { label: "每天早上8点", cron: "0 8 * * *" },
  { label: "每天早上9点", cron: "0 9 * * *" },
  { label: "每周一早上9点", cron: "0 9 * * 1" },
  { label: "每月1号早上9点", cron: "0 9 1 * *" },
];

// ============================================================================
// Types
// ============================================================================

interface Props {
  onClose: () => void;
  cwd?: string;
}

interface TaskFormData {
  name: string;
  type: "prompt" | "shell";
  cron: string;
  config: {
    cwd: string;
    message?: string;
    command?: string;
    model?: { provider: string; modelId: string };
    toolNames?: string[];
  };
}

const EMPTY_FORM: TaskFormData = {
  name: "",
  type: "prompt",
  cron: "0 9 * * *",
  config: { cwd: "" },
};

// ============================================================================
// Component
// ============================================================================

export function SchedulerPanel({ onClose, cwd }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskFormData>({ ...EMPTY_FORM, config: { ...EMPTY_FORM.config, cwd: cwd || "" } });
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null;

  // Load tasks
  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduler");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = (await res.json()) as { tasks: ScheduledTask[] };
      setTasks(data.tasks);
    } catch {
      setError("加载任务列表失败");
    }
  }, []);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  // Populate form when selecting a task
  useEffect(() => {
    if (selectedTask) {
      setForm({
        name: selectedTask.name,
        type: selectedTask.type,
        cron: selectedTask.cron,
        config: { ...selectedTask.config } as TaskFormData["config"],
      });
      setIsCreating(false);
    }
  }, [selectedTask]);

  // -- Actions --

  const handleNew = () => {
    setSelectedId(null);
    setForm({ ...EMPTY_FORM, config: { ...EMPTY_FORM.config, cwd: cwd || "" } });
    setIsCreating(true);
    setError(null);
  };

  const handleSelect = (taskId: string) => {
    setSelectedId(taskId);
    setIsCreating(false);
    setError(null);
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      if (isCreating) {
        const res = await fetch("/api/scheduler", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            type: form.type,
            cron: form.cron,
            config: form.config,
          }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error || "创建失败");
        }
      } else if (selectedId) {
        const res = await fetch(`/api/scheduler/${selectedId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error || "更新失败");
        }
      }
      await fetchTasks();
      setIsCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (!confirm("确定删除此定时任务？")) return;
    try {
      const res = await fetch(`/api/scheduler/${selectedId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
      setSelectedId(null);
      setIsCreating(false);
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  };

  const handleToggle = async (task: ScheduledTask) => {
    try {
      const res = await fetch(`/api/scheduler/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      if (!res.ok) throw new Error("切换失败");
      await fetchTasks();
    } catch {
      setError("切换状态失败");
    }
  };

  // -- Render --

  const resultIcon = (task: ScheduledTask) => {
    if (!task.lastResult) return null;
    return task.lastResult === "success" ? (
      <span title="上次执行成功" style={{ color: "#22c55e", fontSize: 12 }}>✓</span>
    ) : (
      <span title={`上次执行失败: ${task.lastError || ""}`} style={{ color: "#ef4444", fontSize: 12 }}>✗</span>
    );
  };

  const typeLabel = (type: string) => (type === "prompt" ? "AI 对话" : "Shell 命令");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="定时任务"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 680,
          maxWidth: "calc(100vw - 32px)",
          minHeight: 500,
          maxHeight: "calc(100vh - 64px)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "var(--bg-panel)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>定时任务</div>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              width: 32, height: 32, borderRadius: 8,
              border: "none", background: "transparent",
              color: "var(--text-muted)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Task list sidebar */}
          <div style={{
            width: 220, flexShrink: 0,
            borderRight: "1px solid var(--border)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}>
            <div style={{
              padding: "10px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0,
            }}>
              <button
                onClick={handleNew}
                style={{
                  width: "100%", padding: "6px 0", borderRadius: 8,
                  border: "1px dashed var(--border)", background: "transparent",
                  color: "var(--text-muted)", cursor: "pointer",
                  fontSize: 13, fontWeight: 600,
                }}
              >
                + 新建任务
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "6px" }}>
              {tasks.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                  暂无定时任务
                </div>
              ) : (
                tasks.map((task) => (
                  <div
                    key={task.id}
                    onClick={() => handleSelect(task.id)}
                    style={{
                      padding: "8px 10px", borderRadius: 8,
                      cursor: "pointer",
                      background: task.id === selectedId ? "var(--bg-selected)" : "transparent",
                      marginBottom: 4,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggle(task); }}
                        title={task.enabled ? "已启用 — 点击禁用" : "已禁用 — 点击启用"}
                        style={{
                          width: 28, height: 16, borderRadius: 8,
                          border: "none", cursor: "pointer",
                          background: task.enabled ? "#22c55e" : "var(--border)",
                          position: "relative", flexShrink: 0,
                        }}
                      >
                        <span style={{
                          position: "absolute", top: 1,
                          left: task.enabled ? 13 : 1,
                          width: 14, height: 14, borderRadius: 7,
                          background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                          transition: "left 0.15s",
                        }} />
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {task.name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
                          <span>{task.cron}</span>
                          {resultIcon(task)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Editor panel */}
          <div style={{
            flex: 1, padding: "16px 20px",
            overflowY: "auto",
            display: "flex", flexDirection: "column", gap: 14,
          }}>
            {isCreating || selectedTask ? (
              <>
                {/* Task name */}
                <div>
                  <label style={labelStyle}>任务名称</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="例如：每日代码检查"
                    style={inputStyle}
                  />
                </div>

                {/* Task type */}
                <div>
                  <label style={labelStyle}>任务类型</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["prompt", "shell"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setForm({ ...form, type: t })}
                        style={{
                          padding: "6px 14px", borderRadius: 8,
                          border: form.type === t ? "2px solid var(--accent)" : "1px solid var(--border)",
                          background: form.type === t ? "var(--bg-selected)" : "transparent",
                          color: form.type === t ? "var(--accent)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 13, fontWeight: 600,
                        }}
                      >
                        {typeLabel(t)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Cron expression */}
                <div>
                  <label style={labelStyle}>执行计划 (Cron 表达式)</label>
                  <input
                    value={form.cron}
                    onChange={(e) => setForm({ ...form, cron: e.target.value })}
                    placeholder="0 9 * * *"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {CRON_PRESETS.map((preset) => (
                      <button
                        key={preset.cron}
                        onClick={() => setForm({ ...form, cron: preset.cron })}
                        style={{
                          padding: "2px 8px", borderRadius: 4,
                          border: "1px solid var(--border)",
                          background: form.cron === preset.cron ? "var(--bg-selected)" : "transparent",
                          color: form.cron === preset.cron ? "var(--accent)" : "var(--text-dim)",
                          cursor: "pointer", fontSize: 11,
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* CWD */}
                <div>
                  <label style={labelStyle}>工作目录</label>
                  <input
                    value={form.config.cwd}
                    onChange={(e) => setForm({ ...form, config: { ...form.config, cwd: e.target.value } })}
                    placeholder="/path/to/project"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                </div>

                {/* Type-specific config */}
                {form.type === "prompt" ? (
                  <div>
                    <label style={labelStyle}>AI 对话内容</label>
                    <textarea
                      value={form.config.message || ""}
                      onChange={(e) => setForm({ ...form, config: { ...form.config, message: e.target.value } })}
                      placeholder="发送给 AI 的指令，例如：请检查代码库中是否有未使用的导入"
                      rows={5}
                      style={{ ...inputStyle, resize: "vertical", minHeight: 80 }}
                    />
                  </div>
                ) : (
                  <div>
                    <label style={labelStyle}>Shell 命令</label>
                    <textarea
                      value={form.config.command || ""}
                      onChange={(e) => setForm({ ...form, config: { ...form.config, command: e.target.value } })}
                      placeholder="例如：npm test"
                      rows={3}
                      style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)", minHeight: 60 }}
                    />
                  </div>
                )}

                {/* Error */}
                {error && (
                  <div style={{ padding: "8px 12px", borderRadius: 8, background: "#fef2f2", color: "#dc2626", fontSize: 13 }}>
                    {error}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
                  <div>
                    {selectedTask && (
                      <button
                        onClick={handleDelete}
                        style={{
                          padding: "8px 16px", borderRadius: 8,
                          border: "1px solid #fca5a5", background: "transparent",
                          color: "#ef4444", cursor: "pointer", fontSize: 13, fontWeight: 600,
                        }}
                      >
                        删除任务
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => { setIsCreating(false); setSelectedId(null); setError(null); }}
                      style={{
                        padding: "8px 16px", borderRadius: 8,
                        border: "1px solid var(--border)", background: "transparent",
                        color: "var(--text-muted)", cursor: "pointer", fontSize: 13,
                      }}
                    >
                      取消
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving || !form.name.trim()}
                      style={{
                        padding: "8px 20px", borderRadius: 8,
                        border: "none", background: saving || !form.name.trim() ? "var(--border)" : "var(--accent)",
                        color: "#fff", cursor: saving || !form.name.trim() ? "not-allowed" : "pointer",
                        fontSize: 13, fontWeight: 600,
                      }}
                    >
                      {saving ? "保存中..." : isCreating ? "创建" : "保存"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)", fontSize: 13 }}>
                选择一个任务或创建新任务
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Shared styles --
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: 4,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box" as const,
};
