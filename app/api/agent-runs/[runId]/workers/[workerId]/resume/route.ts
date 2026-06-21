import { NextResponse } from "next/server";
import { continueCollaborationWorker, getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string; workerId: string }> },
) {
  const { runId, workerId } = await params;
  const state = getCollaborationRun(runId);
  if (!state) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const worker = state.workers.find((item) => item.workerId === workerId || item.name === workerId);
  if (!worker?.sessionId) return NextResponse.json({ error: "Worker session is not available yet" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown; openOnly?: unknown };
  if (body.openOnly === true) return NextResponse.json({ sessionId: worker.sessionId });
  try {
    const updated = await continueCollaborationWorker(runId, workerId, typeof body.prompt === "string" ? body.prompt : undefined);
    return NextResponse.json({ sessionId: worker.sessionId, run: updated });
  } catch (error) {
    return NextResponse.json({ error: String(error), sessionId: worker.sessionId }, { status: 500 });
  }
}
