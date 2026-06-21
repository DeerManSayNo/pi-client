import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { ensureRpcSession, SessionNotFoundError } from "@/lib/agent-runtime/session-service";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };

    const session = await ensureRpcSession(id);
    const result = await session.send(body);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    const status = session.getStatus();
    return NextResponse.json({ running: true, state, status });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
