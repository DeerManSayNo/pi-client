import { NextResponse } from "next/server";
import { applyIsolatedPatches } from "@/lib/parallel-agent/isolated-orchestrator";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  try {
    const body = await request.json().catch(() => ({})) as { workerNames?: unknown };

    if (!Array.isArray(body.workerNames) || body.workerNames.length === 0) {
      return NextResponse.json({ error: "workerNames must be a non-empty array" }, { status: 400 });
    }

    const workerNames = body.workerNames.filter(w => typeof w === "string") as string[];

    if (workerNames.length === 0) {
      return NextResponse.json({ error: "No valid worker names provided" }, { status: 400 });
    }

    const result = await applyIsolatedPatches(runId, workerNames);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("not found") ? 404 : 400 });
  }
}
