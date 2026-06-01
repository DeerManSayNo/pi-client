import { NextResponse } from "next/server";
import { listRpcSessionStates } from "@/lib/rpc-manager";

// GET /api/agent/running - list currently running in-process agent sessions
export async function GET() {
  const sessions = listRpcSessionStates();
  return NextResponse.json({
    sessions,
    runningSessionIds: sessions
      .filter((session) => session.isStreaming || session.isCompacting)
      .map((session) => session.sessionId),
  });
}
