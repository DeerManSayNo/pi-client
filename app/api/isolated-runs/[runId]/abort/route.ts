import { NextResponse } from "next/server";
import { abortIsolatedRun } from "@/lib/parallel-agent/isolated-orchestrator";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const success = await abortIsolatedRun(runId);
  if (!success) {
    return NextResponse.json({ error: "Run not found or already completed" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
