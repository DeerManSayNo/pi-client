import { getCollaborationRun, subscribeCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import type { CollaborationRunEvent } from "@/lib/parallel-agent/collaboration-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const state = getCollaborationRun(taskId);
  if (!state) return new Response("Task not found", { status: 404 });

  const stream = new ReadableStream({
    start(controller) {
      const encode = (event: CollaborationRunEvent) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      for (const event of state.events) encode(event);
      const unsubscribe = subscribeCollaborationRun(taskId, (event) => {
        try { encode(event); } catch { /* controller closed */ }
      });
      const heartbeat = setInterval(() => {
        try { controller.enqueue(new TextEncoder().encode(":\n\n")); } catch { /* controller closed */ }
      }, 30_000);

      req.signal?.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
