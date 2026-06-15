import path from "path";
import fs from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import {
  cleanupCollaborationRun,
  createCollaborationRun,
  emitCollaborationRunEvent,
  getCollaborationRun,
  setCollaborationAbort,
  setCollaborationCleanup,
  subscribeCollaborationRun,
  updateCollaborationRun,
} from "./collaboration-store";
import type {
  ApplyCollaborationPatchesResult,
  CollaborationRunMode,
  CollaborationRunSnapshot,
  CollaborationRunState,
  CollaborationWorkerSpec,
  SubagentRunPlacement,
  SubagentTaskMode,
} from "./collaboration-types";
import {
  cleanupWorkspace,
  generateDiff,
  getRepoStatus,
  isGitRepo,
  prepareIsolatedWorkspace,
  applyWorkerPatch,
} from "./isolation-manager";
import { buildIsolatedWorkerPrompt, buildWorkerPrompt } from "./prompts";
import { buildSubagentSummary } from "./subagent-aggregator";
import { planSubagentTask } from "./subagent-planner";
import { createSubagentWorkerSession, getAutoRecoveryModels, runWorkerPromptWithRecovery, type WorkerSession } from "./subagent-runner";

export {
  abortCollaborationRun,
  getCollaborationRun,
  listCollaborationRuns,
  subscribeCollaborationRun,
} from "./collaboration-store";

const TERMINAL_RUN_STATUSES = new Set<CollaborationRunState["status"]>(["complete", "aborted", "error", "applied"]);
const TERMINAL_RUN_EVENTS = new Set(["run_complete", "run_error", "run_aborted"]);

function snapshotRun(state: CollaborationRunState): CollaborationRunSnapshot {
  return {
    runId: state.runId,
    taskId: state.runId,
    parentEntryId: state.parentEntryId,
    title: state.title,
    mode: state.mode,
    taskMode: state.taskMode,
    runPlacement: state.runPlacement,
    status: state.status,
    message: state.message,
    workers: state.workers,
    summary: state.summary,
    error: state.error,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

async function appendRunSnapshot(parentSessionId: string | undefined, state: CollaborationRunState): Promise<void> {
  if (!parentSessionId) return;
  try {
    const filePath = await resolveSessionPath(parentSessionId);
    if (!filePath) return;
    if (upsertRunSnapshot(filePath, state)) {
      invalidateSessionListCache();
      return;
    }
    const manager = SessionManager.open(filePath);
    manager.appendCustomEntry("agent_collaboration_run", snapshotRun(state));
    invalidateSessionListCache();
  } catch {
    // Best effort: collaboration still runs even if the parent session cannot be annotated.
  }
}

function upsertRunSnapshot(filePath: string, state: CollaborationRunState): boolean {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    let changed = false;
    const nextLines = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { runId?: unknown } };
        if (entry.type !== "custom" || entry.customType !== "agent_collaboration_run") return line;
        if (entry.data?.runId !== state.runId) return line;
        changed = true;
        return JSON.stringify({ ...entry, data: snapshotRun(state) });
      } catch {
        return line;
      }
    });
    if (!changed) return false;
    fs.writeFileSync(filePath, nextLines.join("\n"));
    return true;
  } catch {
    return false;
  }
}

