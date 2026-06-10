export type ExtensionSource =
  | "builtin-deerhux"
  | "builtin-pi"
  | "global-deerhux"
  | "global-pi"
  | "project-deerhux"
  | "project-pi"
  | "project-agents"
  | "package"
  | "pi-runtime"
  | "mcp";

export interface ExtensionDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  source?: ExtensionSource;
  filePath?: string;
  detail?: unknown;
}

export interface SkillView {
  id: string;
  name: string;
  description?: string;
  filePath: string;
  baseDir?: string;
  enabled: boolean;
  disableModelInvocation?: boolean;
  source: ExtensionSource;
  sourceLabel?: string;
  canDelete: boolean;
  canImportToDeerHux: boolean;
  frontmatter?: Record<string, unknown>;
}

export interface McpServerView {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  description?: string;
  source: ExtensionSource;
  configPath?: string;
  canEdit: boolean;
  canDelete: boolean;
  canImportToDeerHux: boolean;
  runtimeStatus?: "connected" | "error" | "unsupported" | "disabled" | "unknown";
  runtimeToolCount?: number;
  runtimeErrorMessage?: string;
}

export interface ToolView {
  name: string;
  label?: string;
  description?: string;
  enabled: boolean;
  source: ExtensionSource;
  provider?: "builtin" | "code_search" | "mcp" | "pi-extension";
}

export interface RoleView {
  id: string;
  name: string;
  description?: string;
  source: ExtensionSource;
  canEdit: boolean;
  canDelete: boolean;
}

export interface LoadedExtensionsView {
  skills: SkillView[];
  mcpServers: McpServerView[];
  tools: ToolView[];
  roles: RoleView[];
  diagnostics: ExtensionDiagnostic[];
}
