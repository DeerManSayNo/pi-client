import { subscribeRun } from "@/lib/parallel-agent/run-store";
import type { ParallelRunEvent } from "@/lib/parallel-agent/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: ParallelRunEvent) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      encode({ type: "worker_start", runId, event: undefined });

      const unsubscribe = subscribeRun(runId, (event) => {
        try { encode(event); } catch { /* controller closed */ }
      });

      const heartbeat = setInterval(() => {
        try { controller.enqueue(new TextEncoder().encode(":\n\n")); } catch { /* closed */ }
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
