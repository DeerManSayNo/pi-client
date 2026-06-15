import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { listCollaborationRuns, startCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { collaborationRunToSubagentTask } from "@/lib/parallel-agent/collaboration-types";
import type { CollaborationRunState, CollaborationWorkerSpec, SubagentRunPlacement, SubagentTaskMode } from "@/lib/parallel-agent/collaboration-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeTaskMode(value: unknown): SubagentTaskMode | undefined {
  return value === "ask" || value === "code" || value === "parallel" || value === "review" || value === "custom" ? value : undefined;
}

function normalizePlacement(value: unknown): SubagentRunPlacement | undefined {
  return value === "foreground" || value === "background" ? value : undefined;
}

function normalizeWorkers(value: unknown): CollaborationWorkerSpec[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CollaborationWorkerSpec[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as { name?: unknown; title?: unknown; task?: unknown; instructions?: unknown };
    const name = typeof record.name === "string" ? record.name : typeof record.title === "string" ? record.title : "";
    const task = typeof record.task === "string" ? record.task : typeof record.instructions === "string" ? record.instructions : "";
    return name.trim() && task.trim() ? [{ name: name.trim(), task: task.trim() }] : [];
  }).slice(0, 10);
}

function listTaskTitle(run: CollaborationRunState): string {
  const message = typeof run.message === "string" ? run.message : "";
  return run.title ?? (message.trim().split(/\s+/).slice(0, 8).join(" ") || "Subagent 任务");
}

function runToListTask(run: CollaborationRunState) {
  const workers = Array.isArray(run.workers) ? run.workers : [];
  const events = Array.isArray(run.events) ? run.events : [];
  return {
    taskId: run.runId,
    parentSessionId: run.parentSessionId,
    parentEntryId: run.parentEntryId,
    title: listTaskTitle(run),
    prompt: typeof run.message === "string" ? run.message : "",
    status: run.status,
    mode: run.taskMode ?? (run.mode === "isolated_coding" ? "code" : "ask"),
    runPlacement: run.runPlacement ?? "background",
    workers: workers.flatMap((worker, index) => {
      if (typeof worker !== "object" || worker === null) return [];
      return [{
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
      }];
    }),
    events,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary: run.summary,
    error: run.error,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      cwd?: unknown;
      prompt?: unknown;
      message?: unknown;
      title?: unknown;
      mode?: unknown;
      placement?: unknown;
      workers?: unknown;
      parentSessionId?: unknown;
      parentEntryId?: unknown;
      allowDirtyWorktree?: unknown;
    };

    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : typeof body.message === "string" ? body.message.trim() : "";
    if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    if (!existsSync(cwd)) return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });

    const workers = normalizeWorkers(body.workers);
    if (workers && workers.length === 0) return NextResponse.json({ error: "workers must contain valid name/task pairs" }, { status: 400 });

    const state = await startCollaborationRun({
      cwd,
      message: prompt,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined,
      taskMode: normalizeTaskMode(body.mode),
      runPlacement: normalizePlacement(body.placement),
      workers,
      parentSessionId: typeof body.parentSessionId === "string" && body.parentSessionId.trim() ? body.parentSessionId.trim() : undefined,
      parentEntryId: typeof body.parentEntryId === "string" && body.parentEntryId.trim() ? body.parentEntryId.trim() : undefined,
      allowDirtyWorktree: body.allowDirtyWorktree === true,
    });
    return NextResponse.json(collaborationRunToSubagentTask(state));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  const runs = listCollaborationRuns()
    .filter((run) => typeof run.runId === "string" && (!sessionId || run.parentSessionId === sessionId));
  return NextResponse.json(runs.map(runToListTask));
}
