import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const ROLE_BLOCKS = ["Identity", "Soul", "Rules", "User", "Tools", "Memory"] as const;
export type RoleBlock = typeof ROLE_BLOCKS[number];

export interface RoleSetting {
  id: string;
  text: string;
  createdAt: string;
}

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  blocks: Record<RoleBlock, RoleSetting[]>;
  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RolesFile {
  version: 1;
  roles: AgentRole[];
}

const BLOCK_TITLES: Record<RoleBlock, string> = {
  Identity: "身份与职责",
  Soul: "语气与风格",
  Rules: "行为规则",
  User: "用户偏好",
  Tools: "工具使用规则",
  Memory: "角色长期记忆",
};

function emptyBlocks(): Record<RoleBlock, RoleSetting[]> {
  return {
    Identity: [],
    Soul: [],
    Rules: [],
    User: [],
    Tools: [],
    Memory: [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function uid(prefix = "role"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const DEFAULT_ROLE_ID = "default";

const BUILT_IN_ROLES: AgentRole[] = [
  {
    id: DEFAULT_ROLE_ID,
    name: "默认角色",
    description: "通用任务，清晰、准确地帮助用户完成目标。",
    basePrompt: "你是一个 helpful coding assistant。回答清晰、准确，优先帮助用户完成任务。",
    blocks: emptyBlocks(),
    builtIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "coding-expert",
    name: "编程专家",
    description: "擅长阅读代码、定位问题、设计架构和实现功能。",
    basePrompt: "你是一个资深全栈工程师，擅长阅读代码、定位问题、设计架构和实现功能。回答应直接、严谨，优先给出可执行方案。修改代码前先理解项目结构，避免不必要的大改。",
    blocks: emptyBlocks(),
    builtIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "ui-ux-designer",
    name: "UI/UX 设计师",
    description: "擅长信息架构、交互设计、视觉层级和可用性优化。",
    basePrompt: "你是一个资深 UI/UX 设计师，擅长信息架构、交互设计、视觉层级和可用性优化。回答时应提供多个设计方案，并说明优缺点。关注可访问性、响应式布局、视觉一致性和用户操作成本。",
    blocks: emptyBlocks(),
    builtIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "product-manager",
    name: "产品经理",
    description: "擅长需求拆解、功能规划、用户路径设计和优先级判断。",
    basePrompt: "你是一个资深产品经理，擅长需求拆解、功能规划、用户路径设计和优先级判断。回答时应关注用户价值、实现成本、边界情况和迭代路径。",
    blocks: emptyBlocks(),
    builtIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "code-reviewer",
    name: "代码审查员",
    description: "严格检查正确性、可维护性、安全性、性能和边界情况。",
    basePrompt: "你是一个严格的代码审查员。重点检查正确性、可维护性、安全性、性能和边界情况。发现问题时直接指出，并给出具体修改建议。",
    blocks: emptyBlocks(),
    builtIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
  {
    id: "readonly-analyst",
    name: "只读分析师",
    description: "只阅读、分析和解释代码，不主动修改文件。",
    basePrompt: "你是一个代码分析助手。你只能阅读、分析和解释代码，不主动修改文件。如果用户要求修改代码，应先给出修改方案，等待确认。",
    blocks: emptyBlocks(),
    builtIn: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  },
];

export function rolesFilePath(): string {
  return path.join(getAgentDir(), "roles.json");
}

function normalizeRole(raw: Partial<AgentRole>): AgentRole | null {
  if (!raw.id || !raw.name) return null;
  const blocks = emptyBlocks();
  for (const block of ROLE_BLOCKS) {
    const items = raw.blocks?.[block];
    blocks[block] = Array.isArray(items)
      ? items.filter((s): s is RoleSetting => Boolean(s?.id && s?.text)).map((s) => ({ id: s.id, text: s.text, createdAt: s.createdAt ?? nowIso() }))
      : [];
  }
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? "",
    basePrompt: raw.basePrompt ?? "",
    blocks,
    builtIn: raw.builtIn,
    createdAt: raw.createdAt ?? nowIso(),
    updatedAt: raw.updatedAt ?? nowIso(),
  };
}

export function readRoles(): AgentRole[] {
  let custom: AgentRole[] = [];
  const file = rolesFilePath();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as RolesFile;
      custom = (parsed.roles ?? []).map(normalizeRole).filter((r): r is AgentRole => Boolean(r));
    } catch {
      custom = [];
    }
  }

  const byId = new Map<string, AgentRole>();
  for (const role of BUILT_IN_ROLES) byId.set(role.id, role);
  for (const role of custom) {
    const base = byId.get(role.id);
    byId.set(role.id, base?.builtIn ? { ...base, ...role, builtIn: true } : role);
  }
  return [...byId.values()];
}

export function writeRoles(roles: AgentRole[]): void {
  const file = rolesFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, roles }, null, 2));
}

export function getRole(roleId?: string | null): AgentRole {
  const roles = readRoles();
  return roles.find((r) => r.id === roleId) ?? roles.find((r) => r.id === DEFAULT_ROLE_ID)!;
}

