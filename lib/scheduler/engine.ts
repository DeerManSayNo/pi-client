// ============================================================================
// Scheduler engine — manages node-cron jobs, syncs with persistent store
// ============================================================================

import cron, { type ScheduledTask as CronScheduledTask } from "node-cron";
import { loadTasks, addTask, updateTask, deleteTask } from "./store";
import { executeTask } from "./runner";
import type { ScheduledTask, PromptTaskConfig } from "./types";

// Map of task id → cron ScheduledTask instance
const runningJobs = new Map<string, CronScheduledTask>();

let started = false;

function scheduleJob(task: ScheduledTask): void {
  if (!task.enabled) return;

  // Validate cron expression
  if (!cron.validate(task.cron)) {
    console.warn(`[scheduler] Invalid cron expression for task "${task.name}": ${task.cron}`);
    return;
  }

  // Remove existing job if any
  unscheduleJob(task.id);

  try {
    const job = cron.schedule(task.cron, () => {
      void executeTask(task);
    }, {
      name: task.name,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    runningJobs.set(task.id, job);
    console.log(`[scheduler] Scheduled task "${task.name}" with cron "${task.cron}"`);
  } catch (err) {
    console.error(`[scheduler] Failed to schedule task "${task.name}":`, err);
  }
}

function unscheduleJob(taskId: string): void {
  const existing = runningJobs.get(taskId);
  if (existing) {
    existing.stop();
    existing.destroy?.();
    runningJobs.delete(taskId);
  }
}

export function startScheduler(): void {
  if (started) return;
  started = true;

  const tasks = loadTasks();
  console.log(`[scheduler] Starting scheduler with ${tasks.length} task(s)`);

  for (const task of tasks) {
    scheduleJob(task);
  }
}

export function stopScheduler(): void {
  for (const [id] of runningJobs) {
    unscheduleJob(id);
  }
  started = false;
  console.log("[scheduler] Scheduler stopped");
}

// ============================================================================
// Public API — called by API routes to manage tasks at runtime
// ============================================================================

export function getTasks(): ScheduledTask[] {
  return loadTasks();
}

export function getTask(id: string): ScheduledTask | undefined {
  return loadTasks().find((t) => t.id === id);
}

export function createTask(
  name: string,
  type: "prompt",
  cronExpression: string,
  config: PromptTaskConfig
): ScheduledTask {
  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    name,
    type,
    cron: cronExpression,
    enabled: true,
    config,
    createdAt: new Date().toISOString(),
    runCount: 0,
    logs: [],
  };

  addTask(task);
  scheduleJob(task);
  console.log(`[scheduler] Created task "${task.name}" (${task.id})`);
  return task;
}

export function modifyTask(
  id: string,
  updates: Partial<Pick<ScheduledTask, "name" | "cron" | "enabled" | "config">>
): ScheduledTask | null {
  const updated = updateTask(id, updates);
  if (!updated) return null;

  // Reschedule: if disabled, unschedule; otherwise re-schedule with new config
  unscheduleJob(id);
  if (updated.enabled) {
    scheduleJob(updated);
  }

  return updated;
}

export function removeTask(id: string): boolean {
  unscheduleJob(id);
  const result = deleteTask(id);
  if (result) {
    console.log(`[scheduler] Removed task ${id}`);
  }
  return result;
}

export function getJobStatus(taskId: string): { scheduled: boolean; nextRun: Date | null } {
  const job = runningJobs.get(taskId);
  if (!job) return { scheduled: false, nextRun: null };
  try {
    const nextRun = job.getNextRun();
    return { scheduled: true, nextRun };
  } catch {
    return { scheduled: true, nextRun: null };
  }
}

export function runTaskNow(id: string): boolean {
  const task = getTask(id);
  if (!task) return false;
  void executeTask(task);
  return true;
}
