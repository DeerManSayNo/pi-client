import { createWorkerSession } from "./worker-session";
import { buildWorkerPrompt } from "./prompts";
import { createRun, emitRunEvent, updateRun, setAbort } from "./run-store";
import type { AgentEvent } from "@/lib/rpc-manager";
import type { WorkerSpec, ParallelRunState } from "./types";

export async function startParallelRun(cwd: string, message: string, workers: WorkerSpec[]): Promise<ParallelRunState> {
  const runId = `par_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const state: ParallelRunState = {
    runId,
    cwd,
    message,
    status: "running",
    workers: workers.map(w => ({ ...w, status: "pending" })),
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  createRun(state);

  const abortControllers: Array<() => Promise<void>> = [];
  const aborted = { value: false };

  setAbort(runId, async () => {
    aborted.value = true;
    await Promise.all(abortControllers.map(fn => fn().catch(() => {})));
    updateRun(runId, s => { s.status = "aborted"; });
    emitRunEvent({ type: "run_aborted", runId });
  });

  // Fire and forget
  executeWorkers(cwd, message, workers, runId, abortControllers, aborted).catch(error => {
    updateRun(runId, s => { s.status = "error"; s.error = String(error); });
    emitRunEvent({ type: "run_error", runId, error: String(error) });
  });

  return state;
}

async function executeWorkers(
  cwd: string,
  message: string,
  workers: WorkerSpec[],
  runId: string,
  abortControllers: Array<() => Promise<void>>,
  aborted: { value: boolean },
): Promise<void> {
  const results: Map<string, { task: string; result: string }> = new Map();

  await Promise.all(workers.map(async (worker, index) => {
    if (aborted.value) return;

    try {
      const ws = await createWorkerSession(cwd);
      abortControllers.push(ws.abort);

      updateRun(runId, s => {
        const w = s.workers[index];
        if (w) { w.status = "running"; w.sessionId = ws.sessionId; }
      });
      emitRunEvent({ type: "worker_start", runId, workerId: worker.name, event: undefined });

      // Forward worker events for real-time display
      const unsub = ws.listen((event) => {
        emitRunEvent({ type: "worker_event", runId, workerId: worker.name, event: event as AgentEvent });
      });

      const prompt = buildWorkerPrompt(message, worker.task);
      const result = await ws.sendPrompt(prompt);

      unsub();
      updateRun(runId, s => {
        const w = s.workers[index];
        if (w) { w.status = "complete"; w.result = result; }
      });
      emitRunEvent({ type: "worker_complete", runId, workerId: worker.name, result });
      results.set(worker.name, { task: worker.task, result });
    } catch (error) {
      const errMsg = String(error);
      updateRun(runId, s => {
        const w = s.workers[index];
        if (w) { w.status = "error"; w.error = errMsg; }
      });
      emitRunEvent({ type: "worker_error", runId, workerId: worker.name, error: errMsg });
      results.set(worker.name, { task: worker.task, result: `错误: ${errMsg}` });
    }
  }));

  if (aborted.value) {
    updateRun(runId, s => { s.status = "aborted"; });
    emitRunEvent({ type: "run_aborted", runId });
    return;
  }

  // Build summary
  const workerResults = workers.map(w => ({
    name: w.name,
    task: w.task,
    result: results.get(w.name)?.result ?? "",
  }));

  const summary = workerResults
    .map(w => `### ${w.name}\n${w.result?.slice(0, 500) ?? ""}`)
    .join("\n\n");

  updateRun(runId, s => { s.status = "complete"; s.summary = summary; });
  emitRunEvent({ type: "run_complete", runId, summary });
}
