"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ApplyCollaborationPatchesResult,
  CollaborationRunEvent,
  CollaborationRunSnapshot,
  CollaborationRunState,
  CollaborationRunStatus,
  CollaborationWorkerState,
  CollaborationWorkerStatus,
} from "@/lib/parallel-agent/collaboration-types";

const RUN_STATUSES = new Set<CollaborationRunStatus>(["setting_up", "running", "complete", "aborted", "error", "applying", "applied", "recoverable"]);
const WORKER_STATUSES = new Set<CollaborationWorkerStatus>(["pending", "running", "complete", "aborted", "error"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function normalizeRunStatus(value: unknown): CollaborationRunStatus {
  return typeof value === "string" && RUN_STATUSES.has(value as CollaborationRunStatus) ? value as CollaborationRunStatus : "complete";
}

function normalizeWorkerStatus(value: unknown): CollaborationWorkerStatus {
  return typeof value === "string" && WORKER_STATUSES.has(value as CollaborationWorkerStatus) ? value as CollaborationWorkerStatus : "pending";
}

function normalizeWorker(value: unknown): CollaborationWorkerState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as {
    name?: unknown;
    task?: unknown;
    workerId?: unknown;
    title?: unknown;
    instructions?: unknown;
    agentType?: CollaborationWorkerState["agentType"];
    capability?: CollaborationWorkerState["capability"];
    model?: CollaborationWorkerState["model"];
    sessionId?: unknown;
    status?: unknown;
    result?: unknown;
    error?: unknown;
    worktreePath?: unknown;
    diff?: unknown;
    diffStats?: unknown;
    appliedFiles?: unknown;
    conflictFiles?: unknown;
  };
  const title = asString(record.title);
  const instructions = asString(record.instructions);
  const task = asString(record.task) ?? instructions ?? "";
  return {
    name: asString(record.name) ?? title ?? "Subagent",
    task,
    workerId: asString(record.workerId),
    title,
    instructions: instructions ?? task,
    agentType: record.agentType,
    capability: record.capability,
    model: record.model,
    sessionId: asString(record.sessionId),
    status: normalizeWorkerStatus(record.status),
    result: asString(record.result),
    error: asString(record.error),
    worktreePath: asString(record.worktreePath),
    diff: asString(record.diff),
    diffStats: asString(record.diffStats),
    appliedFiles: asStringArray(record.appliedFiles),
    conflictFiles: asStringArray(record.conflictFiles),
  };
}

function normalizeWorkers(value: unknown): CollaborationWorkerState[] {
  return Array.isArray(value) ? value.flatMap((worker) => {
    const normalized = normalizeWorker(worker);
    return normalized ? [normalized] : [];
  }) : [];
}

function normalizeEvents(value: unknown): CollaborationRunEvent[] {
  return Array.isArray(value) ? value.flatMap((event): CollaborationRunEvent[] => {
    if (typeof event !== "object" || event === null) return [];
    const record = event as CollaborationRunEvent;
    return [{
      ...record,
      runId: asString(record.runId) ?? "",
      workerId: asString(record.workerId),
      timestamp: asString(record.timestamp),
      result: asString(record.result),
      error: asString(record.error),
      summary: asString(record.summary),
      diff: asString(record.diff),
      diffStats: asString(record.diffStats),
      files: asStringArray(record.files),
    }];
  }) : [];
}

function normalizeState(state: CollaborationRunState): CollaborationRunState {
  return {
    ...state,
    runId: asString(state.runId) ?? "",
    cwd: asString(state.cwd) ?? "",
    title: asString(state.title),
    message: asString(state.message) ?? "",
    status: normalizeRunStatus(state.status),
    workers: normalizeWorkers(state.workers),
    events: normalizeEvents(state.events),
    createdAt: asString(state.createdAt) ?? new Date().toISOString(),
    updatedAt: asString(state.updatedAt) ?? new Date().toISOString(),
    summary: asString(state.summary),
    error: asString(state.error),
  };
}

function snapshotToState(snapshot: CollaborationRunSnapshot): CollaborationRunState {
  return normalizeState({
    runId: snapshot.runId,
    cwd: "",
    message: snapshot.message,
    mode: snapshot.mode,
    status: snapshot.status,
    workers: normalizeWorkers(snapshot.workers),
    events: normalizeEvents(snapshot.events),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    summary: snapshot.summary,
    error: snapshot.error,
  });
}

function applyEvent(state: CollaborationRunState, event: CollaborationRunEvent): CollaborationRunState {
  const next: CollaborationRunState = {
    ...state,
    events: [...state.events, event].slice(-500),
    updatedAt: new Date().toISOString(),
    workers: state.workers.map((worker) => ({ ...worker })),
  };
  const worker = event.workerId
    ? next.workers.find((item) => item.workerId === event.workerId || item.name === event.workerId)
    : undefined;

  switch (event.type) {
    case "task_created":
      next.summary = event.summary ?? next.summary;
      break;
    case "worker_start":
    case "worker_resumed":
      if (worker) worker.status = "running";
      next.status = "running";
      break;
    case "worker_complete":
      if (worker) {
        worker.status = "complete";
        worker.result = event.result;
      }
      break;
    case "worker_error":
      if (worker) {
        worker.status = "error";
        worker.error = event.error;
      }
      break;
    case "worker_diff_ready":
      if (worker) {
        worker.diff = event.diff;
        worker.diffStats = event.diffStats;
      }
      break;
    case "run_complete":
      next.status = "complete";
      next.summary = event.summary ?? next.summary;
      break;
    case "run_error":
      next.status = "error";
      next.error = event.error ?? next.error;
      next.summary = event.summary ?? next.summary;
      break;
    case "run_aborted":
      next.status = "aborted";
      for (const item of next.workers) {
        if (item.status === "pending" || item.status === "running") item.status = "aborted";
      }
      break;
    case "run_interrupted":
      next.status = "recoverable";
      next.error = event.error ?? next.error;
      break;
    case "task_summary_ready":
      next.summary = event.summary ?? next.summary;
      break;
    case "patch_apply_started":
      next.status = "applying";
      break;
    case "patch_applied":
      next.status = "applied";
      if (worker && event.files?.length) {
        worker.appliedFiles = [...new Set([...(worker.appliedFiles ?? []), ...event.files])];
      }
      break;
    case "patch_apply_error":
      next.status = "complete";
      if (worker && event.files?.length) {
        worker.conflictFiles = [...new Set([...(worker.conflictFiles ?? []), ...event.files])];
      }
      break;
  }
  return next;
}

export function useCollaborationRun(snapshot: CollaborationRunSnapshot | null) {
  const [state, setState] = useState<CollaborationRunState | null>(() => snapshot ? snapshotToState(snapshot) : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(snapshot ? snapshotToState(snapshot) : null);
    setError(null);
  }, [snapshot]);

  const runId = snapshot?.runId;
  const status = state?.status ?? snapshot?.status;
  const shouldConnect = !!runId && (status === "setting_up" || status === "running" || status === "applying" || status === "recoverable");

  useEffect(() => {
    if (!runId || !shouldConnect) return;
    let cancelled = false;
    fetch(`/api/agent-runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((nextState: CollaborationRunState | null) => {
        if (!cancelled && nextState) setState(normalizeState(nextState));
      })
      .catch((err: unknown) => {
        if (!cancelled && shouldConnect) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [runId, shouldConnect]);

  useEffect(() => {
    if (!runId || !shouldConnect) return;
    const source = new EventSource(`/api/agent-runs/${encodeURIComponent(runId)}/events`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as CollaborationRunEvent;
        setState((current) => current ? applyEvent(current, event) : current);
      } catch {
        // ignore malformed events
      }
    };
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [runId, shouldConnect]);

  const abort = useCallback(async () => {
    if (!runId) return;
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/abort`, { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
  }, [runId]);

  const applyPatches = useCallback(async (workerNames: string[], files?: string[]): Promise<ApplyCollaborationPatchesResult> => {
    if (!runId) throw new Error("Run id is missing");
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerNames, ...(files?.length ? { files } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body as ApplyCollaborationPatchesResult;
  }, [runId]);

  const continueWorker = useCallback(async (workerId: string, prompt: string) => {
    if (!runId) throw new Error("Run id is missing");
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/workers/${encodeURIComponent(workerId)}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body as { sessionId?: string };
  }, [runId]);

  return { state, error, abort, applyPatches, continueWorker };
}
