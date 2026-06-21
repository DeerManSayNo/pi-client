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
