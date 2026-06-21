import path from "path";
import { addAllowedRoot } from "@/lib/file-access";
import { ensureRpcSession, SessionNotFoundError } from "@/lib/agent-runtime/session-service";
import { getAgentEventStore } from "@/lib/agent-runtime/event-store";

export const dynamic = "force-dynamic";

function resolveAfterSeq(req: Request): number | undefined {
  const url = new URL(req.url);
  const raw = url.searchParams.get("after") ?? req.headers.get("last-event-id");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let session;
  try {
    session = await ensureRpcSession(id);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return new Response("Session not found", { status: 404 });
    }
    return new Response(`Failed to start agent: ${error}`, { status: 500 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: id });

      const afterSeq = resolveAfterSeq(req);
      for (const stored of getAgentEventStore().getSince(id, afterSeq)) {
        encode({
          ...stored.event,
          seq: stored.seq,
          runId: stored.runId,
          createdAt: stored.createdAt,
          ...(stored.turnId ? { turnId: stored.turnId } : {}),
        });
      }

      const unsubscribe = session.onEvent((event) => {
        if (event && typeof event === "object" && "type" in event && event.type === "agent_file_changed") {
          const filePath = (event as { filePath?: unknown }).filePath;
          if (typeof filePath === "string" && filePath.trim()) {
            addAllowedRoot(path.dirname(filePath));
          }
        }
        encode(event);
      });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
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
