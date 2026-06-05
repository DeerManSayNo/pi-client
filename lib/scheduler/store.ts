// ============================================================================
// Task store — JSON file persistence at ~/.pi/agent/scheduled-tasks.json
// ============================================================================

import fs from "fs";
import path from "path";
import type { ScheduledTask, TaskLog, TaskStore } from "./types";

const MAX_LOGS_PER_TASK = 50;

function getStorePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const dir = path.join(home, ".pi", "agent");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "scheduled-tasks.json");
}

export function loadTasks(): ScheduledTask[] {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const store = JSON.parse(raw) as TaskStore;
    const tasks = Array.isArray(store.tasks) ? store.tasks : [];
    // Ensure logs field exists on all tasks (migration)
    for (const t of tasks) {
      if (!Array.isArray(t.logs)) (t as ScheduledTask).logs = [];
    }
    return tasks;
  } catch {
    return [];
  }
}

export function saveTasks(tasks: ScheduledTask[]): void {
  const storePath = getStorePath();
  const store: TaskStore = { tasks };
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

export function getTask(id: string): ScheduledTask | undefined {
  const tasks = loadTasks();
  return tasks.find((t) => t.id === id);
}

export function addTask(task: ScheduledTask): ScheduledTask {
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

export function updateTask(id: string, updates: Partial<ScheduledTask>): ScheduledTask | null {
  const tasks = loadTasks();
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return null;
  tasks[index] = { ...tasks[index], ...updates, id }; // id is immutable
  saveTasks(tasks);
  return tasks[index];
}

export function appendTaskLog(taskId: string, log: TaskLog): boolean {
  const tasks = loadTasks();
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index === -1) return false;
  const task = tasks[index];
  const logs = [log, ...(task.logs || [])].slice(0, MAX_LOGS_PER_TASK);
  tasks[index] = { ...task, logs };
  saveTasks(tasks);
  return true;
}

export function deleteTask(id: string): boolean {
  const tasks = loadTasks();
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) return false;
  tasks.splice(index, 1);
  saveTasks(tasks);
  return true;
}
