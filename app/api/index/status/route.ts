import { getIndexStatus } from "@/lib/code-index/database";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return Response.json({ error: "cwd is required" }, { status: 400 });
  return Response.json(await getIndexStatus(cwd));
}
