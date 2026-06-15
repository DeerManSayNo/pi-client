import type { AgentEvent } from "@/lib/rpc-manager";

export type CollaborationRunMode = "analysis" | "isolated_coding";
export type CollaborationRunStatus = "setting_up" | "running" | "complete" | "aborted" | "error" | "applying" | "applied" | "recoverable";
export type CollaborationWorkerStatus = "pending" | "running" | "complete" | "aborted" | "error";
export type SubagentTaskMode = "ask" | "code" | "parallel" | "review" | "custom";
export type SubagentRunPlacement = "foreground" | "background";
export type SubagentCapability = "readonly" | "isolated_coding" | "review";

export interface CollaborationWorkerSpec {
  name: string;
  task: string;
}

export interface CollaborationWorkerState extends CollaborationWorkerSpec {
  workerId?: string;
  title?: string;
  instructions?: string;
  agentType?: SubagentTaskMode;
  capability?: SubagentCapability;
  model?: { provider: string; modelId: string };
  sessionId?: string;
  status: CollaborationWorkerStatus;
  result?: string;
  error?: string;
  worktreePath?: string;
  diff?: string;
  diffStats?: string;
  appliedFiles?: string[];
  conflictFiles?: string[];
}

export interface CollaborationRunState {
  runId: string;
  parentSessionId?: string;
  parentEntryId?: string;
  cwd: string;
  title?: string;
  message: string;
  mode: CollaborationRunMode;
  taskMode?: SubagentTaskMode;
  runPlacement?: SubagentRunPlacement;
  status: CollaborationRunStatus;
  isGit?: boolean;
  workers: CollaborationWorkerState[];
  events: CollaborationRunEvent[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
}

export interface CollaborationRunEvent {
  eventId?: string;
  type:
    | "task_created"
    | "run_setup_complete"
    | "run_interrupted"
    | "worker_start"
    | "worker_resumed"
    | "worker_event"
    | "worker_complete"
    | "worker_error"
    | "worker_diff_ready"
    | "task_summary_ready"
    | "run_complete"
    | "run_aborted"
    | "run_error"
    | "patch_apply_started"
    | "patch_applied"
    | "patch_apply_error";
  runId: string;
  workerId?: string;
  timestamp?: string;
  event?: AgentEvent;
  result?: string;
  error?: string;
  summary?: string;
  diff?: string;
  diffStats?: string;
  files?: string[];
}

export interface CollaborationRunSnapshot {
  runId: string;
  taskId?: string;
  parentEntryId?: string;
  title?: string;
  mode: CollaborationRunMode;
  taskMode?: SubagentTaskMode;
  runPlacement?: SubagentRunPlacement;
  status: CollaborationRunStatus;
  message: string;
  workers: CollaborationWorkerState[];
  events?: CollaborationRunEvent[];
  summary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyCollaborationPatchesResult {
  success: boolean;
  applied: string[];
  failed: Array<{ workerName: string; error: string }>;
  conflicts: string[];
  appliedFiles?: string[];
  conflictFiles?: string[];
}

export interface SubagentArtifact {
  kind: "diff" | "summary" | "logs" | "review";
  workerId?: string;
  title: string;
  content: string;
  filesChanged?: string[];
}

export interface SubagentWorker {
  workerId: string;
  title: string;
  instructions: string;
  agentType: SubagentTaskMode;
  capability: SubagentCapability;
  status: CollaborationWorkerStatus;
  sessionId?: string;
  worktreePath?: string;
  summary?: string;
  diff?: string;
  diffStats?: string;
  appliedFiles?: string[];
  conflictFiles?: string[];
  resultEntryId?: string;
  error?: string;
}

export interface SubagentTask {
  taskId: string;
  parentSessionId?: string;
  parentEntryId?: string;
  cwd: string;
  title: string;
  prompt: string;
  status: CollaborationRunStatus;
  mode: SubagentTaskMode;
  runPlacement: SubagentRunPlacement;
  workers: SubagentWorker[];
  events: CollaborationRunEvent[];
  artifacts: SubagentArtifact[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
}

export function collaborationRunToSubagentTask(run: CollaborationRunState): SubagentTask {
  return {
    taskId: run.runId,
    parentSessionId: run.parentSessionId,
    parentEntryId: run.parentEntryId,
    cwd: run.cwd,
    title: run.title ?? defaultTaskTitle(run.message, run.mode),
    prompt: run.message,
    status: run.status,
    mode: run.taskMode ?? (run.mode === "isolated_coding" ? "code" : "ask"),
    runPlacement: run.runPlacement ?? "background",
    workers: run.workers.map((worker, index) => ({
      workerId: worker.workerId ?? worker.name,
      title: worker.title ?? worker.name,
      instructions: worker.instructions ?? worker.task,
      agentType: worker.agentType ?? (run.mode === "isolated_coding" ? "code" : "ask"),
      capability: worker.capability ?? (run.mode === "isolated_coding" ? "isolated_coding" : "readonly"),
      status: worker.status,
      sessionId: worker.sessionId,
      worktreePath: worker.worktreePath,
      summary: worker.result,
      diff: worker.diff,
      diffStats: worker.diffStats,
      appliedFiles: worker.appliedFiles,
      conflictFiles: worker.conflictFiles,
      resultEntryId: `${run.runId}:${index}`,
      error: worker.error,
    })),
    events: run.events,
    artifacts: run.workers.flatMap((worker) => {
      const artifacts: SubagentArtifact[] = [];
      if (worker.result) artifacts.push({ kind: "summary", workerId: worker.workerId ?? worker.name, title: worker.name, content: worker.result });
      if (worker.diff?.trim()) artifacts.push({ kind: "diff", workerId: worker.workerId ?? worker.name, title: `${worker.name} diff`, content: worker.diff, filesChanged: extractFilesFromDiffStats(worker.diffStats) });
      return artifacts;
    }),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary: run.summary,
    error: run.error,
  };
}

export function subagentTaskToSnapshot(task: SubagentTask): CollaborationRunSnapshot {
  return {
    runId: task.taskId,
    taskId: task.taskId,
    parentEntryId: task.parentEntryId,
    title: task.title,
    mode: task.mode === "code" || task.mode === "parallel" ? "isolated_coding" : "analysis",
    taskMode: task.mode,
    runPlacement: task.runPlacement,
    status: task.status,
    message: task.prompt,
    workers: task.workers.map((worker) => ({
      name: worker.title,
      task: worker.instructions,
      workerId: worker.workerId,
      title: worker.title,
      instructions: worker.instructions,
      agentType: worker.agentType,
      capability: worker.capability,
      sessionId: worker.sessionId,
      status: worker.status,
      result: worker.summary,
      error: worker.error,
      worktreePath: worker.worktreePath,
      diff: worker.diff,
      diffStats: worker.diffStats,
      appliedFiles: worker.appliedFiles,
      conflictFiles: worker.conflictFiles,
    })),
    events: task.events,
    summary: task.summary,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function defaultTaskTitle(message: string, mode: CollaborationRunMode): string {
  const prefix = mode === "isolated_coding" ? "隔离编码" : "只读调研";
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine ? `${prefix}: ${oneLine.slice(0, 36)}` : prefix;
}

function extractFilesFromDiffStats(stats?: string): string[] {
  if (!stats) return [];
  return stats
    .split("\n")
    .map((line) => line.split("|")[0]?.trim())
    .filter((file): file is string => Boolean(file) && !/files? changed/.test(file));
}
