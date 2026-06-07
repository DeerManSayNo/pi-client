import path from "path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "@/lib/rpc-manager";
import { configureToolExecutionModes } from "@/lib/rpc-manager";
import type { AgentSessionLike } from "@/lib/deerhux-types";
import type {
  IsolatedRunState,
  IsolatedWorkerSpec,
  IsolatedRunEvent,
  ApplyPatchResult,
} from "./isolated-types";
import {
  setupIsolatedWorkspace,
  generateDiff,
  applyPatch,
  cleanupWorkspace,
  getRepoStatus,
  isGitRepo,
} from "./worktree";
import { buildIsolatedWorkerPrompt } from "./prompts";

// ============================================================================
// Run store
// ============================================================================

type EventListener = (event: IsolatedRunEvent) => void;

interface StoredIsolatedRun {
  state: IsolatedRunState;
  listeners: Set<EventListener>;
  abort?: () => Promise<void>;
  cleanup?: () => void;
}

declare global {
  var __deerhuxIsolatedRuns: Map<string, StoredIsolatedRun> | undefined;
}

function runs(): Map<string, StoredIsolatedRun> {
  if (!globalThis.__deerhuxIsolatedRuns) globalThis.__deerhuxIsolatedRuns = new Map();
  return globalThis.__deerhuxIsolatedRuns;
}

export function getIsolatedRun(runId: string): IsolatedRunState | undefined {
  return runs().get(runId)?.state;
}

export function listIsolatedRuns(): IsolatedRunState[] {
  return [...runs().values()].map(r => r.state);
}

function emitEvent(event: IsolatedRunEvent): void {
  const run = runs().get(event.runId);
  if (!run) return;
  run.state.events.push(event);
  if (run.state.events.length > 500) run.state.events.splice(0, run.state.events.length - 500);
  run.state.updatedAt = new Date().toISOString();
  for (const l of run.listeners) l(event);
}

export function subscribeIsolatedRun(runId: string, listener: EventListener): () => void {
  const run = runs().get(runId);
  if (!run) return () => undefined;
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Create an AgentSession-like wrapper that uses createAgentSession directly
 * (not the Web-layer startRpcSession, since we need full tools at the worktree).
 */
async function createIsolatedWorkerSession(
  worktreePath: string,
): Promise<{
  runWorker: (prompt: string) => Promise<string>;
  abort: () => Promise<void>;
  listen: (listener: (event: AgentEvent) => void) => () => void;
  destroy: () => void;
}> {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const agentDir = getAgentDir();
  const sessionManager = SessionManager.create(worktreePath);

  const { session: inner } = await createAgentSession({
    cwd: worktreePath,
    agentDir,
    sessionManager,
    // Full tools: read, bash, edit, write, grep, find, ls
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });

  configureToolExecutionModes(inner as unknown as AgentSessionLike);

  const listeners: Array<(event: AgentEvent) => void> = [];
  const unsub = inner.subscribe((event: AgentEvent) => {
    for (const l of listeners) l(event);
  });

  return {
    runWorker: async (prompt: string) => {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

        const timeout = setTimeout(() => settle(() => reject(new Error("Isolated worker session timed out after 10 minutes"))), 10 * 60 * 1000);

        const unsubInner = inner.subscribe((event: AgentEvent) => {
          if (event.type === "agent_end" && event.messages) {
            settle(() => {
              clearTimeout(timeout);
              unsubInner();
              const messages = event.messages as Array<{ role: string; content?: string | Array<{ type: string; text?: string; thinking?: string }> }>;
              const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
              if (lastAssistant) {
                const content = lastAssistant.content;
                if (typeof content === "string") {
                  resolve(content);
                } else if (Array.isArray(content)) {
                  resolve(content.map(b => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "") ?? "").join(""));
                } else {
                  resolve("");
                }
              } else {
                resolve("");
              }
            });
          }
        });

        inner.prompt(prompt).catch(reject);
      });
    },
    abort: async () => { await inner.abort(); },
    listen: (listener: (event: AgentEvent) => void) => {
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
    destroy: () => { unsub(); },
  };
}

