// ============================================================================
// POST /api/scheduler/[id]/run — manually trigger a scheduled task
// ============================================================================

import { NextResponse } from "next/server";
import { runTaskNow } from "@/lib/scheduler/engine";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const success = runTaskNow(id);
    if (!success) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[scheduler API] POST run error:", err);
    return NextResponse.json({ error: "Failed to run task" }, { status: 500 });
  }
}
