"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface SystemPromptSection {
  id: string;
  label: string;
  description: string;
  content: string;
  enabled: boolean;
  editable: boolean;
}

interface SystemPromptVersion {
  id: string;
  name: string;
  description: string;
  sections: { id: string; enabled: boolean; content: string }[];
  createdAt: string;
  updatedAt: string;
}

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  sessionId?: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function composePrompt(sections: SystemPromptSection[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    if (!s.enabled || !s.content.trim()) continue;
    parts.push(s.content.trim());
  }
  return parts.join("\n\n");
}

// ── Component ──────────────────────────────────────────────────────────────

export function SystemPromptConfig({ onClose }: Props) {
  const [sections, setSections] = useState<SystemPromptSection[]>([]);
  const [versions, setVersions] = useState<SystemPromptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [saved, setSaved] = useState(false);

  // Version form
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDesc, setSaveDesc] = useState("");

  // Expanded sections
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["identity", "guidelines"]));

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Load ───────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/system-prompt", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as {
        sections: SystemPromptSection[] | null;
        versions: SystemPromptVersion[];
      };
      if (data.sections) setSections(data.sections);
      setVersions(data.versions ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Section manipulation ──────────────────────────────────────────────

  const toggleSection = useCallback((id: string) => {
    setSections((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
    setSaved(false);
  }, []);

  const updateContent = useCallback((id: string, content: string) => {
    setSections((prev) =>
      prev.map((s) => (s.id === id ? { ...s, content } : s)),
    );
    setSaved(false);
  }, []);

  // ── Save global default ───────────────────────────────────────────────

  const composed = useMemo(() => composePrompt(sections), [sections]);

  const handleSaveGlobal = useCallback(async () => {
    setSavingGlobal(true);
    try {
      const res = await fetch("/api/system-prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sections: sections.map((s) => ({ id: s.id, enabled: s.enabled, content: s.content })),
        }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSavingGlobal(false);
    }
  }, [sections]);

  // ── Version CRUD ──────────────────────────────────────────────────────

  const handleSaveVersion = useCallback(async () => {
    if (!saveName.trim()) return;
    try {
      const res = await fetch("/api/system-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: saveName,
          description: saveDesc,
          sections: sections.map((s) => ({
            id: s.id,
            enabled: s.enabled,
            content: s.content,
          })),
        }),
      });
      if (!res.ok) return;
      setSaveName(""); setSaveDesc(""); setSaveOpen(false);
      await load();
    } catch { /* ignore */ }
  }, [saveName, saveDesc, sections, load]);

  const handleApplyVersion = useCallback(
    (version: SystemPromptVersion) => {
      setSections((prev) =>
        prev.map((live) => {
          const override = version.sections.find((s) => s.id === live.id);
          if (!override) return live;
          return {
            ...live,
            enabled: override.enabled,
            content: live.editable ? (override.content || live.content) : live.content,
          };
        }),
      );
      setSaved(false);
    },
    [],
  );

  const handleDeleteVersion = useCallback(
    async (versionId: string, name: string) => {
      if (!window.confirm(`确定删除版本「${name}」吗？`)) return;
      try {
        await fetch(`/api/system-prompt/${encodeURIComponent(versionId)}`, {
          method: "DELETE",
        });
        await load();
      } catch { /* ignore */ }
    },
    [load],
  );

  // ── Export / Import ───────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const data = {
      name: "当前配置",
      description: "",
      sections: sections.map((s) => ({
        id: s.id,
        enabled: s.enabled,
        content: s.content,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "system-prompt-config.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [sections]);

  // ── Render ────────────────────────────────────────────────────────────

  const enabledCount = sections.filter((s) => s.enabled).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="System Prompt 配置"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, calc(100vw - 40px))",
          height: "min(780px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 16,
          background: "var(--bg)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          display: "flex",
        }}
      >
        {/* ── Left sidebar: versions ────────────────────────────────── */}
        <aside
          style={{
            width: 230,
            borderRight: "1px solid var(--border)",
            background: "var(--bg-panel)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "14px 14px 10px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>
                System Prompt
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                结构化组件管理
              </div>
            </div>
          </div>

          {/* Current status */}
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            当前: {enabledCount}/{sections.length} 组件启用
          </div>

          {/* Versions list */}
          <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
            <div
              style={{
                padding: "4px 8px 6px",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--text-dim)",
              }}
            >
              已保存的版本
            </div>
            {versions.length === 0 && (
              <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>
                暂无保存的版本
              </div>
            )}
            {versions.map((v) => (
              <div
                key={v.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  marginBottom: 3,
                  background: "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <button
                  onClick={() => handleApplyVersion(v)}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    border: "none",
                    background: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--text)",
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={v.description || v.name}
                >
                  {v.name}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteVersion(v.id, v.name);
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    padding: 0,
                    border: "none",
                    borderRadius: 4,
                    background: "transparent",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "#ef4444";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--text-dim)";
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Save / Export */}
          <div
            style={{
              padding: 8,
              borderTop: "1px solid var(--border)",
              display: "flex",
              gap: 6,
            }}
          >
            <button onClick={() => setSaveOpen((v) => !v)} style={sidebarBtnStyle}>
              保存版本
            </button>
            <button onClick={handleExport} style={sidebarBtnStyle}>
              导出
            </button>
          </div>

          {/* Save dialog */}
          {saveOpen && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 10,
                background: "var(--bg-panel)",
                display: "flex",
                flexDirection: "column",
                padding: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                  保存为版本
                </div>
                <button
                  onClick={() => { setSaveOpen(false); setSaveName(""); setSaveDesc(""); }}
                  style={iconBtnStyle}
                >
                  ×
                </button>
              </div>
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="版本名称"
                style={inputStyle}
                autoFocus
              />
              <input
                value={saveDesc}
                onChange={(e) => setSaveDesc(e.target.value)}
                placeholder="版本描述（可选）"
                style={inputStyle}
              />
              <button
                onClick={handleSaveVersion}
                disabled={!saveName.trim()}
                style={{ ...primaryBtnStyle, width: "100%", fontSize: 12 }}
              >
                保存
              </button>
            </div>
          )}
        </aside>

        {/* ── Main: section cards ────────────────────────────────────── */}
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          {/* Top bar */}
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>
                全局默认 System Prompt 组件配置
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                这里设置的是通用默认配置：新建/恢复 AgentSession 时会基于 pi 原始 system prompt 按这些组件重新组合
              </div>
            </div>
            <button
              onClick={handleSaveGlobal}
              disabled={savingGlobal}
              style={{
                ...primaryBtnStyle,
                background: saved
                  ? "color-mix(in srgb, var(--accent) 40%, #16a34a)"
                  : "var(--accent)",
                opacity: savingGlobal ? 0.5 : 1,
              }}
            >
              {savingGlobal ? "保存中..." : saved ? "✓ 已保存" : "保存为全局默认"}
            </button>
            <button onClick={onClose} style={closeBtnStyle}>
              ×
            </button>
          </div>

          {/* Section cards */}
          {loading ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              加载中...
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
              {sections.length === 0 && (
                <div
                  style={{
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 13,
                    padding: 40,
                  }}
                >
                  暂无配置项。
                </div>
              )}

              {sections.map((section) => {
                const isExpanded = expanded.has(section.id);
                return (
                  <div
                    key={section.id}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      marginBottom: 10,
                      background: section.enabled ? "var(--bg)" : "var(--bg-panel)",
                      opacity: section.enabled ? 1 : 0.55,
                      transition: "opacity 0.15s, background 0.15s",
                    }}
                  >
                    {/* Section header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 14px",
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        if (section.content) toggleExpanded(section.id);
                      }}
                    >
                      {/* Enable toggle */}
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={section.enabled}
                          onChange={() => toggleSection(section.id)}
                          style={{ accentColor: "var(--accent)" }}
                        />
                      </label>

                      {/* Name + description */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: "var(--text)",
                          }}
                        >
                          {section.label}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {section.description}
                          {!section.editable && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 10,
                                color: "var(--text-dim)",
                              }}
                            >
                              (自动生成)
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Content stats */}
                      {section.content && (
                        <span
                          style={{
                            fontSize: 10,
                            color: "var(--text-dim)",
                            flexShrink: 0,
                          }}
                        >
                          {section.content.length} 字符
                        </span>
                      )}

                      {/* Expand arrow */}
                      {section.content && (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          style={{
                            color: "var(--text-dim)",
                            flexShrink: 0,
                            transform: isExpanded ? "rotate(180deg)" : "none",
                            transition: "transform 0.15s",
                          }}
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      )}
                    </div>

                    {/* Expandable content */}
                    {isExpanded && section.content && (
                      <div
                        style={{
                          borderTop: "1px solid var(--border)",
                          padding: 12,
                        }}
                      >
                        {section.editable ? (
                          <textarea
                            value={section.content}
                            onChange={(e) =>
                              updateContent(section.id, e.target.value)
                            }
                            rows={Math.min(12, section.content.split("\n").length + 2)}
                            style={{
                              ...textareaStyle,
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              lineHeight: 1.6,
                            }}
                          />
                        ) : (
                          <pre
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              lineHeight: 1.6,
                              color: "var(--text-muted)",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              margin: 0,
                              padding: "8px 10px",
                              background: "var(--bg-panel)",
                              borderRadius: 6,
                              maxHeight: 240,
                              overflowY: "auto",
                            }}
                          >
                            {section.content}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Composed preview */}
              <div
                style={{
                  marginTop: 14,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    background: "var(--bg-panel)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  组合后的完整 System Prompt ({composed.length} 字符)
                </div>
                <pre
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    lineHeight: 1.6,
                    color: "var(--text-muted)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                    padding: 14,
                    maxHeight: 220,
                    overflowY: "auto",
                  }}
                >
                  {composed || "（所有组件均已禁用）"}
                </pre>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  marginBottom: 8,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 9,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
};

const textareaStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 9,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  resize: "vertical",
  fontFamily: "inherit",
};

const primaryBtnStyle: CSSProperties = {
  padding: "8px 14px",
  border: "none",
  borderRadius: 9,
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const iconBtnStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 18,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const closeBtnStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 18,
  flexShrink: 0,
};

const sidebarBtnStyle: CSSProperties = {
  padding: "5px 8px",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  display: "flex",
  alignItems: "center",
  gap: 4,
  flex: 1,
  justifyContent: "center",
};
