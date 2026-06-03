// ============================================================================
// Scheduler types — shared between engine, store, API, and UI
// ============================================================================

export interface PromptTaskConfig {
  cwd: string;
  message: string;
  model?: { provider: string; modelId: string };
  toolNames?: string[];
}

export interface ShellTaskConfig {
  cwd: string;
  command: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  type: "prompt" | "shell";
  cron: string;
  enabled: boolean;
  config: PromptTaskConfig | ShellTaskConfig;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: "success" | "error";
  lastError?: string;
  /** How many times this task has been executed */
  runCount: number;
}

export interface TaskStore {
  tasks: ScheduledTask[];
}

// For the API response — excludes internal fields if needed
export type ScheduledTaskSummary = Pick<
  ScheduledTask,
  "id" | "name" | "type" | "cron" | "enabled" | "createdAt" | "lastRunAt" | "lastResult" | "runCount"
>;
