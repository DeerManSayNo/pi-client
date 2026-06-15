import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { listCollaborationRuns, startCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import type { CollaborationRunMode, CollaborationWorkerSpec } from "@/lib/parallel-agent/collaboration-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeMode(value: unknown): CollaborationRunMode {
  return value === "isolated_coding" ? "isolated_coding" : "analysis";
}

function normalizeWorkers(value: unknown): CollaborationWorkerSpec[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const workers: CollaborationWorkerSpec[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as { name?: unknown; task?: unknown };
    if (typeof record.name !== "string" || !record.name.trim()) return null;
    if (typeof record.task !== "string" || !record.task.trim()) return null;
    workers.push({ name: record.name.trim(), task: record.task.trim() });
  }
  return workers;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      cwd?: unknown;
      message?: unknown;
      mode?: unknown;
      workers?: unknown;
      parentSessionId?: unknown;
      parentEntryId?: unknown;
      allowDirtyWorktree?: unknown;
    };

    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }
    if (typeof body.message !== "string" || !body.message.trim()) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const workers = normalizeWorkers(body.workers);
    if (!workers) {
      return NextResponse.json({ error: "workers must be a non-empty array of { name, task }" }, { status: 400 });
    }
    if (workers.length > 10) {
      return NextResponse.json({ error: "Maximum 10 workers allowed" }, { status: 400 });
    }

    const state = await startCollaborationRun({
      cwd: body.cwd,
      message: body.message,
      workers,
      mode: normalizeMode(body.mode),
      parentSessionId: typeof body.parentSessionId === "string" && body.parentSessionId.trim() ? body.parentSessionId.trim() : undefined,
      parentEntryId: typeof body.parentEntryId === "string" && body.parentEntryId.trim() ? body.parentEntryId.trim() : undefined,
      allowDirtyWorktree: body.allowDirtyWorktree === true,
    });
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json(listCollaborationRuns());
}
