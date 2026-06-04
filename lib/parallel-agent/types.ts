import type { AgentEvent } from "@/lib/rpc-manager";

export type ParallelRunStatus = "running" | "complete" | "aborted" | "error";
export type WorkerStatus = "pending" | "running" | "complete" | "aborted" | "error";

export interface WorkerSpec {
  name: string;
  task: string;
}

export interface ParallelRunEvent {
  type: "worker_start" | "worker_event" | "worker_complete" | "worker_error" | "run_complete" | "run_aborted" | "run_error";
  runId: string;
  workerId?: string;
  event?: AgentEvent;
  result?: string;
  error?: string;
  summary?: string;
}

export interface WorkerRunState extends WorkerSpec {
  sessionId?: string;
  status: WorkerStatus;
  result?: string;
  error?: string;
}

export interface ParallelRunState {
  runId: string;
  cwd: string;
  message: string;
  status: ParallelRunStatus;
  workers: WorkerRunState[];
  events: ParallelRunEvent[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
}
