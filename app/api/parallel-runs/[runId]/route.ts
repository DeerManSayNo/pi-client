import { NextResponse } from "next/server";
import { getRun } from "@/lib/parallel-agent/run-store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const state = getRun(runId);
  if (!state) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(state);
}
