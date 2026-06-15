import { NextResponse } from "next/server";
import { getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { collaborationRunToSubagentTask } from "@/lib/parallel-agent/collaboration-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const state = getCollaborationRun(taskId);
  if (!state) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json(collaborationRunToSubagentTask(state));
}
