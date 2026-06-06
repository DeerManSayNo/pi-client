/**
 * Simple typed event emitter for agent events.
 * Used to decouple the SSE event source from the log panel.
 */

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: AgentEvent) => void;

class AgentEventBus {
  private listeners: Set<Listener> = new Set();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }
}

const globalForBus = globalThis as unknown as { __piAgentEventBus?: AgentEventBus };
if (!globalForBus.__piAgentEventBus) {
  globalForBus.__piAgentEventBus = new AgentEventBus();
}

export const agentEventBus = globalForBus.__piAgentEventBus;
