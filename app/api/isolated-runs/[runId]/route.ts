import { NextResponse } from "next/server";
import { getIsolatedRun } from "@/lib/parallel-agent/isolated-orchestrator";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const state = getIsolatedRun(runId);
  if (!state) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(state);
}
