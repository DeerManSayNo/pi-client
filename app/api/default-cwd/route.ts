import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// POST /api/default-cwd
// Returns ~/pi-cwd (a fixed directory — NOT date-stamped, so all default-project
// sessions stay grouped under one session directory instead of being split by day).
export async function POST() {
  try {
    const dir = join(homedir(), "pi-cwd");
    mkdirSync(dir, { recursive: true });
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
