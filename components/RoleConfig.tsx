"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { SystemPromptConfig } from "./SystemPromptConfig";

interface RoleSetting { id: string; text: string; createdAt: string }
interface AgentRole {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  blocks: Record<string, RoleSetting[]>;
  builtIn?: boolean;
}

const BLOCKS = ["Identity", "Soul", "Rules", "User", "Tools", "Memory"] as const;
const BLOCK_LABELS: Record<string, string> = {
  Identity: "身份与职责",
  Soul: "语气与风格",
  Rules: "行为规则",
  User: "用户偏好",
  Tools: "工具使用规则",
  Memory: "角色长期记忆",
};

function cloneBlocks(blocks: Record<string, RoleSetting[]>): Record<string, RoleSetting[]> {
  const next: Record<string, RoleSetting[]> = {};
  for (const block of BLOCKS) next[block] = [...(blocks?.[block] ?? [])].map((s) => ({ ...s }));
  return next;
}

function notifyRolesUpdated() {
  window.dispatchEvent(new Event("pi-agent.roles-updated"));
}

export function RoleConfig({ onClose, cwd }: { onClose: () => void; cwd?: string }) {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState("default");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<AgentRole | null>(null);
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [systemPromptRole, setSystemPromptRole] = useState<AgentRole | null>(null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newBasePrompt, setNewBasePrompt] = useState("");

  const loadRoles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/roles", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as { roles: AgentRole[] };
      const list = data.roles ?? [];
      setRoles(list);
      setSelectedRoleId((id) => list.some((r) => r.id === id) ? id : (list[0]?.id ?? "default"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRoles(); }, [loadRoles]);

  useEffect(() => {
    const handler = () => { loadRoles(); };
    window.addEventListener("pi-agent.roles-updated", handler);
    return () => window.removeEventListener("pi-agent.roles-updated", handler);
  }, [loadRoles]);

  const selectedRole = useMemo(() => roles.find((r) => r.id === selectedRoleId) ?? roles[0] ?? null, [roles, selectedRoleId]);

  useEffect(() => {
    if (!selectedRole) {
      setDraft(null);
      return;
    }
    setDraft({ ...selectedRole, blocks: cloneBlocks(selectedRole.blocks) });
  }, [selectedRole]);

  const settingCount = (role: AgentRole) => Object.values(role.blocks ?? {}).reduce((n, arr) => n + (arr?.length ?? 0), 0);

  const createRole = useCallback(async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, description: newDescription, basePrompt: newBasePrompt }),
      });
      if (!res.ok) return;
      const data = await res.json() as { role: AgentRole };
      setNewName(""); setNewDescription(""); setNewBasePrompt(""); setNewRoleOpen(false);
      await loadRoles();
      notifyRolesUpdated();
      setSelectedRoleId(data.role.id);
    } finally {
      setSaving(false);
    }
  }, [newName, newDescription, newBasePrompt, loadRoles]);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/roles/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          basePrompt: draft.basePrompt,
          blocks: draft.blocks,
        }),
      });
      if (!res.ok) return;
      await loadRoles();
      notifyRolesUpdated();
    } finally {
      setSaving(false);
    }
  }, [draft, loadRoles]);

  const deleteSelectedRole = useCallback(async () => {
    if (!selectedRole || selectedRole.id === "default") return;
    if (!window.confirm(`确定删除角色「${selectedRole.name}」吗？角色设定库也会一起删除。`)) return;
    setSaving(true);
    try {
      await fetch(`/api/roles/${encodeURIComponent(selectedRole.id)}`, { method: "DELETE" });
      setSelectedRoleId("default");
      await loadRoles();
      notifyRolesUpdated();
    } finally {
      setSaving(false);
    }
  }, [selectedRole, loadRoles]);

  const updateDraftBlock = (block: string, updater: (items: RoleSetting[]) => RoleSetting[]) => {
    setDraft((prev) => prev ? { ...prev, blocks: { ...prev.blocks, [block]: updater(prev.blocks[block] ?? []) } } : prev);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="角色"
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", padding: 20 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(1040px, calc(100vw - 40px))", height: "min(780px, calc(100vh - 40px))", border: "1px solid var(--border)", borderRadius: 16, background: "var(--bg)", boxShadow: "0 18px 60px rgba(0,0,0,0.28)", overflow: "hidden", display: "flex" }}
      >
        <aside style={{ width: 280, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text)" }}>角色</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>Agent Profile</div>
            </div>
            <button onClick={() => setNewRoleOpen((v) => !v)} style={{ width: 30, height: 30, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 18 }}>+</button>
          </div>
          {newRoleOpen && (
            <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="角色名称" style={inputStyle} />
              <input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="角色描述" style={inputStyle} />
              <textarea value={newBasePrompt} onChange={(e) => setNewBasePrompt(e.target.value)} placeholder="基础设定，可选" rows={3} style={textareaStyle} />
              <button onClick={createRole} disabled={!newName.trim() || saving} style={{ ...primaryBtnStyle, width: "100%", opacity: !newName.trim() || saving ? 0.5 : 1 }}>创建角色</button>
            </div>
          )}
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
            {loading ? <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>加载中...</div> : roles.map((role) => {
              const active = role.id === selectedRoleId;
              return (
                <button key={role.id} onClick={() => setSelectedRoleId(role.id)} style={{ width: "100%", display: "block", textAlign: "left", padding: "10px 11px", border: "none", borderRadius: 10, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: active ? 700 : 500 }}>{role.name}</span>
                    {role.builtIn && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>内置</span>}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{settingCount(role)} 条设定 · {role.description || "无描述"}</div>
                </button>
              );
            })}
          </div>
        </aside>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{draft?.name ?? "角色设定库"}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>按分块管理会跨 session 复用的角色设定</div>
            </div>
            {selectedRole && !selectedRole.builtIn && selectedRole.id !== "default" && <button onClick={deleteSelectedRole} disabled={saving} style={dangerBtnStyle}>删除角色</button>}
            {selectedRole && <button onClick={() => setSystemPromptRole(selectedRole)} style={secondaryBtnStyle}>System Prompt 管理</button>}
            <button onClick={saveDraft} disabled={!draft || saving} style={{ ...primaryBtnStyle, opacity: !draft || saving ? 0.5 : 1 }}>{saving ? "保存中..." : "保存"}</button>
            <button onClick={onClose} style={closeBtnStyle}>×</button>
          </div>

          {!draft ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>请选择角色</div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
                <label style={labelStyle}>角色名称<input value={draft.name} onChange={(e) => setDraft((p) => p ? { ...p, name: e.target.value } : p)} style={inputStyle} /></label>
                <label style={labelStyle}>角色描述<input value={draft.description} onChange={(e) => setDraft((p) => p ? { ...p, description: e.target.value } : p)} style={inputStyle} /></label>
              </div>
              <label style={labelStyle}>基础系统提示词<textarea value={draft.basePrompt} onChange={(e) => setDraft((p) => p ? { ...p, basePrompt: e.target.value } : p)} rows={4} style={textareaStyle} /></label>

              {BLOCKS.map((block) => (
                <section key={block} style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)" }}>{block} / {BLOCK_LABELS[block]}</div>
                      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{draft.blocks[block]?.length ?? 0} 条设定</div>
                    </div>
                    <button onClick={() => updateDraftBlock(block, (items) => [...items, { id: `local_${Date.now()}`, text: "", createdAt: new Date().toISOString() }])} style={secondaryBtnStyle}>+ 新增</button>
                  </div>
                  {(draft.blocks[block] ?? []).length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 0" }}>暂无设定</div>}
                  {(draft.blocks[block] ?? []).map((setting, index) => (
                    <div key={setting.id} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <textarea value={setting.text} onChange={(e) => updateDraftBlock(block, (items) => items.map((s, i) => i === index ? { ...s, text: e.target.value } : s))} rows={2} style={{ ...textareaStyle, marginBottom: 0 }} />
                      <button onClick={() => updateDraftBlock(block, (items) => items.filter((_, i) => i !== index))} style={{ ...dangerBtnStyle, alignSelf: "stretch" }}>删除</button>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </main>
      </div>
      {systemPromptRole && (
        <div onClick={(e) => e.stopPropagation()}>
          <SystemPromptConfig
            roleId={systemPromptRole.id}
            roleName={systemPromptRole.name}
            cwd={cwd}
            onClose={() => setSystemPromptRole(null)}
          />
        </div>
      )}
    </div>
  );
}

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
  ...inputStyle,
  resize: "vertical",
  lineHeight: 1.5,
  fontFamily: "inherit",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text-muted)",
};

const primaryBtnStyle: CSSProperties = {
  padding: "8px 12px",
  border: "none",
  borderRadius: 9,
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
};

const secondaryBtnStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
};

const dangerBtnStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid rgba(239,68,68,0.35)",
  borderRadius: 8,
  background: "rgba(239,68,68,0.06)",
  color: "#ef4444",
  cursor: "pointer",
  fontSize: 12,
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
};
