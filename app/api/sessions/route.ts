import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("[/api/sessions]", error);
    return NextResponse.json({ sessions: [] }, { status: 200 });
  }
}