export function createRole(input: { name: string; description?: string; basePrompt?: string }): AgentRole {
  const roles = readRoles();
  const role: AgentRole = {
    id: uid(),
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    basePrompt: input.basePrompt?.trim() ?? "",
    blocks: emptyBlocks(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeRoles([...roles, role]);
  return role;
}

export function updateRole(roleId: string, patch: Partial<Pick<AgentRole, "name" | "description" | "basePrompt" | "blocks">>): AgentRole | null {
  const roles = readRoles();
  const idx = roles.findIndex((r) => r.id === roleId);
  if (idx === -1) return null;
  const current = roles[idx];
  const next: AgentRole = {
    ...current,
    ...patch,
    name: patch.name?.trim() || current.name,
    description: patch.description ?? current.description,
    basePrompt: patch.basePrompt ?? current.basePrompt,
    updatedAt: nowIso(),
  };
  roles[idx] = next;
  writeRoles(roles);
  return next;
}

export function deleteRole(roleId: string): boolean {
  if (roleId === DEFAULT_ROLE_ID) return false;
  const roles = readRoles();
  const role = roles.find((r) => r.id === roleId);
  if (!role || role.builtIn) return false;
  const next = roles.filter((r) => r.id !== roleId);
  if (next.length === roles.length) return false;
  writeRoles(next);
  return true;
}

export function addRoleSetting(roleId: string, block: RoleBlock, text: string): RoleSetting | null {
  const role = getRole(roleId);
  const setting: RoleSetting = { id: uid("setting"), text: text.trim(), createdAt: nowIso() };
  const blocks = { ...role.blocks, [block]: [...role.blocks[block], setting] };
  updateRole(role.id, { blocks });
  return setting;
}

export function composeRolePrompt(roleId?: string | null, temporarySettings: string[] = []): string {
  const role = getRole(roleId);
  const lines: string[] = [];
  lines.push(`# Role: ${role.name}`);
  if (role.description.trim()) lines.push(role.description.trim());
  if (role.basePrompt.trim()) lines.push("", role.basePrompt.trim());

  for (const block of ROLE_BLOCKS) {
    const items = role.blocks[block].filter((s) => s.text.trim());
    if (!items.length) continue;
    lines.push("", `# ${block} / ${BLOCK_TITLES[block]}`);
    for (const item of items) lines.push(`- ${item.text.trim()}`);
  }

  if (temporarySettings.length) {
    lines.push("", "# Session Temporary Settings");
    for (const item of temporarySettings) if (item.trim()) lines.push(`- ${item.trim()}`);
  }

  lines.push("", "# Role Profile Persistence Rules");
  lines.push("- 如果用户要求为角色新增、修改或删除长期设定，必须先用自然语言向用户确认，不要声称已经保存，除非用户明确确认。客户端也会提供确认写入入口。");
  lines.push("- 区分仅本次对话的临时要求与跨 session 生效的角色设定库。");
  return lines.join("\n");
}

const ROLE_START = "\n\n<!-- PI_ROLE_PROFILE_START -->\n";
const ROLE_END = "\n<!-- PI_ROLE_PROFILE_END -->";

export function applyRolePromptToSystemPrompt(systemPrompt: string | undefined, roleId?: string | null, temporarySettings: string[] = []): string {
  let base = systemPrompt ?? "";
  const start = base.indexOf(ROLE_START);
  const end = base.indexOf(ROLE_END, start >= 0 ? start : 0);
  if (start >= 0 && end >= start) {
    base = `${base.slice(0, start)}${base.slice(end + ROLE_END.length)}`;
  }
  base = base.trimEnd();
  return `${base}${ROLE_START}${composeRolePrompt(roleId, temporarySettings)}${ROLE_END}`.trimStart();
}

export function inferRoleBlock(text: string): RoleBlock {
  if (/工具|tool|修改代码前|执行|读文件|写文件|命令/.test(text)) return "Tools";
  if (/用户|我偏好|偏好|协作|习惯/.test(text)) return "User";
  if (/语气|风格|口吻|简洁|详细|直接|专业|先给结论|表达/.test(text)) return "Soul";
  if (/身份|扮演|角色是|像一个|专家|经理|审查员/.test(text)) return "Identity";
  if (/记住|长期|主要服务|背景信息|memory/i.test(text)) return "Memory";
  return "Rules";
}

export function detectRoleSettingIntent(message: string, roles: AgentRole[]): { roleId: string | null; roleName: string | null; block: RoleBlock; setting: string } | null {
  const text = message.trim();
  if (!text) return null;
  const hasIntent = /(给.*角色.*(加|新增|保存|存入|设定)|以后.*角色|角色.*以后|存到.*角色|记住.*角色设定|把.*存到.*角色|当前角色.*设定)/.test(text);
  if (!hasIntent) return null;
  const weakCurrentOnly = /^(这次|本次|当前回答)/.test(text) && !/以后|长期|存/.test(text);
  if (weakCurrentOnly) return null;

  const mentioned = roles.find((r) => r.name !== "默认角色" && text.includes(r.name));
  const afterColon = text.match(/[：:](.+)$/)?.[1]?.trim();
  let setting = afterColon || text;
  setting = setting
    .replace(/^(给)?(当前)?角色(加|新增|保存|存入)?(一个|一条)?设定[：:]?/g, "")
    .replace(/^以后(.+?)这个角色/g, "以后这个角色")
    .replace(/^(把|将)/, "")
    .trim();
  if (setting.length > 160) setting = setting.slice(0, 160).trim() + "…";
  return { roleId: mentioned?.id ?? null, roleName: mentioned?.name ?? null, block: inferRoleBlock(setting), setting };
}
