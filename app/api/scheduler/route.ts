// ============================================================================
// GET  /api/scheduler — list all tasks
// POST /api/scheduler — create a new task
// ============================================================================

import { NextResponse } from "next/server";
import { getTasks, createTask, getJobStatus } from "@/lib/scheduler/engine";
import type { ScheduledTask } from "@/lib/scheduler/types";

export async function GET(): Promise<NextResponse> {
  try {
    const tasks = getTasks();
    // Enrich with job status
    const enriched = tasks.map((task) => ({
      ...task,
      jobStatus: getJobStatus(task.id),
    }));
    return NextResponse.json({ tasks: enriched });
  } catch (err) {
    console.error("[scheduler API] GET error:", err);
    return NextResponse.json({ error: "Failed to list tasks" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      name?: string;
      type?: string;
      cron?: string;
      config?: Record<string, unknown>;
    };

    const { name, type, cron: cronExpression, config } = body;

    // Validation
    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Task name is required" }, { status: 400 });
    }
    if (type !== "prompt" && type !== "shell") {
      return NextResponse.json({ error: 'Task type must be "prompt" or "shell"' }, { status: 400 });
    }
    if (!cronExpression || typeof cronExpression !== "string") {
      return NextResponse.json({ error: "Cron expression is required" }, { status: 400 });
    }
    if (!config || typeof config !== "object") {
      return NextResponse.json({ error: "Task config is required" }, { status: 400 });
    }

    // Validate config based on type
    if (type === "prompt") {
      const promptConfig = config as { cwd?: string; message?: string };
      if (!promptConfig.cwd || !promptConfig.message) {
        return NextResponse.json({ error: "Prompt tasks require cwd and message in config" }, { status: 400 });
      }
    } else if (type === "shell") {
      const shellConfig = config as { cwd?: string; command?: string };
      if (!shellConfig.command) {
        return NextResponse.json({ error: "Shell tasks require command in config" }, { status: 400 });
      }
    }

    const task = createTask(name.trim(), type, cronExpression.trim(), config as unknown as ScheduledTask["config"]);
    return NextResponse.json({ task: { ...task, jobStatus: getJobStatus(task.id) } }, { status: 201 });
  } catch (err) {
    console.error("[scheduler API] POST error:", err);
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
