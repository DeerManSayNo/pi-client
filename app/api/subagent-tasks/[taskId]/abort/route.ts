import { NextResponse } from "next/server";
import { abortCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const ok = await abortCollaborationRun(taskId);
  if (!ok) return NextResponse.json({ error: "Task not found or cannot be aborted" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
