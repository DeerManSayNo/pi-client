// ============================================================================
// GET    /api/scheduler/[id] — get a single task
// PATCH  /api/scheduler/[id] — update a task
// DELETE /api/scheduler/[id] — delete a task
// ============================================================================

import { NextResponse } from "next/server";
import { getTask, modifyTask, removeTask, getJobStatus } from "@/lib/scheduler/engine";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const task = getTask(id);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ task: { ...task, jobStatus: getJobStatus(task.id) } });
  } catch (err) {
    console.error("[scheduler API] GET task error:", err);
    return NextResponse.json({ error: "Failed to get task" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      name?: string;
      cron?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    };

    // Only allow updating specific fields
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.cron !== undefined) updates.cron = body.cron;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.config !== undefined) updates.config = body.config;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const updated = modifyTask(id, updates as Parameters<typeof modifyTask>[1]);
    if (!updated) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json({ task: { ...updated, jobStatus: getJobStatus(updated.id) } });
  } catch (err) {
    console.error("[scheduler API] PATCH task error:", err);
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const removed = removeTask(id);
    if (!removed) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[scheduler API] DELETE task error:", err);
    return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
  }
}
