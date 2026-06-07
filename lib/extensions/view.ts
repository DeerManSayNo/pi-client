import path from "path";
import { DefaultResourceLoader, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { readRoles } from "@/lib/roles";
import { indexExists } from "@/lib/code-index/database";
import { isManagedDeerHuxSkillFile } from "./config";
import { loadMcpServerViews } from "./mcp";
import type { ExtensionDiagnostic, ExtensionSource, LoadedExtensionsView, SkillView, ToolView } from "./types";

type PiSkillLike = {
  name: string;
  description?: string;
  filePath: string;
  baseDir?: string;
  disableModelInvocation?: boolean;
  sourceInfo?: { source?: string; scope?: string };
  frontmatter?: Record<string, unknown>;
};

type PiDiagnosticLike = {
  level?: string;
  message?: string;
  filePath?: string;
  source?: string;
  detail?: unknown;
};

const BUILTIN_TOOLS: ToolView[] = [
  { name: "read", label: "Read", description: "Read file contents", enabled: true, source: "builtin-pi", provider: "builtin" },
  { name: "bash", label: "Bash", description: "Execute shell commands", enabled: true, source: "builtin-pi", provider: "builtin" },
  { name: "edit", label: "Edit", description: "Edit files using exact replacements", enabled: true, source: "builtin-pi", provider: "builtin" },
  { name: "write", label: "Write", description: "Create or overwrite files", enabled: true, source: "builtin-pi", provider: "builtin" },
  { name: "grep", label: "Grep", description: "Search text with grep", enabled: true, source: "builtin-pi", provider: "builtin" },
  { name: "find", label: "Find", description: "Find files and directories", enabled: true, source: "builtin-pi", provider: "builtin" },
  { name: "ls", label: "List", description: "List directory contents", enabled: true, source: "builtin-pi", provider: "builtin" },
];

function normalizeDiagnostic(raw: unknown): ExtensionDiagnostic {
  const d = (raw ?? {}) as PiDiagnosticLike;
  const level = d.level === "error" || d.level === "warning" || d.level === "info" ? d.level : "warning";
  return {
    level,
    message: typeof d.message === "string" ? d.message : String(raw),
    filePath: typeof d.filePath === "string" ? d.filePath : undefined,
    source: "pi-runtime",
    detail: d.detail,
  };
}

function skillSource(skill: PiSkillLike, cwd: string): ExtensionSource {
  const filePath = path.resolve(skill.filePath);
  const scope = skill.sourceInfo?.scope;
  const src = skill.sourceInfo?.source;
  if (src && src !== "auto" && src !== "local" && src !== "project" && src !== "user") return "package";
  if (filePath.includes(`${path.sep}.deerhux${path.sep}`)) return scope === "project" || filePath.startsWith(path.resolve(cwd)) ? "project-deerhux" : "global-deerhux";
  if (filePath.includes(`${path.sep}.pi${path.sep}`)) return scope === "project" || filePath.startsWith(path.resolve(cwd)) ? "project-pi" : "global-pi";
  if (filePath.includes(`${path.sep}.agents${path.sep}`)) return "project-agents";
  if (scope === "project") return "project-deerhux";
  if (scope === "user") return "global-deerhux";
  return "pi-runtime";
}

function sourceLabel(source: ExtensionSource): string {
  switch (source) {
    case "global-deerhux": return "全局 DeerHux";
    case "project-deerhux": return "项目 DeerHux";
    case "global-pi": return "全局 Pi";
    case "project-pi": return "项目 Pi";
    case "project-agents": return "项目 .agents";
    case "package": return "Package";
    case "mcp": return "MCP";
    case "builtin-pi": return "Pi 内置";
    case "builtin-deerhux": return "DeerHux 内置";
    default: return "Pi Runtime";
  }
}

function loadCompatibleSkillSources(cwd: string, existingFilePaths: Set<string>, diagnostics: ExtensionDiagnostic[]): SkillView[] {
  const dirs: Array<{ dir: string; source: ExtensionSource }> = [
    { dir: path.join(homedir(), ".pi", "agent", "skills"), source: "global-pi" },
    { dir: path.join(cwd, ".pi", "skills"), source: "project-pi" },
    { dir: path.join(cwd, ".agents", "skills"), source: "project-agents" },
  ];
  const result: SkillView[] = [];

  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const filePath = path.join(dir, entry.name, "SKILL.md");
        if (!existsSync(filePath) || existingFilePaths.has(path.resolve(filePath))) continue;
        let description = "";
        let disableModelInvocation = false;
        let frontmatter: Record<string, unknown> | undefined;
        try {
          const parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(filePath, "utf8"));
          frontmatter = parsed.frontmatter;
          description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "";
          disableModelInvocation = Boolean(parsed.frontmatter["disable-model-invocation"]);
        } catch (error) {
          diagnostics.push({ level: "warning", message: `读取兼容 skill 失败: ${entry.name}`, source, filePath, detail: String(error) });
        }
        result.push({
          id: entry.name,
          name: entry.name,
          description,
          filePath,
          baseDir: dir,
          enabled: !disableModelInvocation,
          disableModelInvocation,
          source,
          sourceLabel: sourceLabel(source),
          canDelete: false,
          canImportToDeerHux: true,
          frontmatter,
        });
      }
    } catch (error) {
      diagnostics.push({ level: "warning", message: `扫描兼容 skills 失败: ${dir}`, source, filePath: dir, detail: String(error) });
    }
  }

  return result;
}

export async function loadExtensionsView(cwd: string): Promise<LoadedExtensionsView> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const skillResult = loader.getSkills() as { skills?: PiSkillLike[]; diagnostics?: unknown[] };

  diagnostics.push(...(skillResult.diagnostics ?? []).map(normalizeDiagnostic));

  const skills: SkillView[] = (skillResult.skills ?? []).map((skill) => {
    const source = skillSource(skill, cwd);
    return {
      id: skill.name,
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      enabled: !skill.disableModelInvocation,
      disableModelInvocation: Boolean(skill.disableModelInvocation),
      source,
      sourceLabel: sourceLabel(source),
      canDelete: isManagedDeerHuxSkillFile(skill.filePath, cwd),
      canImportToDeerHux: source === "global-pi" || source === "project-pi" || source === "project-agents",
      frontmatter: skill.frontmatter,
    };
  });
  const runtimeSkillPaths = new Set(skills.map((skill) => path.resolve(skill.filePath)));
  skills.push(...loadCompatibleSkillSources(cwd, runtimeSkillPaths, diagnostics));

  const mcpServers = loadMcpServerViews(cwd, diagnostics);

  const tools: ToolView[] = [...BUILTIN_TOOLS];
  tools.push({
    name: "code_search",
    label: "Code Search",
    description: "Search the pre-built code index",
    enabled: indexExists(cwd),
    source: "builtin-deerhux",
    provider: "code_search",
  });

  const roles = readRoles(cwd).map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    source: role.sourceInfo?.scope === "builtIn" ? "builtin-deerhux" as const : role.sourceInfo?.scope === "project" ? "project-deerhux" as const : "global-deerhux" as const,
    canEdit: !role.builtIn || role.sourceInfo?.scope === "user",
    canDelete: Boolean(role.canDelete),
  }));

  return { skills, mcpServers, tools, roles, diagnostics };
}
