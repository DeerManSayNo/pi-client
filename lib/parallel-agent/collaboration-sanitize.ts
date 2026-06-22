import type {
  CollaborationRunSnapshot,
  CollaborationRunState,
} from "./collaboration-types";

/**
 * 脱敏：worktreePath 是内部文件系统路径，不对外暴露。
 * sessionId 保留：前端 SubagentRunCard 需要它来实现"点击 worker tag 跳转到对应 session"。
 *
 * route.ts（HTTP GET 快照）与 events/route.ts（SSE 推送快照）共用此函数，
 * 保证两条出口的脱敏行为完全一致，避免某条出口漏脱敏导致路径泄露。
 */
export function sanitizeCollaborationRun(
  state: CollaborationRunState | CollaborationRunSnapshot,
): CollaborationRunSnapshot {
  return {
    ...state,
    workers: state.workers.map((worker) => {
      const { worktreePath: _worktreePath, ...rest } = worker;
      return rest;
    }),
  };
}
