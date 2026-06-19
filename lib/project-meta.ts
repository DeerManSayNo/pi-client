import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Persistent project metadata for the sidebar.
 *
 * Stored at ~/.deerhux/agent/project-meta.json so it survives app reinstalls
 * (the previous localStorage-only approach was wiped on reinstall, causing
 * "deleted" projects to reappear because the underlying session files were
 * never removed).
 */
export interface ProjectMeta {
  /** Project cwds the user has hidden via "删除项目引入". */
  hiddenCwds: string[];
  /** Project cwds pinned to the top of the sidebar. */
  pinnedCwds: string[];
  /** User-defined notes per cwd. */
  notes: Record<string, string>;
  /** Tracks whether the default cwd has been auto-pinned (one-time). */
  defaultPinInitializedCwds: string[];
  /** Manually-added project cwds that have no sessions yet. */
  customCwds: string[];
}

interface ProjectMetaFile {
  version: 1;
  hiddenCwds?: unknown;
  pinnedCwds?: unknown;
  notes?: unknown;
  defaultPinInitializedCwds?: unknown;
  customCwds?: unknown;
}

export const EMPTY_PROJECT_META: ProjectMeta = {
  hiddenCwds: [],
  pinnedCwds: [],
  notes: {},
  defaultPinInitializedCwds: [],
  customCwds: [],
};

function normalizeStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
}

function normalizeNotes(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function projectMetaFilePath(): string {
  return path.join(getAgentDir(), "project-meta.json");
}

export function isEmptyProjectMeta(meta: ProjectMeta): boolean {
  return (
    meta.hiddenCwds.length === 0 &&
    meta.pinnedCwds.length === 0 &&
    Object.keys(meta.notes).length === 0 &&
    meta.defaultPinInitializedCwds.length === 0 &&
    meta.customCwds.length === 0
  );
}

export function readProjectMeta(): ProjectMeta {
  const file = projectMetaFilePath();
  if (!existsSync(file)) return { ...EMPTY_PROJECT_META };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectMetaFile>;
    return {
      hiddenCwds: normalizeStringArray(parsed.hiddenCwds),
      pinnedCwds: normalizeStringArray(parsed.pinnedCwds),
      notes: normalizeNotes(parsed.notes),
      defaultPinInitializedCwds: normalizeStringArray(parsed.defaultPinInitializedCwds),
      customCwds: normalizeStringArray(parsed.customCwds),
    };
  } catch {
    return { ...EMPTY_PROJECT_META };
  }
}

export function writeProjectMeta(meta: ProjectMeta): ProjectMeta {
  const normalized: ProjectMeta = {
    hiddenCwds: [...new Set(normalizeStringArray(meta.hiddenCwds))],
    pinnedCwds: [...new Set(normalizeStringArray(meta.pinnedCwds))],
    notes: normalizeNotes(meta.notes),
    defaultPinInitializedCwds: [...new Set(normalizeStringArray(meta.defaultPinInitializedCwds))],
    customCwds: [...new Set(normalizeStringArray(meta.customCwds))],
  };
  const file = projectMetaFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, ...normalized }, null, 2));
  return normalized;
}
