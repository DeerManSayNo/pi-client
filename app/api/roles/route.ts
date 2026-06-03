import { NextResponse } from "next/server";
import { createRole, readRoles } from "@/lib/roles";

export async function GET() {
  return NextResponse.json({ roles: readRoles() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { name?: string; description?: string; basePrompt?: string };
    if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
    return NextResponse.json({ role: createRole({ name: body.name, description: body.description, basePrompt: body.basePrompt }) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
