import path from "path";
import { readIndex, writeIndex } from "./database";
import { scanFiles } from "./scanner";

export async function refreshIndex(cwd: string): Promise<{ fileCount: number; changedCount: number; updatedAt: string }> {
  const root = path.resolve(cwd);
  const previous = await readIndex(root);
  const previousByPath = new Map((previous?.files ?? []).map(file => [file.path, file]));
  const scanned = await scanFiles(root);
  let changedCount = 0;

  const files = scanned.map(file => {
    const prev = previousByPath.get(file.path);
    if (!prev || prev.mtime !== file.mtime || prev.size !== file.size || prev.hash !== file.hash) changedCount += 1;
    return { path: file.path, mtime: file.mtime, size: file.size, hash: file.hash, content: file.content };
  });

  const scannedPaths = new Set(files.map(file => file.path));
  for (const prev of previous?.files ?? []) {
    if (!scannedPaths.has(prev.path)) changedCount += 1;
  }

  const updatedAt = new Date().toISOString();
  await writeIndex({ version: 1, cwd: root, updatedAt, files });
  return { fileCount: files.length, changedCount, updatedAt };
}
