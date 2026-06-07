import type { ParallelRunEvent, ParallelRunState } from "./types";

type Listener = (event: ParallelRunEvent) => void;

interface StoredRun {
  state: ParallelRunState;
  listeners: Set<Listener>;
  abort?: () => Promise<void>;
}

declare global {
  var __deerhuxParallelRuns: Map<string, StoredRun> | undefined;
}

function runs(): Map<string, StoredRun> {
  if (!globalThis.__deerhuxParallelRuns) globalThis.__deerhuxParallelRuns = new Map();
  return globalThis.__deerhuxParallelRuns;
}

export function createRun(state: ParallelRunState): void {
  runs().set(state.runId, { state, listeners: new Set() });
}

export function getRun(runId: string): ParallelRunState | undefined {
  return runs().get(runId)?.state;
}

export function listRuns(): ParallelRunState[] {
  return [...runs().values()].map(r => r.state);
}

export function setAbort(runId: string, abort: () => Promise<void>): void {
  const run = runs().get(runId);
  if (run) run.abort = abort;
}

export async function abortRun(runId: string): Promise<boolean> {
  const run = runs().get(runId);
  if (!run?.abort) return false;
  await run.abort();
  return true;
}

export function updateRun(runId: string, updater: (state: ParallelRunState) => void): ParallelRunState | undefined {
  const run = runs().get(runId);
  if (!run) return undefined;
  updater(run.state);
  run.state.updatedAt = new Date().toISOString();
  return run.state;
}

export function emitRunEvent(event: ParallelRunEvent): void {
  const run = runs().get(event.runId);
  if (!run) return;
  run.state.events.push(event);
  if (run.state.events.length > 500) run.state.events.splice(0, run.state.events.length - 500);
  run.state.updatedAt = new Date().toISOString();
  for (const listener of run.listeners) listener(event);
}

export function subscribeRun(runId: string, listener: Listener): () => void {
  const run = runs().get(runId);
  if (!run) return () => undefined;
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}
