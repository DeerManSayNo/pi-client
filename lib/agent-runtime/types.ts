export interface AgentRuntimeEventBase {
  type: string;
  [key: string]: unknown;
}

export interface SequencedAgentEvent {
  seq: number;
  sessionId: string;
  runId: string;
  turnId?: string;
  createdAt: number;
  event: AgentRuntimeEventBase;
}

export type EventListener = (event: SequencedAgentEvent) => void;
export type Unsubscribe = () => void;
