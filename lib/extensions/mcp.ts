import { existsSync, readFileSync } from "fs";
import path from "path";
import { homedir } from "os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionDiagnostic, ExtensionSource, McpServerView } from "./types";

interface RawDeerHuxMcpServer {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: unknown;
  description?: unknown;
}

interface NormalizedMcpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  description?: string;
  source: ExtensionSource;
  configPath: string;
  priority: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function normalizeTransport(value: unknown): "stdio" | "sse" | "http" {
  return value === "sse" || value === "http" ? value : "stdio";
}

function envKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).filter((key) => typeof value[key] === "string") : [];
}

function readJson(filePath: string): unknown | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function normalizeServer(raw: RawDeerHuxMcpServer, fallbackId: string, source: ExtensionSource, configPath: string, priority: number): NormalizedMcpServer | null {
  const id = asString(raw.id) || fallbackId;
  const name = asString(raw.name) || id;
  if (!id || !name) return null;
  return {
    id,
    name,
    enabled: raw.enabled !== false,
    transport: normalizeTransport(raw.transport),
    command: asString(raw.command),
    args: asStringArray(raw.args) ?? [],
    url: asString(raw.url),
    envKeys: envKeys(raw.env),
    description: asString(raw.description) ?? "",
    source,
    configPath,
    priority,
  };
}

function readServersFromFile(configPath: string, source: ExtensionSource, priority: number, diagnostics: ExtensionDiagnostic[]): NormalizedMcpServer[] {
  const parsed = readJson(configPath);
  if (!parsed) return [];
  if (!isRecord(parsed)) {
    diagnostics.push({ level: "warning", message: "MCP 配置不是 JSON object", source, filePath: configPath });
    return [];
  }

  const servers: NormalizedMcpServer[] = [];

  // DeerHux format: { version: 1, servers: [...] }
  if (Array.isArray(parsed.servers)) {
    for (const item of parsed.servers) {
      if (!isRecord(item)) continue;
      const fallbackId = asString(item.name) || `server_${servers.length + 1}`;
      const normalized = normalizeServer(item, fallbackId, source, configPath, priority);
      if (normalized) servers.push(normalized);
    }
  }

  // Common MCP format: { mcpServers: { id: { command, args, env } } }
  if (isRecord(parsed.mcpServers)) {
    for (const [id, item] of Object.entries(parsed.mcpServers)) {
      if (!isRecord(item)) continue;
      const normalized = normalizeServer({ id, name: id, enabled: true, transport: "stdio", ...item }, id, source, configPath, priority);
      if (normalized) servers.push(normalized);
    }
  }

  if (servers.length === 0) {
    diagnostics.push({ level: "info", message: "MCP 配置未发现 servers 或 mcpServers", source, filePath: configPath });
  }

  return servers;
}

export function loadMcpServerViews(cwd: string, diagnostics: ExtensionDiagnostic[]): McpServerView[] {
  const sources: Array<{ filePath: string; source: ExtensionSource; priority: number; canEdit: boolean; canDelete: boolean; canImportToDeerHux: boolean }> = [
    { filePath: path.join(homedir(), ".pi", "agent", "mcp.json"), source: "global-pi", priority: 1, canEdit: false, canDelete: false, canImportToDeerHux: true },
    { filePath: path.join(getAgentDir(), "mcp.json"), source: "global-deerhux", priority: 2, canEdit: true, canDelete: true, canImportToDeerHux: false },
    { filePath: path.join(cwd, ".pi", "mcp.json"), source: "project-pi", priority: 3, canEdit: false, canDelete: false, canImportToDeerHux: true },
    { filePath: path.join(cwd, ".deerhux", "mcp.json"), source: "project-deerhux", priority: 4, canEdit: true, canDelete: true, canImportToDeerHux: false },
  ];

  const byId = new Map<string, NormalizedMcpServer & { canEdit: boolean; canDelete: boolean; canImportToDeerHux: boolean }>();
  for (const source of sources) {
    const servers = readServersFromFile(source.filePath, source.source, source.priority, diagnostics);
    for (const server of servers) {
      const existing = byId.get(server.id);
      if (existing && existing.priority > server.priority) continue;
      byId.set(server.id, {
        ...server,
        canEdit: source.canEdit,
        canDelete: source.canDelete,
        canImportToDeerHux: source.canImportToDeerHux,
      });
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    .map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      envKeys: server.envKeys,
      description: server.description,
      source: server.source,
      configPath: server.configPath,
      canEdit: server.canEdit,
      canDelete: server.canDelete,
      canImportToDeerHux: server.canImportToDeerHux,
    }));
}