export async function startIsolatedRun(
  cwd: string,
  message: string,
  workers: IsolatedWorkerSpec[],
): Promise<IsolatedRunState> {
  const runId = `iso_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const state: IsolatedRunState = {
    runId,
    cwd: path.resolve(cwd),
    message,
    status: "setting_up",
    isGit: isGitRepo(cwd),
    workers: workers.map(w => ({
      ...w,
      status: "pending",
    })),
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  runs().set(runId, { state, listeners: new Set() });

  // Fire-and-forget execution
  executeIsolatedRun(state, workers).catch(error => {
    state.status = "error";
    state.error = String(error);
    state.updatedAt = new Date().toISOString();
    emitEvent({ type: "run_error", runId, error: String(error) });
  });

  return state;
}

async function executeIsolatedRun(
  state: IsolatedRunState,
  workers: IsolatedWorkerSpec[],
): Promise<void> {
  const runId = state.runId;
  const cwd = state.cwd;
  let runDir = "";
  let gitRoot: string | null = null;
  let isGit = false;
  let worktrees: Map<string, string> = new Map();

  // Set up abort handler
  let aborted = false;
  const workerSessions: Array<{ abort: () => Promise<void>; destroy: () => void }> = [];

  runs().get(runId)!.abort = async () => {
    aborted = true;
    await Promise.all(workerSessions.map(s => s.abort().catch(() => {})));
    cleanupAll();
  };

  runs().get(runId)!.cleanup = cleanupAll;

  function cleanupAll() {
    try { cleanupWorkspace(runDir, gitRoot, isGit); } catch {}
    workerSessions.forEach(s => { try { s.destroy(); } catch {} });
  }

  try {
    // Step 1: Set up workspaces
    const workspace = setupIsolatedWorkspace(cwd, workers.map(w => w.name));
    runDir = workspace.runDir;
    gitRoot = workspace.gitRoot;
    isGit = workspace.isGit;
    worktrees = workspace.worktrees;

    for (const worker of workers) {
      const wPath = worktrees.get(worker.name);
      state.workers.find(w => w.name === worker.name)!.worktreePath = wPath;
    }

    state.status = "running";
    state.updatedAt = new Date().toISOString();
    emitEvent({ type: "run_setup_complete", runId });

    if (aborted) return;

    // Step 2: Run all workers in parallel
    await Promise.all(workers.map(async (worker) => {
      if (aborted) return;

      const workerState = state.workers.find(w => w.name === worker.name)!;
      const worktreePath = worktrees.get(worker.name);
      if (!worktreePath) {
        workerState.status = "error";
        workerState.error = "Worktree not created";
        emitEvent({ type: "worker_error", runId, workerId: worker.name, error: "Worktree not created" });
        return;
      }

      try {
        const ws = await createIsolatedWorkerSession(worktreePath);
        workerSessions.push(ws);

        workerState.status = "running";
        state.updatedAt = new Date().toISOString();
        emitEvent({ type: "worker_start", runId, workerId: worker.name });

        // Forward worker events
        const unsub = ws.listen((event) => {
          emitEvent({ type: "worker_event", runId, workerId: worker.name, event: event as AgentEvent });
        });

        const prompt = buildIsolatedWorkerPrompt(state.message, worker.task);
        const result = await ws.runWorker(prompt);

        unsub();

        if (aborted) {
          workerState.status = "aborted";
          return;
        }

        workerState.result = result;
        workerState.status = "complete";

        // Generate diff
        const { diff, stats } = generateDiff(worktreePath);
        workerState.diff = diff;
        workerState.diffStats = stats;
        state.updatedAt = new Date().toISOString();

        emitEvent({
          type: "worker_complete",
          runId,
          workerId: worker.name,
          result,
        });

        if (diff.trim()) {
          emitEvent({
            type: "worker_diff_ready",
            runId,
            workerId: worker.name,
            diff,
            diffStats: stats,
          });
        }
      } catch (error) {
        workerState.status = "error";
        workerState.error = String(error);
        state.updatedAt = new Date().toISOString();
        emitEvent({ type: "worker_error", runId, workerId: worker.name, error: String(error) });
      }
    }));

    if (aborted) {
      state.status = "aborted";
      state.updatedAt = new Date().toISOString();
      emitEvent({ type: "run_aborted", runId });
      return;
    }

    state.status = "complete";
    state.updatedAt = new Date().toISOString();
    emitEvent({ type: "run_complete", runId });
  } catch (error) {
    state.status = "error";
    state.error = String(error);
    state.updatedAt = new Date().toISOString();
    emitEvent({ type: "run_error", runId, error: String(error) });
  }
}

/**
 * Apply patches from selected workers to the main cwd.
 */
export async function applyIsolatedPatches(
  runId: string,
  workerNames: string[],
): Promise<ApplyPatchResult> {
  const run = runs().get(runId);
  if (!run) throw new Error("Run not found");

  const state = run.state;
  if (state.status !== "complete") throw new Error("Run must be complete before applying patches");

  // Check repo status before applying
  const repoStatus = getRepoStatus(state.cwd);
  if (!repoStatus.clean) {
    throw new Error(`Working directory has uncommitted changes: ${repoStatus.files.join(", ")}. Please commit or stash them first.`);
  }

  state.status = "applying";
  state.updatedAt = new Date().toISOString();

  const result: ApplyPatchResult = { success: true, applied: [], failed: [], conflicts: [] };

  for (const workerName of workerNames) {
    const worker = state.workers.find(w => w.name === workerName);
    if (!worker || !worker.worktreePath || !worker.diff) {
      result.failed.push({ workerName, error: "Worker not found or no diff available" });
      continue;
    }

    const patchResult = applyPatch(state.cwd, worker.worktreePath);

    if (patchResult.success) {
      result.applied.push(workerName);
      emitEvent({
        type: "patch_applied",
        runId,
        workerId: workerName,
        result: `Patch applied successfully`,
      });
    } else {
      result.failed.push({ workerName, error: patchResult.error ?? "Unknown error" });
      if (patchResult.error?.includes("conflict")) {
        result.conflicts.push(workerName);
      }
      emitEvent({
        type: "patch_apply_error",
        runId,
        workerId: workerName,
        error: patchResult.error,
      });
    }
  }

  result.success = result.failed.length === 0;
  state.status = "applied";
  state.updatedAt = new Date().toISOString();

  // Clean up after applying
  if (run.cleanup) run.cleanup();

  return result;
}

/**
 * Abort a run.
 */
export async function abortIsolatedRun(runId: string): Promise<boolean> {
  const run = runs().get(runId);
  if (!run?.abort) return false;
  await run.abort();
  return true;
}
