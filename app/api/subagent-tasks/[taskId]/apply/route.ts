import { NextResponse } from "next/server";
import { applyCollaborationPatches } from "@/lib/parallel-agent/collaboration-orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  try {
    const body = await request.json().catch(() => ({})) as { workerNames?: unknown; workerIds?: unknown; files?: unknown };
    const names = Array.isArray(body.workerNames) ? body.workerNames : Array.isArray(body.workerIds) ? body.workerIds : [];
    if (names.some((name) => typeof name !== "string" || !name.trim())) {
      return NextResponse.json({ error: "workerNames must be a string array" }, { status: 400 });
    }
    const files = Array.isArray(body.files) ? body.files.map((file) => typeof file === "string" ? file.trim() : "").filter(Boolean) : undefined;
    const result = await applyCollaborationPatches(taskId, names.map((name) => String(name).trim()), files);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
