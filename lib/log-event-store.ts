/**
 * Global log event store for the Log Panel.
 * ChatWindow pushes agent events here; LogPanel subscribes.
 */

export type LogEntryType = "thinking" | "tool_start" | "tool_end" | "text" | "error" | "info" | "system";

export interface LogEntry {
  id: string;
  timestamp: number;
  type: LogEntryType;
  /** The text content */
  content: string;
  /** Optional tool name for tool_start/tool_end */
  toolName?: string;
  /** Optional tool call id */
  toolCallId?: string;
  /** Group key — entries with the same groupKey form a visual block */
  groupKey?: string;
}

export interface ThinkingBlock {
  groupKey: string;
  startedAt: number;
  /** Accumulated thinking text */
  thinking: string;
  /** Tool operations within this block */
  tools: Array<{
    id: string;
    name: string;
    startedAt: number;
    endedAt?: number;
    result?: string;
  }>;
  /** Final assistant text output */
  output?: string;
}

type Listener = (entry: LogEntry) => void;
type BlockListener = (block: ThinkingBlock) => void;
type ClearListener = () => void;

let _idCounter = 0;
function nextId(): string {
  return `log-${++_idCounter}-${Date.now().toString(36)}`;
}

class LogEventStore {
  private entries: LogEntry[] = [];
  private listeners: Set<Listener> = new Set();
  private blockListeners: Set<BlockListener> = new Set();
  private clearListeners: Set<ClearListener> = new Set();

  // Current thinking block being assembled
  private currentBlock: ThinkingBlock | null = null;
  private currentBlockKey: string = "";

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeBlock(listener: BlockListener): () => void {
    this.blockListeners.add(listener);
    return () => { this.blockListeners.delete(listener); };
  }

  subscribeClear(listener: ClearListener): () => void {
    this.clearListeners.add(listener);
    return () => { this.clearListeners.delete(listener); };
  }

  getEntries(): LogEntry[] {
    return this.entries;
  }

  getCurrentBlock(): ThinkingBlock | null {
    return this.currentBlock;
  }

  getCompletedBlocks(): ThinkingBlock[] {
    // Build blocks from entries — each "system" entry (agent_start) starts a new block
    const blocks: ThinkingBlock[] = [];
    let current: ThinkingBlock | null = null;

    for (const entry of this.entries) {
      // agent_start marks a new block boundary
      if (entry.type === "system") {
        if (current) blocks.push(current);
        current = {
          groupKey: entry.groupKey ?? `block-${blocks.length}`,
          startedAt: entry.timestamp,
          thinking: "",
          tools: [],
        };
        continue;
      }

      if (!current) {
        // First entry without a system marker — create a block
        current = {
          groupKey: entry.groupKey ?? `block-${blocks.length}`,
          startedAt: entry.timestamp,
          thinking: "",
          tools: [],
        };
      }

      if (entry.type === "thinking") {
        current.thinking += entry.content;
      } else if (entry.type === "text") {
        current.output = (current.output ?? "") + entry.content;
      } else if (entry.type === "tool_start") {
        if (!current.tools.find((t) => t.id === entry.toolCallId)) {
          current.tools.push({
            id: entry.toolCallId ?? "",
            name: entry.toolName ?? "unknown",
            startedAt: entry.timestamp,
          });
        }
      } else if (entry.type === "tool_end") {
        const tool = current.tools.find((t) => t.id === entry.toolCallId);
        if (tool) {
          tool.endedAt = entry.timestamp;
          tool.result = entry.content;
        }
      }
    }

    if (current) blocks.push(current);
    return blocks;
  }

  push(entry: Omit<LogEntry, "id" | "timestamp">): void {
    const full: LogEntry = {
      ...entry,
      id: nextId(),
      timestamp: Date.now(),
    };
    this.entries.push(full);

    // Update current block
    const groupKey = entry.groupKey ?? this.currentBlockKey;
    if (groupKey) {
      if (!this.currentBlock || this.currentBlock.groupKey !== groupKey) {
        // Finalize previous block if any
        if (this.currentBlock) {
          for (const listener of this.blockListeners) {
            listener(this.currentBlock);
          }
        }
        this.currentBlock = {
          groupKey,
          startedAt: full.timestamp,
          thinking: "",
          tools: [],
        };
        this.currentBlockKey = groupKey;
      }

      if (entry.type === "thinking") {
        this.currentBlock.thinking += entry.content;
      } else if (entry.type === "text") {
        this.currentBlock.output = (this.currentBlock.output ?? "") + entry.content;
      } else if (entry.type === "tool_start") {
        if (!this.currentBlock.tools.find((t) => t.id === entry.toolCallId)) {
          this.currentBlock.tools.push({
            id: entry.toolCallId ?? "",
            name: entry.toolName ?? "unknown",
            startedAt: full.timestamp,
          });
        }
      } else if (entry.type === "tool_end") {
        const tool = this.currentBlock.tools.find((t) => t.id === entry.toolCallId);
        if (tool) {
          tool.endedAt = full.timestamp;
          tool.result = entry.content;
        }
      }
    }

    for (const listener of this.listeners) {
      listener(full);
    }
  }

  /** Called when agent ends — finalize the current block */
  finalizeBlock(): void {
    if (this.currentBlock) {
      for (const listener of this.blockListeners) {
        listener(this.currentBlock);
      }
      this.currentBlock = null;
      this.currentBlockKey = "";
    }
  }

  clear(): void {
    this.entries = [];
    this.currentBlock = null;
    this.currentBlockKey = "";
    for (const listener of this.clearListeners) {
      listener();
    }
  }
}

// Singleton
const globalForLog = globalThis as unknown as { __deerhuxLogStore?: LogEventStore };
if (!globalForLog.__deerhuxLogStore) {
  globalForLog.__deerhuxLogStore = new LogEventStore();
}

export const logEventStore = globalForLog.__deerhuxLogStore;
