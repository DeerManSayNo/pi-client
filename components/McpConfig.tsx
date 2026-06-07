"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type McpTransport = "stdio" | "sse" | "http";
interface McpServerConfig { id: string; name: string; enabled: boolean; transport: McpTransport; command?: string; args?: string[]; url?: string; env?: Record<string, string>; description?: string; createdAt: string; updatedAt: string }

function makeServer(): McpServerConfig { return { id: `local_${Date.now()}`, name: "新 MCP 服务", enabled: true, transport: "stdio", command: "", args: [], url: "", env: {}, description: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
function argsText(s: McpServerConfig) { return (s.args ?? []).join("\n"); }
function envText(s: McpServerConfig) { return Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"); }
function parseLines(text: string) { return text.split(/\n+/).map((v) => v.trim()).filter(Boolean); }
function parseEnv(text: string) { return Object.fromEntries(text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => { const i = line.indexOf("="); return i >= 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : [line, ""]; })); }

export function McpConfig({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/mcp-config", { cache: "no-store" });
      if (res.ok) {
        const list = ((await res.json()) as { servers?: McpServerConfig[] }).servers ?? [];
        setServers(list); setSelectedId((id) => id && list.some((s) => s.id === id) ? id : (list[0]?.id ?? null));
      }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const selected = useMemo(() => servers.find((s) => s.id === selectedId) ?? servers[0] ?? null, [selectedId, servers]);
  const updateSelected = (patch: Partial<McpServerConfig>) => setServers((list) => list.map((s) => s.id === selected?.id ? { ...s, ...patch } : s));
  const add = () => { const s = makeServer(); setServers((list) => [...list, s]); setSelectedId(s.id); };
  const remove = () => { if (!selected) return; setServers((list) => list.filter((s) => s.id !== selected.id)); setSelectedId(servers.find((s) => s.id !== selected.id)?.id ?? null); };
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/mcp-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ servers }) });
      if (res.ok) {
        const list = ((await res.json()) as { servers: McpServerConfig[] }).servers;
        setServers(list); setSelectedId((id) => id && list.some((s) => s.id === id) ? id : (list[0]?.id ?? null));
      }
    } finally { setSaving(false); }
  }, [servers]);

  return <div role="dialog" aria-modal="true" aria-label="MCP" style={overlayStyle} onClick={onClose}>
    <div onClick={(e) => e.stopPropagation()} style={modalStyle}>
      <aside style={asideStyle}>
        <div style={asideHeaderStyle}><div><div style={titleStyle}>MCP</div><div style={subStyle}>Model Context Protocol</div></div><button onClick={add} style={smallBtnStyle}>+</button></div>
        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>{loading ? <div style={emptyStyle}>加载中...</div> : servers.length === 0 ? <div style={emptyStyle}>暂无 MCP 服务</div> : servers.map((server) => {
          const active = server.id === selected?.id;
          return <button key={server.id} onClick={() => setSelectedId(server.id)} style={{ ...scopeBtnStyle, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ width: 8, height: 8, borderRadius: 99, background: server.enabled ? "#22c55e" : "var(--text-dim)" }} /><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: active ? 800 : 600 }}>{server.name}</span><span style={pillStyle}>{server.transport}</span></div>
            <div style={scopeMetaStyle}>{server.description || (server.transport === "stdio" ? server.command || "未配置命令" : server.url || "未配置 URL")}</div>
          </button>;
        })}</div>
      </aside>
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={mainHeaderStyle}><div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{selected?.name ?? "MCP 服务配置"}</div><div style={subStyle}>配置会保存到 ~/.deerhux/agent/mcp.json；后续可由 Agent 运行时读取接入。</div></div>{selected && <button onClick={remove} style={dangerBtnStyle}>删除</button>}<button onClick={save} disabled={saving} style={{ ...primaryBtnStyle, opacity: saving ? 0.5 : 1 }}>{saving ? "保存中..." : "保存"}</button><button onClick={onClose} style={closeBtnStyle}>×</button></div>
        {!selected ? <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}><button onClick={add} style={primaryBtnStyle}>创建第一个 MCP 服务</button></div> : <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}><label style={labelStyle}>服务名称<input value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} style={inputStyle} /></label><label style={labelStyle}>传输类型<select value={selected.transport} onChange={(e) => updateSelected({ transport: e.target.value as McpTransport })} style={inputStyle}><option value="stdio">stdio</option><option value="sse">sse</option><option value="http">http</option></select></label></div>
          <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, margin: "4px 0 12px" }}><input type="checkbox" checked={selected.enabled} onChange={(e) => updateSelected({ enabled: e.target.checked })} />启用该服务</label>
          <label style={labelStyle}>描述<input value={selected.description ?? ""} onChange={(e) => updateSelected({ description: e.target.value })} style={inputStyle} /></label>
          {selected.transport === "stdio" ? <><label style={labelStyle}>Command<input value={selected.command ?? ""} onChange={(e) => updateSelected({ command: e.target.value })} placeholder="例如：npx" style={inputStyle} /></label><label style={labelStyle}>Args（每行一个参数）<textarea value={argsText(selected)} onChange={(e) => updateSelected({ args: parseLines(e.target.value) })} rows={5} placeholder="-y\n@modelcontextprotocol/server-filesystem\n/Users/me/project" style={textareaStyle} /></label></> : <label style={labelStyle}>URL<input value={selected.url ?? ""} onChange={(e) => updateSelected({ url: e.target.value })} placeholder="https://..." style={inputStyle} /></label>}
          <label style={labelStyle}>环境变量（每行 KEY=VALUE）<textarea value={envText(selected)} onChange={(e) => updateSelected({ env: parseEnv(e.target.value) })} rows={5} placeholder="API_KEY=..." style={textareaStyle} /></label>
        </div>}
      </main>
    </div>
  </div>;
}

const overlayStyle: CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", padding: 20 };
const modalStyle: CSSProperties = { width: "min(1040px, calc(100vw - 40px))", height: "min(780px, calc(100vh - 40px))", border: "1px solid var(--border)", borderRadius: 16, background: "var(--bg)", boxShadow: "0 18px 60px rgba(0,0,0,0.28)", overflow: "hidden", display: "flex" };
const asideStyle: CSSProperties = { width: 280, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" };
const asideHeaderStyle: CSSProperties = { padding: 16, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const titleStyle: CSSProperties = { fontSize: 16, fontWeight: 800, color: "var(--text)" };
const subStyle: CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 3 };
const scopeBtnStyle: CSSProperties = { width: "100%", display: "block", textAlign: "left", padding: "10px 11px", border: "none", borderRadius: 10, cursor: "pointer", marginBottom: 4 };
const scopeMetaStyle: CSSProperties = { marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const pillStyle: CSSProperties = { fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 6px" };
const mainHeaderStyle: CSSProperties = { padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 };
const labelStyle: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 12 };
const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: 6, padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 };
const textareaStyle: CSSProperties = { ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono)", fontSize: 12 };
const emptyStyle: CSSProperties = { padding: 12, color: "var(--text-muted)", fontSize: 12 };
const smallBtnStyle: CSSProperties = { width: 30, height: 30, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 18 };
const primaryBtnStyle: CSSProperties = { padding: "8px 12px", borderRadius: 9, border: "1px solid var(--accent)", background: "var(--accent)", color: "white", cursor: "pointer", fontSize: 12, fontWeight: 700 };
const dangerBtnStyle: CSSProperties = { padding: "8px 10px", borderRadius: 9, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.08)", color: "#ef4444", cursor: "pointer", fontSize: 12 };
const closeBtnStyle: CSSProperties = { width: 30, height: 30, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 };
