import type { AgentEvent } from "@/lib/rpc-manager";

export type IsolatedRunStatus = "setting_up" | "running" | "complete" | "aborted" | "error" | "applying" | "applied";

export interface IsolatedWorkerSpec {
  name: string;
  task: string;
}

export interface IsolatedWorkerState extends IsolatedWorkerSpec {
  sessionId?: string;
  status: "pending" | "running" | "complete" | "aborted" | "error";
  result?: string;
  error?: string;
  /** Path to worktree directory */
  worktreePath?: string;
  /** Generated diff text */
  diff?: string;
  /** Diff stats */
  diffStats?: string;
}

export interface IsolatedRunState {
  runId: string;
  cwd: string;
  message: string;
  status: IsolatedRunStatus;
  isGit: boolean;
  workers: IsolatedWorkerState[];
  events: IsolatedRunEvent[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface IsolatedRunEvent {
  type:
    | "worker_start"
    | "worker_event"
    | "worker_complete"
    | "worker_error"
    | "worker_diff_ready"
    | "run_setup_complete"
    | "run_complete"
    | "run_aborted"
    | "run_error"
    | "patch_applied"
    | "patch_apply_error";
  runId: string;
  workerId?: string;
  event?: AgentEvent;
  result?: string;
  error?: string;
  diff?: string;
  diffStats?: string;
}

export interface ApplyPatchRequest {
  workerNames: string[];
}

export interface ApplyPatchResult {
  success: boolean;
  applied: string[];
  failed: Array<{ workerName: string; error: string }>;
  conflicts: string[];
}
