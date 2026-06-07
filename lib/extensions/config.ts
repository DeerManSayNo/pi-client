import path from "path";
import { existsSync, realpathSync } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function safeResolve(filePath: string): string | null {
  try {
    return path.resolve(filePath);
  } catch {
    return null;
  }
}

function realOrResolved(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : path.resolve(p);
  } catch {
    return path.resolve(p);
  }
}

export function isPathInside(child: string, parent: string): boolean {
  const childReal = realOrResolved(child);
  const parentReal = realOrResolved(parent);
  const rel = path.relative(parentReal, childReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function deerhuxManagedSkillDirs(cwd?: string | null): string[] {
  const dirs = [path.join(getAgentDir(), "skills")];
  if (cwd?.trim()) dirs.push(path.join(cwd, ".deerhux", "skills"));
  return dirs;
}

export function isManagedDeerHuxSkillFile(filePath: string, cwd?: string | null): boolean {
  const resolved = safeResolve(filePath);
  if (!resolved) return false;
  if (path.basename(resolved) !== "SKILL.md") return false;
  return deerhuxManagedSkillDirs(cwd).some((dir) => isPathInside(resolved, dir));
}
