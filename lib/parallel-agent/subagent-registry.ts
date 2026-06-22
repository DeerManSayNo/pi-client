/**
 * Subagent worker session registry.
 *
 * When the main agent spawns a subagent (spawn_subagent), each worker runs in
 * its own agent session created via `startRpcSession` -> `SessionManager.create`.
 * Those sessions end up in `SessionManager.listAll()` and therefore leak into the
 * sidebar's top-level project list: a worker's cwd is an isolated worktree path
 * whose last path segment is the worker name (e.g. "m0"), so the sidebar groups
 * it as a brand-new project.
 *
 * This registry records every worker session with its origin (parent session,
 * collaboration run, worker name) so:
 *   1. `listAllSessionsUncached` can tag them with `isSubagent: true` for the
 *      sidebar to filter out of the top-level project list.
 *   2. `parentSessionId` can be filled even though pi's `SessionManager.create`
 *      has no notion of a parent session.
 *
 * Storage: an in-memory Map (instant lookups on the hot path) backed by
 * `~/.deerhux/agent/subagent-workers.json` for cross-restart persistence.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

export interface WorkerSessionOrigin {
  workerSessionId: string;
  parentSessionId?: string;
  runId?: string;
  workerName?: string;
  mode?: string;
  createdAt: string;
}

const REGISTRY_FILE = path.join(getAgentDir(), "subagent-workers.json");

const memoryIndex = new Map<string, WorkerSessionOrigin>();
let loaded = false;
let loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (existsSync(REGISTRY_FILE)) {
        const data = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as unknown;
        if (data && typeof data === "object") {
          const workers = (data as { workers?: Record<string, unknown> }).workers;
          if (workers && typeof workers === "object") {
            for (const [id, raw] of Object.entries(workers)) {
              if (raw && typeof raw === "object") {
                memoryIndex.set(id, raw as WorkerSessionOrigin);
              }
            }
          }
        }
      }
    } catch {
      /* corrupt file — start with an empty index */
    }
    loaded = true;
  })();
  return loadPromise;
}

function persist(): void {
  try {
    const dir = path.dirname(REGISTRY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const workers: Record<string, WorkerSessionOrigin> = {};
    for (const [id, origin] of memoryIndex.entries()) {
      workers[id] = origin;
    }
    writeFileSync(REGISTRY_FILE, JSON.stringify({ workers }, null, 2));
  } catch {
    /* best effort — in-memory index still works for this process */
  }
}

/**
 * Record a worker session's origin. Fire-and-forget safe: the in-memory entry
 * is set synchronously so a concurrent `listAllSessions` already sees it; the
 * disk write is deferred until the file is loaded (to avoid clobbering entries
 * from a prior process on first registration).
 */
export function registerWorkerSession(origin: WorkerSessionOrigin): void {
  memoryIndex.set(origin.workerSessionId, origin);
  void ensureLoaded().then(() => persist());
}

/** Look up a single worker session's origin (memory-first). */
export async function getWorkerOrigin(workerSessionId: string): Promise<WorkerSessionOrigin | undefined> {
  await ensureLoaded();
  return memoryIndex.get(workerSessionId);
}

/** Snapshot of all known worker session origins (used by session listing). */
export async function getWorkerOrigins(): Promise<Map<string, WorkerSessionOrigin>> {
  await ensureLoaded();
  return new Map(memoryIndex);
}

/** Drop registry entries whose session files no longer exist (housekeeping). */
export async function pruneWorkerOrigins(existingSessionIds: Set<string>): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const id of [...memoryIndex.keys()]) {
    if (!existingSessionIds.has(id)) {
      memoryIndex.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
}
