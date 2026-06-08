import fs from "fs";
import path from "path";
import { runCodeGraph, runCodeGraphJson } from "./cli";

export interface CodeGraphStatus {
  initialized: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  lastIndexed?: number | null;
  pendingChanges?: unknown;
  [key: string]: unknown;
}

export function hasCodeGraphDir(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, ".codegraph"));
}

export async function ensureCodeGraphInitialized(cwd: string, signal?: AbortSignal): Promise<CodeGraphStatus | null> {
  try {
    const existing = await getCodeGraphStatus(cwd, signal);
    if (existing?.initialized) return existing;

    await runCodeGraph(["init", "--index", cwd], {
      cwd,
      signal,
      timeoutMs: 120_000,
    });

    return await getCodeGraphStatus(cwd, signal);
  } catch {
    return null;
  }
}

export async function getCodeGraphStatus(cwd: string, signal?: AbortSignal): Promise<CodeGraphStatus | null> {
  if (!hasCodeGraphDir(cwd)) return null;
  try {
    const status = await runCodeGraphJson<CodeGraphStatus>(["status", "--json"], {
      cwd,
      signal,
      timeoutMs: 10_000,
    });
    return status.initialized ? status : null;
  } catch {
    return null;
  }
}

export async function isCodeGraphAvailable(cwd: string): Promise<boolean> {
  const status = await getCodeGraphStatus(cwd);
  return Boolean(status?.initialized);
}
