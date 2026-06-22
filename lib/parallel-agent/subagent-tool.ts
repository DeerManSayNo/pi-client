import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startCollaborationRun, waitForCollaborationRun } from "./collaboration-orchestrator";
import type { CollaborationRunState, CollaborationWorkerState, SubagentTaskMode } from "./collaboration-types";

export const SUBAGENT_TOOL_NAME = "spawn_subagent";

export interface CreateSubagentToolOptions {
  /** Resolved at execution time so the tool can attach the run to its parent session. */
  getParentSessionId?: () => string | undefined;
  /** Optional parent entry id (e.g. the current tool-call turn). */
  getParentEntryId?: () => string | undefined;
  /** Resolved at execution time so worker sessions inherit the parent's model.
   *  Without this, workers fall back to modelRegistry's first available model,
   *  which is often a different (and possibly broken) model than the parent. */
  getParentModel?: () => { provider: string; modelId: string } | undefined;
}

/**
 * A tool that lets the main agent delegate a self-contained sub-task to one or
 * more isolated sub-agents. Backed by the collaboration orchestrator: workers
 * run their own agent sessions in parallel; coding-mode workers run in isolated
 * git worktrees and produce reviewable diffs.
 *
 * The tool is always registered (so it can be toggled active at runtime), but
 * whether it appears in the agent's active tool set is controlled by the
 * `set_subagent_enabled` command on AgentSessionWrapper.
 */
export function createSubagentTool(cwd: string, options: CreateSubagentToolOptions = {}) {
  return defineTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description: [
      "Delegate a self-contained sub-task to one or more isolated sub-agents (a 'subagent task').",
      "Each worker runs its own agent session in parallel and returns a result; coding-mode workers run in isolated git worktrees and produce reviewable diffs.",
      "Use this when: (1) you want multiple independent attempts/solutions to compare, (2) a sub-task benefits from focused isolated coding with a diff to review, (3) you want a dedicated review/research pass.",
      "Do NOT use this for simple lookups (use read/grep/code_search) or single quick edits — do those yourself.",
      "Omit `mode` to auto-infer from the message (keywords like 并行/parallel/review/审查/实现/修复).",
    ].join(" "),
    promptSnippet: "spawn_subagent: Delegate a sub-task to isolated sub-agents (parallel attempts / isolated coding / review).",
    parameters: Type.Object({
      message: Type.String({
        description: "The sub-task to delegate. Be specific and self-contained — workers do NOT share your current conversation context.",
      }),
      mode: Type.Optional(Type.Union(
        [
          Type.Literal("ask"),
          Type.Literal("code"),
          Type.Literal("parallel"),
          Type.Literal("review"),
        ],
        { description: "ask = read-only research; code = isolated coding with diff; parallel = multiple independent attempts (default 3); review = dedicated review pass. Omit to auto-infer." },
      )),
      workers: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String({ description: "Short label for the worker, e.g. '方案 A' / 'Security Review'." }),
          task: Type.String({ description: "Self-contained instructions for this worker. Include the goal and any constraints." }),
        }),
        { description: "Custom worker breakdown. Omit to let the planner auto-build workers from the mode." },
      )),
    }),
    executionMode: "parallel" as const,
    execute: async (_toolCallId, params) => {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message) {
        return {
          content: [{ type: "text" as const, text: "spawn_subagent error: `message` is required." }],
          details: undefined,
        };
      }
      const taskMode = (params.mode as SubagentTaskMode | undefined) ?? undefined;
      const workers = Array.isArray(params.workers)
        ? params.workers
            .map((w) => ({
              name: typeof w?.name === "string" ? w.name.trim() : "",
              task: typeof w?.task === "string" ? w.task.trim() : "",
            }))
            .filter((w) => w.name && w.task)
        : undefined;

      let state: CollaborationRunState;
      try {
        state = await startCollaborationRun({
          cwd,
          message,
          taskMode,
          runPlacement: "foreground",
          workers,
          parentSessionId: options.getParentSessionId?.(),
          parentEntryId: options.getParentEntryId?.(),
          parentModel: options.getParentModel?.(),
          // Tool invocations happen mid-turn while the main agent may have
          // uncommitted edits; worktrees branch from HEAD regardless.
          allowDirtyWorktree: true,
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `spawn_subagent failed to start: ${err}` }],
          details: undefined,
        };
      }

      try {
        const finalState = await waitForCollaborationRun(state.runId);
        return {
          content: [{ type: "text" as const, text: formatSubagentResult(finalState) }],
          details: { runId: finalState.runId, status: finalState.status },
        };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        const latest = await safeGetLatest(state.runId);
        return {
          content: [{ type: "text" as const, text: latest ? formatSubagentResult(latest) : `spawn_subagent did not complete: ${err}` }],
          details: { runId: state.runId, status: latest?.status ?? "error" },
        };
      }
    },
  });
}

function formatSubagentResult(run: CollaborationRunState): string {
  const header = `Subagent task「${run.title ?? run.runId}」finished — mode: ${run.taskMode ?? run.mode}, status: ${run.status}.`;
  const parts: string[] = [header, ""];

  for (const worker of run.workers) {
    parts.push(formatWorker(worker));
    parts.push("");
  }

  if (run.summary?.trim()) {
    parts.push("## Aggregated summary");
    parts.push(run.summary.trim());
  }

  if (run.error) {
    parts.push("");
    parts.push(`Task error: ${run.error}`);
  }

  parts.push("");
  parts.push(
    run.mode === "isolated_coding"
      ? "Coding workers produced diffs in isolated worktrees. Ask the user to review/apply them from the collaboration card if needed."
      : "Workers were read-only.",
  );

  return parts.join("\n").trim();
}

function formatWorker(worker: CollaborationWorkerState): string {
  const title = worker.title ?? worker.name;
  const lines: string[] = [`## ${title} (${worker.status})`];
  if (worker.error) {
    lines.push(`Error: ${worker.error}`);
  }
  if (worker.result?.trim()) {
    lines.push(worker.result.trim());
  }
  if (worker.diffStats?.trim()) {
    lines.push("");
    lines.push("Changed files:");
    lines.push(worker.diffStats.trim());
  }
  return lines.join("\n");
}

async function safeGetLatest(runId: string): Promise<CollaborationRunState | null> {
  try {
    const { getCollaborationRun } = await import("./collaboration-store");
    return getCollaborationRun(runId) ?? null;
  } catch {
    return null;
  }
}
