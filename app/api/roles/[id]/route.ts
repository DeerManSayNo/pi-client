import { NextResponse } from "next/server";
import { deleteRole, readRoles, updateRole } from "@/lib/roles";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json();
    const role = updateRole(id, body);
    if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 });
    return NextResponse.json({ role });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deleteRole(id);
  return NextResponse.json({ ok, roles: readRoles() }, { status: ok ? 200 : 400 });
}
