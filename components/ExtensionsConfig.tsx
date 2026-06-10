"use client";

import { useEffect, useMemo, useState } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { LoadedExtensionsView } from "@/lib/extensions/types";

function Panel({ title, count, children }: { title: string; count: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg)", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{count}</span>
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 2px" }}>{text}</div>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 10, color: "var(--text-dim)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 999, padding: "2px 7px" }}>{children}</span>;
}

export function ExtensionsConfig({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  useEscapeClose(onClose);

  const [data, setData] = useState<LoadedExtensionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}&mcpRuntime=1`)
      .then((res) => res.ok ? res.json() : res.json().then((d) => Promise.reject(new Error(d.error ?? `HTTP ${res.status}`))))
      .then((json: LoadedExtensionsView) => setData(json))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => {
    if (!data) return null;
    return {
      skillsEnabled: data.skills.filter((s) => s.enabled).length,
      mcpEnabled: data.mcpServers.filter((s) => s.enabled).length,
      toolsEnabled: data.tools.filter((t) => t.enabled).length,
      warnings: data.diagnostics.filter((d) => d.level !== "info").length,
    };
  }, [data]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.28)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onMouseDown={onClose}>
      <div style={{ width: "min(980px, 96vw)", maxHeight: "88vh", overflow: "hidden", borderRadius: 16, background: "var(--bg-panel)", border: "1px solid var(--border)", boxShadow: "0 24px 80px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column" }} onMouseDown={(e) => e.stopPropagation()}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: "1px solid var(--border)" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>扩展总览</h2>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 700 }}>{cwd}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={load} disabled={loading} style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", borderRadius: 8, padding: "7px 10px", cursor: loading ? "wait" : "pointer" }}>刷新</button>
            <button onClick={onClose} style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 8, padding: "7px 10px", cursor: "pointer" }}>关闭</button>
          </div>
        </header>

        <div style={{ overflow: "auto", padding: 18, display: "grid", gap: 14 }}>
          {loading && <Empty text="正在加载扩展..." />}
          {error && <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>}
          {data && summary && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                <Panel title="Skills" count={`${summary.skillsEnabled}/${data.skills.length} 启用`}><Empty text="来自 Pi ResourceLoader 的实际加载结果" /></Panel>
                <Panel title="MCP 服务" count={`${summary.mcpEnabled}/${data.mcpServers.length} 启用`}><Empty text="显示配置来源与实时连接状态；http/sse 暂标记未支持" /></Panel>
                <Panel title="Tools" count={`${summary.toolsEnabled}/${data.tools.length} 可用`}><Empty text="包含内置工具与 DeerHux code_search" /></Panel>
                <Panel title="Diagnostics" count={`${summary.warnings} 条需关注`}><Empty text="Pi loader / facade 诊断信息" /></Panel>
              </div>

              <Panel title="Skills" count={`${data.skills.length} 个`}>
                {data.skills.length === 0 ? <Empty text="暂无 skills" /> : <div style={{ display: "grid", gap: 8 }}>
                  {data.skills.map((skill) => (
                    <div key={skill.filePath} style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: skill.enabled ? "var(--accent)" : "var(--border)", flexShrink: 0 }} />
                      <strong style={{ fontSize: 13 }}>{skill.name}</strong>
                      <Tag>{skill.sourceLabel ?? skill.source}</Tag>
                      {skill.canDelete && <Tag>可管理</Tag>}
                      {skill.canImportToDeerHux && <Tag>可导入</Tag>}
                      <span title={skill.filePath} style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{skill.filePath}</span>
                    </div>
                  ))}
                </div>}
              </Panel>

              <Panel title="MCP 服务" count={`${data.mcpServers.length} 个`}>
                {data.mcpServers.length === 0 ? <Empty text="暂无 MCP 服务配置" /> : <div style={{ display: "grid", gap: 8 }}>
                  {data.mcpServers.map((server) => {
                    const runtimeStatus = server.runtimeStatus ?? (server.enabled ? "unknown" : "disabled");
                    const dotColor = runtimeStatus === "connected" ? "#22c55e" : runtimeStatus === "error" ? "#ef4444" : runtimeStatus === "unsupported" ? "#f59e0b" : server.enabled ? "var(--accent)" : "var(--border)";
                    return <div key={server.id} style={{ display: "grid", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: dotColor, flexShrink: 0 }} />
                        <strong style={{ fontSize: 13 }}>{server.name}</strong>
                        <Tag>{server.transport}</Tag>
                        <Tag>{runtimeStatus}</Tag>
                        {typeof server.runtimeToolCount === "number" && <Tag>{server.runtimeToolCount} tools</Tag>}
                        {server.envKeys?.length ? <Tag>env: {server.envKeys.join(", ")}</Tag> : null}
                        <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{server.description}</span>
                      </div>
                      {server.runtimeErrorMessage && <div style={{ marginLeft: 16, color: "#f87171", fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" }}>{server.runtimeErrorMessage}</div>}
                    </div>;
                  })}
                </div>}
              </Panel>

              <Panel title="Tools / Roles" count={`${data.tools.length} tools · ${data.roles.length} roles`}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {data.tools.map((tool) => <Tag key={tool.name}>{tool.enabled ? "●" : "○"} {tool.name}</Tag>)}
                  {data.roles.map((role) => <Tag key={role.id}>role: {role.name}</Tag>)}
                </div>
              </Panel>

              {data.diagnostics.length > 0 && (
                <Panel title="Diagnostics" count={`${data.diagnostics.length} 条`}>
                  <div style={{ display: "grid", gap: 6 }}>
                    {data.diagnostics.map((d, i) => <div key={i} style={{ fontSize: 12, color: d.level === "error" ? "#f87171" : d.level === "warning" ? "#f59e0b" : "var(--text-dim)" }}>{d.level}: {d.message}</div>)}
                  </div>
                </Panel>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
