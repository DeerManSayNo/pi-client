import type { CollaborationRunEvent, CollaborationRunState } from "./collaboration-types";
import { listPersistedTasks, loadTask, persistTaskEvent, persistTaskState } from "./subagent-persistence";

type Listener = (event: CollaborationRunEvent) => void;

const SNAPSHOT_EVENT_TYPES = new Set<CollaborationRunEvent["type"]>([
  "task_created",
  "run_setup_complete",
  "run_interrupted",
  "worker_start",
  "worker_complete",
  "worker_error",
  "worker_diff_ready",
  "task_summary_ready",
  "run_complete",
  "run_aborted",
  "run_error",
  "patch_apply_started",
  "patch_applied",
  "patch_apply_error",
]);

interface StoredCollaborationRun {
  state: CollaborationRunState;
  listeners: Set<Listener>;
  abort?: () => Promise<void>;
  cleanup?: () => void;
}

declare global {
  var __deerhuxCollaborationRuns: Map<string, StoredCollaborationRun> | undefined;
  var __deerhuxCollaborationRunsLoaded: boolean | undefined;
}

function runs(): Map<string, StoredCollaborationRun> {
  if (!globalThis.__deerhuxCollaborationRuns) globalThis.__deerhuxCollaborationRuns = new Map();
  return globalThis.__deerhuxCollaborationRuns;
}

export function createCollaborationRun(state: CollaborationRunState): void {
  runs().set(state.runId, { state, listeners: new Set() });
  persistTaskState(state);
}

export function getCollaborationRun(runId: string): CollaborationRunState | undefined {
  const existing = runs().get(runId)?.state;
  if (existing) return existing;
  const persisted = loadTask(runId);
  if (!persisted) return undefined;
  runs().set(runId, { state: persisted, listeners: new Set() });
  return persisted;
}

export function listCollaborationRuns(): CollaborationRunState[] {
  const store = runs();
  if (!globalThis.__deerhuxCollaborationRunsLoaded) {
    for (const state of listPersistedTasks()) {
      if (!store.has(state.runId)) store.set(state.runId, { state, listeners: new Set() });
    }
    globalThis.__deerhuxCollaborationRunsLoaded = true;
  }
  return [...store.values()].map((run) => run.state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateCollaborationRun(runId: string, updater: (state: CollaborationRunState) => void): CollaborationRunState | undefined {
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return undefined;
  updater(run.state);
  run.state.updatedAt = new Date().toISOString();
  persistTaskState(run.state);
  return run.state;
}

export function emitCollaborationRunEvent(event: CollaborationRunEvent): void {
  const run = runs().get(event.runId);
  if (!run) return;
  const stamped = {
    ...event,
    eventId: event.eventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  run.state.events.push(stamped);
  if (run.state.events.length > 500) run.state.events.splice(0, run.state.events.length - 500);
  run.state.updatedAt = new Date().toISOString();
  persistTaskEvent(stamped);
  if (SNAPSHOT_EVENT_TYPES.has(stamped.type)) persistTaskState(run.state);
  for (const listener of run.listeners) listener(stamped);
}

export function subscribeCollaborationRun(runId: string, listener: Listener): () => void {
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return () => undefined;
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

export function setCollaborationAbort(runId: string, abort: () => Promise<void>): void {
  const run = runs().get(runId);
  if (run) run.abort = abort;
}

export function setCollaborationCleanup(runId: string, cleanup: () => void): void {
  const run = runs().get(runId);
  if (run) run.cleanup = cleanup;
}

export async function abortCollaborationRun(runId: string): Promise<boolean> {
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return false;
  if (!run.abort) {
    if (run.state.status !== "setting_up" && run.state.status !== "running" && run.state.status !== "applying" && run.state.status !== "recoverable") return false;
    updateCollaborationRun(runId, (state) => {
      state.status = "aborted";
      for (const worker of state.workers) {
        if (worker.status === "pending" || worker.status === "running") worker.status = "aborted";
      }
    });
    emitCollaborationRunEvent({ type: "run_aborted", runId });
    return true;
  }
  await run.abort();
  return true;
}

export function cleanupCollaborationRun(runId: string): void {
  const run = runs().get(runId);
  run?.cleanup?.();
}
