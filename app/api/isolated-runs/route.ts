import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { startIsolatedRun, listIsolatedRuns } from "@/lib/parallel-agent/isolated-orchestrator";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      cwd?: unknown;
      message?: unknown;
      workers?: unknown;
    };

    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }
    if (typeof body.message !== "string" || !body.message.trim()) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    if (!Array.isArray(body.workers) || body.workers.length === 0) {
      return NextResponse.json({ error: "workers must be a non-empty array" }, { status: 400 });
    }

    for (const w of body.workers) {
      if (typeof w.name !== "string" || !w.name.trim() || typeof w.task !== "string" || !w.task.trim()) {
        return NextResponse.json({ error: "each worker must have name and task strings" }, { status: 400 });
      }
    }

    // Limit max workers to prevent resource exhaustion
    if (body.workers.length > 10) {
      return NextResponse.json({ error: "Maximum 10 workers allowed" }, { status: 400 });
    }

    const state = await startIsolatedRun(
      body.cwd,
      body.message,
      body.workers as Array<{ name: string; task: string }>,
    );

    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json(listIsolatedRuns());
}
