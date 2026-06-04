import { searchIndex } from "@/lib/code-index/search";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { cwd?: unknown; query?: unknown; path?: unknown; limit?: unknown };
  if (typeof body.cwd !== "string" || !body.cwd.trim()) {
    return Response.json({ error: "cwd is required" }, { status: 400 });
  }
  if (typeof body.query !== "string" || !body.query.trim()) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }
  const results = await searchIndex(body.cwd, body.query, {
    path: typeof body.path === "string" ? body.path : undefined,
    limit: typeof body.limit === "number" ? body.limit : undefined,
  });
  return Response.json({ results });
}