export async function startCollaborationRun(params: {
  cwd: string;
  message: string;
  workers?: CollaborationWorkerSpec[];
  mode?: CollaborationRunMode;
  taskMode?: SubagentTaskMode;
  runPlacement?: SubagentRunPlacement;
  title?: string;
  parentSessionId?: string;
  parentEntryId?: string;
  allowDirtyWorktree?: boolean;
}): Promise<CollaborationRunState> {
  const runId = `collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const planned = planSubagentTask({
    message: params.message,
    taskMode: params.taskMode ?? (params.mode === "isolated_coding" ? "code" : params.mode === "analysis" ? "ask" : undefined),
    placement: params.runPlacement,
    workers: params.workers,
  });
  const mode = params.mode ?? planned.mode;
  const cwd = path.resolve(params.cwd);
  if (mode === "isolated_coding") {
    if (!isGitRepo(cwd)) throw new Error("Code in Isolation requires a git repository so diffs can be reviewed and applied.");
    const repoStatus = getRepoStatus(cwd);
    if (!repoStatus.clean && !params.allowDirtyWorktree) {
      throw new Error(`Working directory has uncommitted changes. Subagent worktrees start from HEAD, so commit/stash changes or confirm running from HEAD first: ${repoStatus.files.join(", ")}`);
    }
  }
  const state: CollaborationRunState = {
    runId,
    parentSessionId: params.parentSessionId,
    parentEntryId: params.parentEntryId,
    cwd,
    title: params.title ?? planned.title,
    message: planned.message,
    mode,
    taskMode: planned.taskMode,
    runPlacement: planned.runPlacement,
    status: mode === "isolated_coding" ? "setting_up" : "running",
    isGit: isGitRepo(params.cwd),
    workers: planned.workers.map((worker, index) => ({
      ...worker,
      workerId: `${runId}_worker_${index + 1}`,
      title: worker.name,
      instructions: worker.task,
      agentType: planned.taskMode,
      capability: mode === "isolated_coding" ? "isolated_coding" : planned.taskMode === "review" ? "review" : "readonly",
      status: "pending",
    })),
    events: [],
    createdAt: now,
    updatedAt: now,
  };

  createCollaborationRun(state);
  emitCollaborationRunEvent({ type: "task_created", runId, summary: state.title });
  await appendRunSnapshot(params.parentSessionId, state);

  executeCollaborationRun(runId).catch(async (error: unknown) => {
    const err = error instanceof Error ? error.message : String(error);
    const updated = updateCollaborationRun(runId, (run) => {
      run.status = "error";
      run.error = err;
    });
    emitCollaborationRunEvent({ type: "run_error", runId, error: err });
    if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
  });

  return state;
}

export function waitForCollaborationRun(runId: string, timeoutMs = 12 * 60 * 1000): Promise<CollaborationRunState> {
  const existing = getCollaborationRun(runId);
  if (!existing) return Promise.reject(new Error("Run not found"));
  if (TERMINAL_RUN_STATUSES.has(existing.status)) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      const latest = getCollaborationRun(runId);
      reject(new Error(latest?.status === "running" || latest?.status === "setting_up"
        ? "Subagent task is still running"
        : "Timed out waiting for subagent task"));
    }, timeoutMs);

    unsubscribe = subscribeCollaborationRun(runId, (event) => {
      if (!TERMINAL_RUN_EVENTS.has(event.type)) return;
      clearTimeout(timeout);
      unsubscribe?.();
      const latest = getCollaborationRun(runId);
      if (latest) resolve(latest);
      else reject(new Error("Run not found after completion"));
    });
  });
}

async function executeCollaborationRun(runId: string): Promise<void> {
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");

  let aborted = false;
  let runDir = "";
  let gitRoot: string | null = null;
  let isGit = false;
  let worktrees: Map<string, string> = new Map();
  const workerSessions: WorkerSession[] = [];

  const cleanupAll = () => {
    if (runDir) {
      try { cleanupWorkspace(runDir, gitRoot, isGit); } catch { /* best effort */ }
    }
    for (const session of workerSessions) {
      try { session.destroy(); } catch { /* best effort */ }
    }
  };

  setCollaborationAbort(runId, async () => {
    aborted = true;
    await Promise.all(workerSessions.map((session) => session.abort().catch(() => {})));
    cleanupAll();
    const updated = updateCollaborationRun(runId, (run) => {
      run.status = "aborted";
      for (const worker of run.workers) {
        if (worker.status === "pending" || worker.status === "running") worker.status = "aborted";
      }
    });
    emitCollaborationRunEvent({ type: "run_aborted", runId });
    if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
  });
  setCollaborationCleanup(runId, cleanupAll);

  if (state.mode === "isolated_coding") {
    const workspace = prepareIsolatedWorkspace(state.cwd, state.workers.map((worker) => worker.name));
    runDir = workspace.runDir;
    gitRoot = workspace.gitRoot;
    isGit = workspace.isGit;
    worktrees = workspace.worktrees;
    updateCollaborationRun(runId, (run) => {
      run.status = "running";
      run.isGit = isGit;
      for (const worker of run.workers) worker.worktreePath = worktrees.get(worker.name);
    });
    emitCollaborationRunEvent({ type: "run_setup_complete", runId });
  }

  const current = getCollaborationRun(runId);
  if (!current || aborted) return;
  const recoveryModels = getAutoRecoveryModels();

  await Promise.all(current.workers.map(async (worker, index) => {
    if (aborted) return;
    const workerCwd = current.mode === "isolated_coding" ? worktrees.get(worker.name) : current.cwd;
    if (!workerCwd) {
      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "error";
          target.error = "Worker workspace was not created";
        }
      });
      emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.name, error: "Worker workspace was not created" });
      return;
    }

    let unsubscribeWorkerEvents: (() => void) | null = null;
    try {
      const workerSession = await createSubagentWorkerSession(workerCwd, current.mode);
      workerSessions.push(workerSession);
      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "running";
          target.sessionId = workerSession.sessionId;
        }
      });
      emitCollaborationRunEvent({ type: "worker_start", runId, workerId: worker.name });

      unsubscribeWorkerEvents = workerSession.listen((event) => {
        emitCollaborationRunEvent({ type: "worker_event", runId, workerId: worker.name, event });
      });
      const prompt = current.mode === "analysis"
        ? buildWorkerPrompt(current.message, worker.task)
        : buildIsolatedWorkerPrompt(current.message, worker.task);
      const result = await runWorkerPromptWithRecovery(
        workerSession,
        prompt,
        recoveryModels,
        (model, attempt, error) => {
          const message = error instanceof Error ? error.message : String(error);
          emitCollaborationRunEvent({
            type: "worker_event",
            runId,
            workerId: worker.name,
            event: {
              type: "auto_recovery_start",
              attempt,
              provider: model.provider,
              modelId: model.modelId,
              errorMessage: message,
            },
          });
        },
      );
      unsubscribeWorkerEvents();
      unsubscribeWorkerEvents = null;

      if (aborted) {
        updateCollaborationRun(runId, (run) => {
          const target = run.workers[index];
          if (target) target.status = "aborted";
        });
        return;
      }

      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "complete";
          target.result = result;
          if (current.mode === "isolated_coding") {
            const { diff, stats } = generateDiff(workerCwd);
            target.diff = diff;
            target.diffStats = stats;
          }
        }
      });
      emitCollaborationRunEvent({ type: "worker_complete", runId, workerId: worker.name, result });

      const latestWorker = getCollaborationRun(runId)?.workers[index];
      if (latestWorker?.diff?.trim()) {
        emitCollaborationRunEvent({
          type: "worker_diff_ready",
          runId,
          workerId: worker.name,
          diff: latestWorker.diff,
          diffStats: latestWorker.diffStats,
        });
      }
    } catch (error) {
      unsubscribeWorkerEvents?.();
      const err = error instanceof Error ? error.message : String(error);
      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "error";
          target.error = err;
        }
      });
      emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.name, error: err });
    }
  }));

  if (aborted) return;

  const completed = updateCollaborationRun(runId, (run) => {
    run.status = run.workers.some((worker) => worker.status === "error") ? "error" : "complete";
    run.summary = buildSubagentSummary(run);
    if (run.status === "error") run.error = "One or more child agents failed";
  });
  if (!completed) return;
  emitCollaborationRunEvent({
    type: completed.status === "complete" ? "run_complete" : "run_error",
    runId,
    summary: completed.summary,
    error: completed.error,
  });
  await appendRunSnapshot(completed.parentSessionId, completed);
}

export async function continueCollaborationWorker(runId: string, workerId: string, prompt?: string): Promise<CollaborationRunState> {
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");
  const workerIndex = state.workers.findIndex((item) => item.workerId === workerId || item.name === workerId);
  const worker = workerIndex >= 0 ? state.workers[workerIndex] : undefined;
  if (!worker) throw new Error("Worker not found");
  if (!worker.sessionId) throw new Error("Worker session is not available yet");

  const workerCwd = state.mode === "isolated_coding" ? worker.worktreePath : state.cwd;
  if (!workerCwd) throw new Error("Worker workspace is not available");
  const message = prompt?.trim() || "请继续这个子任务，基于当前会话上下文补充结论、修复遗漏，并给出最新摘要。";
  const recoveryModels = getAutoRecoveryModels();
  let workerSession: WorkerSession | null = null;
  let unsubscribeWorkerEvents: (() => void) | null = null;

  updateCollaborationRun(runId, (run) => {
    run.status = "running";
    const target = run.workers[workerIndex];
    if (target) target.status = "running";
  });
  emitCollaborationRunEvent({ type: "worker_resumed", runId, workerId: worker.name, summary: message });

  try {
    workerSession = await createSubagentWorkerSession(workerCwd, state.mode, worker.sessionId);
    unsubscribeWorkerEvents = workerSession.listen((event) => {
      emitCollaborationRunEvent({ type: "worker_event", runId, workerId: worker.name, event });
    });
    const result = await runWorkerPromptWithRecovery(
      workerSession,
      message,
      recoveryModels,
      (model, attempt, error) => {
        emitCollaborationRunEvent({
          type: "worker_event",
          runId,
          workerId: worker.name,
          event: {
            type: "auto_recovery_start",
            attempt,
            provider: model.provider,
            modelId: model.modelId,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
    unsubscribeWorkerEvents();
    unsubscribeWorkerEvents = null;

    const updated = updateCollaborationRun(runId, (run) => {
      const target = run.workers[workerIndex];
      if (!target) return;
      target.status = "complete";
      target.result = target.result?.trim() ? `${target.result.trim()}\n\n---\n\n继续结果：\n${result}` : result;
      if (run.mode === "isolated_coding") {
        const { diff, stats } = generateDiff(workerCwd);
        target.diff = diff;
        target.diffStats = stats;
      }
      run.status = run.workers.some((item) => item.status === "error") ? "error" : "complete";
      run.summary = buildSubagentSummary(run);
      if (run.status !== "error") run.error = undefined;
    });
    emitCollaborationRunEvent({ type: "worker_complete", runId, workerId: worker.name, result });
    if (updated) {
      const latestWorker = updated.workers[workerIndex];
      if (latestWorker?.diff?.trim()) {
        emitCollaborationRunEvent({ type: "worker_diff_ready", runId, workerId: worker.name, diff: latestWorker.diff, diffStats: latestWorker.diffStats });
      }
      emitCollaborationRunEvent({ type: "task_summary_ready", runId, summary: updated.summary });
      await appendRunSnapshot(updated.parentSessionId, updated);
      return updated;
    }
    const latest = getCollaborationRun(runId);
    if (!latest) throw new Error("Run not found after continue");
    return latest;
  } catch (error) {
    unsubscribeWorkerEvents?.();
    const err = error instanceof Error ? error.message : String(error);
    const updated = updateCollaborationRun(runId, (run) => {
      const target = run.workers[workerIndex];
      if (target) {
        target.status = "error";
        target.error = err;
      }
      run.status = "error";
      run.error = err;
      run.summary = buildSubagentSummary(run);
    });
    emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.name, error: err });
    if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
    throw error;
  } finally {
    workerSession?.destroy();
  }
}

export async function applyCollaborationPatches(runId: string, workerNames: string[], files?: string[]): Promise<ApplyCollaborationPatchesResult> {
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");
  if (state.mode !== "isolated_coding") throw new Error("Only isolated coding runs can apply patches");
  if (state.status !== "complete" && state.status !== "error") throw new Error("Run must be finished before applying patches");

  const repoStatus = getRepoStatus(state.cwd);
  if (!repoStatus.clean) {
    throw new Error(`Working directory has uncommitted changes: ${repoStatus.files.join(", ")}`);
  }

  updateCollaborationRun(runId, (run) => { run.status = "applying"; });
  emitCollaborationRunEvent({ type: "patch_apply_started", runId, files });

  const result: ApplyCollaborationPatchesResult = { success: true, applied: [], failed: [], conflicts: [], appliedFiles: [], conflictFiles: [] };
  for (const workerName of workerNames) {
    const worker = state.workers.find((item) => item.name === workerName || item.workerId === workerName);
    if (!worker?.worktreePath || !worker.diff?.trim()) {
      result.failed.push({ workerName, error: "Worker not found or no diff available" });
      continue;
    }
    const patchResult = applyWorkerPatch(state.cwd, worker.worktreePath, files);
    if (patchResult.success) {
      result.applied.push(workerName);
      if (files?.length) result.appliedFiles?.push(...files);
      emitCollaborationRunEvent({ type: "patch_applied", runId, workerId: workerName, result: "Patch applied successfully", files });
    } else {
      const error = patchResult.error ?? "Unknown patch error";
      result.failed.push({ workerName, error });
      if (/conflict|does not apply/i.test(error)) {
        result.conflicts.push(workerName);
        if (files?.length) result.conflictFiles?.push(...files);
      }
      emitCollaborationRunEvent({ type: "patch_apply_error", runId, workerId: workerName, error, files });
    }
  }

  result.success = result.failed.length === 0;
  const updated = updateCollaborationRun(runId, (run) => {
    run.status = result.success ? "applied" : "complete";
    for (const workerName of result.applied) {
      const target = run.workers.find((item) => item.name === workerName || item.workerId === workerName);
      if (target) target.appliedFiles = [...new Set([...(target.appliedFiles ?? []), ...(files ?? extractFilesFromDiffStats(target.diffStats))])];
    }
    for (const workerName of result.conflicts) {
      const target = run.workers.find((item) => item.name === workerName || item.workerId === workerName);
      if (target) target.conflictFiles = [...new Set([...(target.conflictFiles ?? []), ...(files ?? extractFilesFromDiffStats(target.diffStats))])];
    }
  });
  if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
  if (result.success) cleanupCollaborationRun(runId);
  return result;
}

function extractFilesFromDiffStats(stats?: string): string[] {
  if (!stats) return [];
  return stats
    .split("\n")
    .map((line) => line.split("|")[0]?.trim())
    .filter((file): file is string => Boolean(file) && !/files? changed/.test(file));
}
