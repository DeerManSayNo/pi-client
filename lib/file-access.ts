import fs from "fs";
import os from "os";
import path from "path";
import { listAllSessions } from "@/lib/session-reader";

const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAllowedExtraRoots: Set<string> | undefined;
}

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

function normalizeRoot(root: string): string {
  const useWindowsRules = isWindowsAbsolutePath(root);
  const resolver = useWindowsRules ? path.win32 : path;
  const resolved = resolver.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

export function addAllowedRoot(root: string | null | undefined): void {
  if (!root) return;
  const normalized = normalizeRoot(root);
  if (!globalThis.__piAllowedExtraRoots) globalThis.__piAllowedExtraRoots = new Set();
  globalThis.__piAllowedExtraRoots.add(normalized);
  globalThis.__piAllowedRootsCache?.roots.add(normalized);
}

export async function getAllowedRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeRoot(s.cwd));
  }

  for (const root of globalThis.__piAllowedExtraRoots ?? []) {
    roots.add(normalizeRoot(root));
  }

  try {
    for (const name of fs.readdirSync(os.homedir())) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeRoot(path.join(os.homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function isPathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = normalizeRoot(resolver.resolve(target));
    const normalizedRoot = normalizeRoot(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}
