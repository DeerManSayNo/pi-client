import type { AgentMessage } from "../engine/loop-event.ts";

/**
 * DeerHux 会话条目抽象。
 *
 * M6 只定义 DeerHux 业务侧需要的最小公共形状；pi 的 SessionEntry 字段更多
 * （parentId、message、customType 等），通过 data 保留原始信息，后续自研实现可逐步收敛。
 */
export interface SessionEntry {
  id: string;
  /** "message" | "custom" | "custom:xxx" | pi 其它条目类型。 */
  type: string;
  /** 原始条目或业务数据；M6 adapter 保持 pi 返回对象逐字透传。 */
  data: unknown;
  timestamp?: number;
  parentId?: string | null;
}

/**
 * SessionStore —— DeerHux session 层 Port。
 *
 * 目标：把业务代码未来对 jsonl/pi SessionManager 的依赖收敛到这一接口。
 * M6 阶段只铺接口与 pi adapter，不做 rpc-manager/session-reader 全量迁移，避免高风险改动。
 */
export interface SessionStore {
  /** 会话文件路径（jsonl）。无持久化时 undefined。 */
  readonly filePath?: string;
  /** 工作目录。 */
  getCwd(): string;
  /** 是否持久化到磁盘。 */
  isPersisted(): boolean;
  /** 追加消息条目。返回 entry id。 */
  appendMessage(message: AgentMessage): string;
  /** 追加自定义条目（如 role_profile / agent_mode）。返回 entry id。 */
  appendCustomEntry(customType: string, data?: unknown): string;
  /** 获取全部条目（用于 buildSessionContext）。 */
  getEntries(): SessionEntry[];
  /** 获取消息分支（用于 fork/navigateTree）。 */
  getBranch(leafId?: string): SessionEntry[];
  /** 创建分支会话（fork）。返回新 sessionFile；内存会话可能返回 undefined。 */
  createBranchedSession(
    parentLeafId: string,
    options?: { position?: "before" | "at" },
  ): string | undefined;
  /** 列出当前会话树的全部叶子（用于 navigateTree UI）。 */
  getLeaves(): Array<{ id: string; parentId?: string }>;
}
