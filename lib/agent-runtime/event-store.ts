import type { AgentRuntimeEventBase, EventListener, SequencedAgentEvent, Unsubscribe } from "./types";

const DEFAULT_MAX_EVENTS_PER_RUN = 1000;

interface RunEventBucket {
  events: SequencedAgentEvent[];
  nextSeq: number;
  listeners: Set<EventListener>;
}

export class EventStore {
  private readonly maxEventsPerRun: number;
  private readonly runs = new Map<string, RunEventBucket>();

  constructor(options: { maxEventsPerRun?: number } = {}) {
    const configuredMax = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;
    this.maxEventsPerRun = configuredMax > 0 ? configuredMax : DEFAULT_MAX_EVENTS_PER_RUN;
  }

  append(input: {
    sessionId: string;
    runId: string;
    turnId?: string;
    event: AgentRuntimeEventBase;
  }): SequencedAgentEvent {
    const bucket = this.getOrCreateBucket(input.runId);
    const next: SequencedAgentEvent = {
      seq: bucket.nextSeq,
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: Date.now(),
      event: input.event,
    };

    bucket.nextSeq += 1;
    bucket.events.push(next);
    if (bucket.events.length > this.maxEventsPerRun) {
      bucket.events.splice(0, bucket.events.length - this.maxEventsPerRun);
    }

    this.notify(bucket, next);
    return next;
  }

  getSince(runId: string, afterSeq?: number): SequencedAgentEvent[] {
    const bucket = this.runs.get(runId);
    if (!bucket) return [];
    if (afterSeq === undefined || afterSeq <= 0) return [...bucket.events];
    return bucket.events.filter((event) => event.seq > afterSeq);
  }

  getLastSeq(runId: string): number {
    const bucket = this.runs.get(runId);
    return bucket ? bucket.nextSeq - 1 : 0;
  }

  subscribe(runId: string, listener: EventListener): Unsubscribe {
    const bucket = this.getOrCreateBucket(runId);
    bucket.listeners.add(listener);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      bucket.listeners.delete(listener);
    };
  }

  clearRun(runId: string): void {
    this.runs.delete(runId);
  }

  clearAll(): void {
    this.runs.clear();
  }

  private getOrCreateBucket(runId: string): RunEventBucket {
    let bucket = this.runs.get(runId);
    if (!bucket) {
      bucket = { events: [], nextSeq: 1, listeners: new Set() };
      this.runs.set(runId, bucket);
    }
    return bucket;
  }

  private notify(bucket: RunEventBucket, event: SequencedAgentEvent): void {
    for (const listener of [...bucket.listeners]) {
      try {
        listener(event);
      } catch {
        // Keep event delivery best-effort: one broken listener must not break append or other subscribers.
      }
    }
  }
}

declare global {
  var __deerhuxAgentEventStore: EventStore | undefined;
}

export function getAgentEventStore(): EventStore {
  if (!globalThis.__deerhuxAgentEventStore) {
    globalThis.__deerhuxAgentEventStore = new EventStore();
  }
  return globalThis.__deerhuxAgentEventStore;
}

export type { AgentRuntimeEventBase, EventListener, SequencedAgentEvent, Unsubscribe };
