import { NextResponse } from "next/server";
import { abortCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const ok = await abortCollaborationRun(runId);
  if (!ok) {
    return NextResponse.json({ error: "Run not found or cannot be aborted" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
