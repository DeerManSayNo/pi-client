import type {
  CollaborationRunSnapshot,
  CollaborationRunState,
} from "./collaboration-types";

/**
 * 脱敏：worker session 是内部执行上下文，不对外暴露 sessionId / worktreePath。
 * 前端 tag 只需要展示名称、状态、结果、diff 统计。
 *
 * route.ts（HTTP GET 快照）与 events/route.ts（SSE 推送快照）共用此函数，
 * 保证两条出口的脱敏行为完全一致，避免某条出口漏脱敏导致 session 泄露。
 */
export function sanitizeCollaborationRun(
  state: CollaborationRunState | CollaborationRunSnapshot,
): CollaborationRunSnapshot {
  return {
    ...state,
    workers: state.workers.map((worker) => {
      const { sessionId: _sessionId, worktreePath: _worktreePath, ...rest } = worker;
      return rest;
    }),
  };
}
