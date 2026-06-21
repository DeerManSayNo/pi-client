import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../engine/loop-event.ts";
import type { SessionEntry, SessionStore } from "./store.ts";

type PiSessionEntryLike = {
  id: string;
  type: string;
  timestamp?: string | number;
  parentId?: string | null;
};

type PiSessionTreeNodeLike = {
  entry: PiSessionEntryLike;
  children?: PiSessionTreeNodeLike[];
};

/**
 * 包装 pi SessionManager，行为逐字不变，只是收敛到 SessionStore 接口。
 *
 * M6 的解耦铺路：DeerHux 业务代码未来面向 SessionStore 编程，可替换成自研实现。
 * 当前内部全委托 pi，保持 jsonl 行为不变。
 */
export class PiSessionStoreAdapter implements SessionStore {
  private readonly sm: SessionManager;

  constructor(sm: SessionManager) {
    this.sm = sm;
  }

  get filePath(): string | undefined {
    return this.sm.getSessionFile?.() ?? undefined;
  }

  getCwd(): string {
    return this.sm.getCwd();
  }

  isPersisted(): boolean {
    return this.sm.isPersisted();
  }

  appendMessage(message: AgentMessage): string {
    return this.sm.appendMessage(message);
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.sm.appendCustomEntry(customType, data);
  }

  getEntries(): SessionEntry[] {
    return this.sm.getEntries().map(toSessionEntry);
  }

  getBranch(leafId?: string): SessionEntry[] {
    return this.sm.getBranch(leafId).map(toSessionEntry);
  }

  createBranchedSession(
    parentLeafId: string,
    _options?: { position?: "before" | "at" },
  ): string | undefined {
    // pi@0.75.5 的真实签名只有 createBranchedSession(leafId)。
    // M6 先忽略 position，保持 pi 行为逐字不变；before/at 语义留给后续自研 SessionStore。
    return this.sm.createBranchedSession(parentLeafId);
  }

  getLeaves(): Array<{ id: string; parentId?: string }> {
    const smWithTree = this.sm as SessionManager & {
      getTree?: () => PiSessionTreeNodeLike[];
    };
    const roots = smWithTree.getTree?.() ?? [];
    const leaves: Array<{ id: string; parentId?: string }> = [];

    const visit = (node: PiSessionTreeNodeLike): void => {
      const children = node.children ?? [];
      if (children.length === 0) {
        leaves.push({
          id: node.entry.id,
          ...(node.entry.parentId ? { parentId: node.entry.parentId } : {}),
        });
        return;
      }
      for (const child of children) visit(child);
    };

    for (const root of roots) visit(root);
    return leaves;
  }
}

function toSessionEntry(entry: PiSessionEntryLike): SessionEntry {
  return {
    id: entry.id,
    type: entry.type,
    data: entry,
    timestamp: normalizeTimestamp(entry.timestamp),
    parentId: entry.parentId,
  };
}

function normalizeTimestamp(timestamp: string | number | undefined): number | undefined {
  if (typeof timestamp === "number") return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
