import { NextResponse } from "next/server";
import { getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { sanitizeCollaborationRun } from "@/lib/parallel-agent/collaboration-sanitize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const state = getCollaborationRun(runId);
  if (!state) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(sanitizeCollaborationRun(state));
}
