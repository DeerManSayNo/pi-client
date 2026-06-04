import { subscribeIsolatedRun } from "@/lib/parallel-agent/isolated-orchestrator";
import type { IsolatedRunEvent } from "@/lib/parallel-agent/isolated-types";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: IsolatedRunEvent) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Send initial connected event
      encode({ type: "run_setup_complete", runId });

      const unsubscribe = subscribeIsolatedRun(runId, (event) => {
        try {
          encode(event);
        } catch {
          // Controller already closed
        }
      });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // Closed
        }
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
