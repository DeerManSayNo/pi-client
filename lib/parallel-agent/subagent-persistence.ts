import fs from "fs";
import path from "path";
import { getAgentDir } from "@/lib/session-reader";
import type { CollaborationRunEvent, CollaborationRunState } from "./collaboration-types";

const TASKS_DIR = path.join(getAgentDir(), "tasks");
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_SCAN_BYTES = 8 * 1024 * 1024;

type TaskLogEntry =
  | { type: "state"; state: CollaborationRunState }
  | { type: "state_snapshot"; state: CollaborationRunState }
  | { type: "event"; event: CollaborationRunEvent };

const ACTIVE_STATUSES = new Set<CollaborationRunState["status"]>(["setting_up", "running", "applying"]);

function ensureTasksDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function taskPath(runId: string): string {
  return path.join(TASKS_DIR, `${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

function parseTaskLogEntry(line: string): TaskLogEntry | null {
  try {
    return JSON.parse(line) as TaskLogEntry;
  } catch {
    return null;
  }
}

function loadLatestTaskState(filePath: string): CollaborationRunState | undefined {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const { size } = fs.fstatSync(fd);
    let offset = size;
    let buffer = "";
    let scanned = 0;

    while (offset > 0 && scanned < MAX_TAIL_SCAN_BYTES) {
      const bytesToRead = Math.min(TAIL_CHUNK_BYTES, offset, MAX_TAIL_SCAN_BYTES - scanned);
      offset -= bytesToRead;
      scanned += bytesToRead;

      const chunk = Buffer.alloc(bytesToRead);
      fs.readSync(fd, chunk, 0, bytesToRead, offset);
      buffer = chunk.toString("utf8") + buffer;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.shift() ?? "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        const entry = parseTaskLogEntry(line);
        if (entry?.type === "state" || entry?.type === "state_snapshot") {
          return entry.state;
        }
      }
    }

    const entry = parseTaskLogEntry(buffer.trim());
    return entry?.type === "state" || entry?.type === "state_snapshot" ? entry.state : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function persistTaskState(state: CollaborationRunState): void {
  try {
    ensureTasksDir();
    fs.appendFileSync(taskPath(state.runId), `${JSON.stringify({ type: "state_snapshot", state } satisfies TaskLogEntry)}\n`);
  } catch {
    // Task persistence is best-effort; in-memory runs should still work.
  }
}

export function persistTaskEvent(event: CollaborationRunEvent): void {
  try {
    ensureTasksDir();
    fs.appendFileSync(taskPath(event.runId), `${JSON.stringify({ type: "event", event } satisfies TaskLogEntry)}\n`);
  } catch {
    // Best effort.
  }
}

export function loadTask(runId: string): CollaborationRunState | undefined {
  try {
    const filePath = taskPath(runId);
    if (!fs.existsSync(filePath)) return undefined;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    let state: CollaborationRunState | undefined;
    const events: CollaborationRunEvent[] = [];
    for (const line of lines) {
      const entry = parseTaskLogEntry(line);
      if (!entry) continue;
      if (entry.type === "state" || entry.type === "state_snapshot") state = entry.state;
      else if (entry.type === "event") events.push(entry.event);
    }
    if (!state) return undefined;
    state.events = events.length > 0 ? events : state.events ?? [];
    markInterruptedIfStale(state);
    return state;
  } catch {
    return undefined;
  }
}

export function listPersistedTasks(): CollaborationRunState[] {
  try {
    ensureTasksDir();
    return fs.readdirSync(TASKS_DIR)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => {
        const task = loadLatestTaskState(path.join(TASKS_DIR, file));
        if (task) markInterruptedIfStale(task);
        return task ? [task] : [];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function markInterruptedIfStale(state: CollaborationRunState): void {
  if (!ACTIVE_STATUSES.has(state.status)) return;
  if (state.events.some((event) => event.type === "run_interrupted")) {
    state.status = "recoverable";
    return;
  }
  const now = new Date().toISOString();
  const event: CollaborationRunEvent = {
    eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "run_interrupted",
    runId: state.runId,
    timestamp: now,
    error: "Task was interrupted while the app was not running. Open a worker session to continue.",
  };
  state.status = "recoverable";
  state.updatedAt = now;
  state.events.push(event);
  persistTaskEvent(event);
  persistTaskState(state);
}
