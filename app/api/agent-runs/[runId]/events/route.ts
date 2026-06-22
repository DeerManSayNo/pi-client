import { getCollaborationRun, subscribeCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { sanitizeCollaborationRun } from "@/lib/parallel-agent/collaboration-sanitize";
import type { CollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE 直推完整快照（方案 A）。
 *
 * 连接建立时立即推一次 sanitize 后的完整快照，之后每次事件触发都把最新的
 * sanitize 快照整包推给前端；前端 onmessage 直接 JSON.parse 更新 UI，
 * 不再额外发 HTTP GET 拉快照，消除运行期间的轮询风暴。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!getCollaborationRun(runId)) {
    return new Response("Run not found", { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = (snapshot: CollaborationRunSnapshot) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        } catch {
          /* controller 已关闭，忽略 */
        }
      };

      // 取最新 state，sanitize 后整包推送；run 被清理时关闭流。
      const pushCurrentSnapshot = () => {
        const state = getCollaborationRun(runId);
        if (!state) {
          // run 已被清理：关闭流即可，前端 onerror 会主动 close EventSource，不会卡住。
          cleanup();
          return;
        }
        // events 字段前端不需要（worker_event 携带的 AgentEvent 是开放结构，
        // 可能含 session 标识），推送前剥离，既彻底脱敏又减小每帧体积。
        const sanitized = sanitizeCollaborationRun(state);
        const { events: _events, ...snapshot } = sanitized;
        send(snapshot);
      };

      const unsubscribe = subscribeCollaborationRun(runId, () => {
        pushCurrentSnapshot();
      });
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(":\n\n")); } catch { /* controller closed */ }
      }, 30_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      // 首帧：立即推一次完整快照，前端无需再发 HTTP GET。
      pushCurrentSnapshot();

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
