import { NextResponse } from "next/server";
import { listRpcSessionStates } from "@/lib/rpc-manager";

// GET /api/agent/running - list currently running in-process agent sessions
export async function GET() {
  try {
    const sessions = listRpcSessionStates().filter((session) => session.isStreaming || session.isCompacting);
    return NextResponse.json({
      sessions,
      runningSessionIds: sessions.map((session) => session.sessionId),
    });
  } catch (error) {
    console.error("[/api/agent/running]", error);
    return NextResponse.json({ sessions: [], runningSessionIds: [] }, { status: 200 });
  }
}
