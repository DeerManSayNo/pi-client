import { refreshIndex } from "@/lib/code-index/indexer";
import { getIndexStatus } from "@/lib/code-index/database";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { cwd?: unknown };
  if (typeof body.cwd !== "string" || !body.cwd.trim()) {
    return Response.json({ error: "cwd is required" }, { status: 400 });
  }
  const result = await refreshIndex(body.cwd);
  const status = await getIndexStatus(body.cwd);
  return Response.json({ ...status, ...result });
}
