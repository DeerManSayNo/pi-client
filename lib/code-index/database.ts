import fs from "fs/promises";
import fsSync from "fs";
import { ensureIndexDir, getIndexPath } from "./paths";

export interface IndexedFile {
  path: string;
  mtime: number;
  size: number;
  hash: string;
  content: string;
}

export interface CodeIndexData {
  version: 1;
  cwd: string;
  updatedAt: string;
  files: IndexedFile[];
}

export function indexExists(cwd: string): boolean {
  return fsSync.existsSync(getIndexPath(cwd));
}

export async function readIndex(cwd: string): Promise<CodeIndexData | null> {
  try {
    const raw = await fs.readFile(getIndexPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as CodeIndexData;
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeIndex(data: CodeIndexData): Promise<void> {
  ensureIndexDir();
  await fs.writeFile(getIndexPath(data.cwd), JSON.stringify(data), "utf8");
}

export async function getIndexStatus(cwd: string): Promise<{ exists: boolean; path: string; fileCount: number; updatedAt: string | null }> {
  const indexPath = getIndexPath(cwd);
  const data = await readIndex(cwd);
  return { exists: Boolean(data), path: indexPath, fileCount: data?.files.length ?? 0, updatedAt: data?.updatedAt ?? null };
}
