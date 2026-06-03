import { NextResponse } from "next/server";
import { readMcpServers, writeMcpServers } from "@/lib/mcp-config";

export async function GET() {
  return NextResponse.json({ servers: readMcpServers() });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { servers?: unknown };
    if (!Array.isArray(body.servers)) return NextResponse.json({ error: "servers must be an array" }, { status: 400 });
    return NextResponse.json({ servers: writeMcpServers(body.servers as never[]) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
