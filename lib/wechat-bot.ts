/**
 * 微信 iLink Bot 服务
 *
 * 零外部依赖，直接调用 iLink API (ilinkai.weixin.qq.com)。
 * 扫码登录 → 长轮询接收消息 → 路由到 AgentSession → 收集回复 → 发回微信。
 *
 * 协议参考: https://github.com/corespeed-io/wechatbot/blob/main/docs/protocol.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { getAgentDir, resolveSessionPath } from "./session-reader";
import { startRpcSession, getRpcSession, type AgentSessionWrapper } from "./rpc-manager";

// ============================================================================
// 配置
// ============================================================================

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3"; // AI bot 类型
const CHANNEL_VERSION = " ";

function getWechatDataDir(): string {
  const dir = join(getAgentDir(), "wechat");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getCredentialsPath(): string {
  return join(getWechatDataDir(), "credentials.json");
}

function getSyncBufPath(): string {
  return join(getWechatDataDir(), "sync-buf.txt");
}

function getUserSessionsPath(): string {
  return join(getWechatDataDir(), "user-sessions.json");
}

function getContextTokensPath(): string {
  return join(getWechatDataDir(), "context-tokens.json");
}

// ============================================================================
// 类型
// ============================================================================

export interface WeChatCredentials {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
}

export interface WeChatStatus {
  connected: boolean;
  polling: boolean;
  accountId?: string;
  qrcodeUrl?: string;
  loginStatus?: "wait" | "scaned" | "confirmed" | "expired" | "error";
  loginError?: string;
  activeUserCount?: number;
}

/** iLink 入站消息 */
interface WeixinMessage {
  from_user_id: string;
  to_user_id: string;
  msg_id: string;
  message_type: number;
  context_token: string;
  item_list: MessageItem[];
}

interface MessageItem {
  type: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: { text: string };
  image_item?: CDNMedia;
  voice_item?: CDNMedia & { recognize_text?: string };
  file_item?: CDNMedia & { file_name?: string };
  video_item?: CDNMedia;
}

interface CDNMedia {
  aes_key: string;
  cdn_media_buf: string;
  file_size?: number;
}

// ============================================================================
// 工具函数
// ============================================================================

function randomUint32(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString("base64");
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": base64Encode(String(randomUint32())),
  };
}

function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text;
    }
    // 语音消息：使用识别文本
    if (item.type === 3 && item.voice_item?.recognize_text) {
      return item.voice_item.recognize_text;
    }
  }
  return "";
}

function buildMessageDedupKey(msg: WeixinMessage, text: string): string | null {
  const msgId = typeof msg.msg_id === "string" ? msg.msg_id.trim() : "";
  const contextToken = typeof msg.context_token === "string" ? msg.context_token.trim() : "";

  // Some iLink responses do not provide a per-message-unique msg_id. Treat a
  // bare/missing msg_id as unsafe for de-duplication; the server cursor is the
  // primary guard against replay.
  if (!msgId) return null;

  return [
    msgId,
    msg.from_user_id,
    contextToken,
    text,
  ].join("\0");
}

function rememberSeenKey(seen: Map<string, number>, key: string, now = Date.now()): boolean {
  const lastSeenAt = seen.get(key);
  if (lastSeenAt && now - lastSeenAt < 60_000) return false;
  seen.set(key, now);
  return true;
}

// ============================================================================
// 凭证持久化
// ============================================================================

function loadCredentials(): WeChatCredentials | null {
  try {
    const raw = readFileSync(getCredentialsPath(), "utf-8");
    const data = JSON.parse(raw);
    if (data.botToken && data.accountId) return data;
  } catch {
    // 文件不存在或格式错误
  }
  return null;
}

function saveCredentials(creds: WeChatCredentials): void {
  writeFileSync(getCredentialsPath(), JSON.stringify(creds, null, 2), "utf-8");
}

function clearCredentials(): void {
  try { unlinkSync(getCredentialsPath()); } catch { /* ignore */ }
}

function loadSyncBuf(): string | undefined {
  try {
    return readFileSync(getSyncBufPath(), "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveSyncBuf(buf: string): void {
  writeFileSync(getSyncBufPath(), buf, "utf-8");
}

// ============================================================================
// 用户 → session 映射
// ============================================================================

function loadUserSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(getUserSessionsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveUserSessions(map: Record<string, string>): void {
  writeFileSync(getUserSessionsPath(), JSON.stringify(map, null, 2), "utf-8");
}

function loadContextTokens(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(getContextTokensPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveContextTokens(map: Record<string, string>): void {
  writeFileSync(getContextTokensPath(), JSON.stringify(map, null, 2), "utf-8");
}

function clearContextTokens(): void {
  try { unlinkSync(getContextTokensPath()); } catch { /* ignore */ }
}

// ============================================================================
// iLink API 客户端
// ============================================================================

class ILlinkApiClient {
  private token: string;
  private baseUrl: string;
  private botId: string;

  constructor(token: string, baseUrl: string, botId = "") {
    this.token = token;
    this.baseUrl = baseUrl || ILINK_BASE_URL;
    this.botId = botId;
  }

  setToken(token: string): void {
    this.token = token;
  }

  setBotId(botId: string): void {
    this.botId = botId;
  }

  /** 获取二维码 */
  async getQRCode(botType = BOT_TYPE): Promise<{ qrcode: string; qrcode_img_content: string }> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${botType}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`获取二维码失败: ${resp.status}`);
    return resp.json();
  }

  /** 轮询二维码状态 */
  async getQRCodeStatus(qrcode: string): Promise<{
    status: "wait" | "scaned" | "confirmed" | "expired";
    bot_token?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
    baseurl?: string;
  }> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const resp = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" } });
    if (!resp.ok) throw new Error(`查询二维码状态失败: ${resp.status}`);
    return resp.json();
  }

  /** 长轮询获取消息 */
  async getUpdates(syncBuf: string, timeoutMs = 35000): Promise<{
    ret: number;
    errcode?: number;
    msgs?: WeixinMessage[];
    get_updates_buf?: string;
  }> {
    const baseInfo = { channel_version: CHANNEL_VERSION };
    const body = JSON.stringify({ get_updates_buf: syncBuf, base_info: baseInfo });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 5000);

    try {
      const resp = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
        method: "POST",
        headers: buildHeaders(this.token),
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error(`getUpdates 失败: ${resp.status}`);
      return resp.json();
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ret: 0, get_updates_buf: syncBuf };
      }
      throw err;
    }
  }

  /** 发送文本消息 */
  async sendMessage(
    toUserId: string,
    text: string,
    contextToken: string,
  ): Promise<{ ret: number; errcode?: number; errmsg?: string }> {
    const clientId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const body = JSON.stringify({
      msg: {
        from_user_id: this.botId,
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });

    const resp = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: buildHeaders(this.token),
      body,
    });
    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "");
      throw new Error(`发送消息失败: ${resp.status}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`);
    }
    const result = await resp.json() as { ret: number; errcode?: number; errmsg?: string };
    if (result.ret !== 0 && result.ret !== undefined) {
      throw new Error(`发送消息失败: ret=${result.ret} errcode=${result.errcode} errmsg=${result.errmsg ?? ""}`);
    }
    return result;
  }
}

// ============================================================================
// Agent 会话管理
// ============================================================================

function collectAgentReply(
  session: AgentSessionWrapper,
  timeoutMs = 300_000,
): Promise<string> {
  return new Promise((resolve) => {
    let textBlocks: string[] = [];
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const updateAssistantSnapshot = (event: Record<string, unknown>) => {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;

      // DeerHux 的 message_update 通常携带 assistant 消息快照，而不是纯 delta。
      // 因此这里保留“最新快照”，不要每次 push 累加，否则手机端回复会和 session 落盘内容不同步。
      textBlocks = (msg.content as Array<Record<string, unknown>>)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string);
    };

    const finish = (text: string) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      unsub();
      resolve(text);
    };

    const unsub = session.onEvent((event) => {
      if (resolved) return;

      if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
        updateAssistantSnapshot(event as Record<string, unknown>);
      }

      // agent 回合结束：使用最后一次 assistant 快照，确保和 DeerHux session 中展示的最终文本一致。
      if (event.type === "agent_end") {
        const text = textBlocks.join("").trim();
        finish(text || "（未生成文本回复）");
      }

      // 自动重试结束但未成功
      if (event.type === "auto_retry_end" && !(event as { success?: boolean }).success) {
        finish("（Agent 自动重试失败）");
      }
    });

    timer = setTimeout(() => {
      const text = textBlocks.join("").trim();
      finish(text || "（Agent 回复超时）");
    }, timeoutMs);
  });
}

/** 获取或创建用户的 session */
async function getOrCreateUserSession(
  fromUserId: string,
  cwd: string,
): Promise<{ sessionId: string; isNew: boolean }> {
  const userSessions = loadUserSessions();
  const existingId = userSessions[fromUserId];

  if (existingId) {
    const existing = getRpcSession(existingId);
    if (existing?.isAlive()) {
      return { sessionId: existingId, isNew: false };
    }

    // 进程热重载/空闲超时后，wrapper 可能已销毁，但磁盘上的 session 仍然存在。
    // 不能直接新建 session，否则同一个微信用户第二次对话会丢上下文，且前端打开的旧会话无法实时同步。
    const existingPath = await resolveSessionPath(existingId);
    if (existingPath) {
      const { realSessionId } = await startRpcSession(existingId, existingPath, cwd);
      if (realSessionId !== existingId) {
        userSessions[fromUserId] = realSessionId;
        saveUserSessions(userSessions);
      }
      return { sessionId: realSessionId, isNew: false };
    }

    // 映射指向的 session 文件不存在/已删除，清掉脏映射后再新建。
    delete userSessions[fromUserId];
    saveUserSessions(userSessions);
  }

  // 创建新 session
  const tempKey = `__wechat_${fromUserId}_${Date.now()}`;
  const { realSessionId } = await startRpcSession(tempKey, "", cwd);

  userSessions[fromUserId] = realSessionId;
  saveUserSessions(userSessions);

  return { sessionId: realSessionId, isNew: true };
}

// ============================================================================
// WeChatBotService 单例
// ============================================================================

export class WeChatBotService {
  private api: ILlinkApiClient | null = null;
  private creds: WeChatCredentials | null = null;
  private polling = false;
  private abortController: AbortController | null = null;

  /** 当前正在处理的用户消息（防止同一 session 并发 prompt） */
  private processingUsers = new Set<string>();
  /** 用户消息队列 */
  private messageQueues = new Map<string, Array<{
    message: WeixinMessage;
    text: string;
  }>>();

  /** 登录流程中的二维码 URL */
  private currentQRCodeUrl: string | null = null;
  private loginAbortController: AbortController | null = null;

  private defaultCwd: string;

  constructor(defaultCwd?: string) {
    this.defaultCwd = defaultCwd ?? process.cwd();
    // 尝试恢复之前的凭证
    const saved = loadCredentials();
    if (saved) {
      this.creds = saved;
      this.api = new ILlinkApiClient(saved.botToken, saved.baseUrl, saved.accountId);
    }
  }

  /** 获取二维码 URL，开始扫码登录流程 */
  async getQRCode(): Promise<string> {
    // 先取消之前的登录流程
    this.loginAbortController?.abort();
    this.loginAbortController = new AbortController();

    const tempApi = new ILlinkApiClient("", ILINK_BASE_URL, "");
    const qrResp = await tempApi.getQRCode();
    this.currentQRCodeUrl = qrResp.qrcode_img_content;

    // 后台轮询扫码状态（不阻塞）
    this.pollQRCodeStatus(tempApi, qrResp.qrcode, this.loginAbortController.signal);

    return this.currentQRCodeUrl;
  }

  /** 后台轮询二维码状态，直到确认或过期 */
  private async pollQRCodeStatus(
    api: ILlinkApiClient,
    qrcode: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 480_000; // 8 分钟超时

    while (Date.now() < deadline) {
      if (signal.aborted) return;

      try {
        const status = await api.getQRCodeStatus(qrcode);

        switch (status.status) {
          case "confirmed":
            if (status.bot_token && status.ilink_bot_id) {
              this.creds = {
                botToken: status.bot_token,
                accountId: status.ilink_bot_id,
                baseUrl: status.baseurl ?? ILINK_BASE_URL,
                userId: status.ilink_user_id ?? "",
              };
              this.api = new ILlinkApiClient(status.bot_token, status.baseurl ?? ILINK_BASE_URL, status.ilink_bot_id ?? "");
              saveCredentials(this.creds);
              this.currentQRCodeUrl = null;
              // 自动开始轮询
              this.startPolling().catch((err) => {
                console.error("[WeChatBot] 自动启动轮询失败:", err);
              });
            }
            return;

          case "expired":
            this.currentQRCodeUrl = null;
            return;

          default:
            // "wait" 或 "scaned"，继续轮询
            break;
        }
      } catch (err) {
        console.error("[WeChatBot] 轮询二维码状态出错:", err);
      }

      await sleep(1000);
    }
  }

  /** 使用已有凭证直接登录（跳过扫码） */
  loginWithCredentials(creds: WeChatCredentials): void {
    this.creds = creds;
    this.api = new ILlinkApiClient(creds.botToken, creds.baseUrl, creds.accountId);
    saveCredentials(creds);
  }

  private getContextTokenKey(fromUserId: string): string {
    return `${this.creds?.accountId ?? "unknown"}:${fromUserId}`;
  }

  private rememberContextToken(fromUserId: string, contextToken: string | undefined): void {
    if (!contextToken?.trim()) return;
    const tokens = loadContextTokens();
    tokens[this.getContextTokenKey(fromUserId)] = contextToken;
    saveContextTokens(tokens);
  }

  private getCachedContextToken(fromUserId: string): string | undefined {
    const tokens = loadContextTokens();
    return tokens[this.getContextTokenKey(fromUserId)];
  }

  /** 开始消息轮询 */
  async startPolling(): Promise<void> {
    if (!this.api || !this.creds) {
      throw new Error("尚未登录，请先扫码");
    }

    if (this.polling) return;

    this.polling = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let syncBuf = loadSyncBuf() ?? "";
    const seenMessages = new Map<string, number>();

    console.log("[WeChatBot] 开始消息轮询...");

    while (this.polling && !signal.aborted) {
      try {
        const resp = await this.api.getUpdates(syncBuf, 35000);

        // Session 过期
        if (resp.errcode === -14) {
          console.log("[WeChatBot] Session 过期，需要重新登录");
          this.polling = false;
          clearCredentials();
          clearContextTokens();
          return;
        }

        // 更新游标
        if (resp.get_updates_buf) {
          syncBuf = resp.get_updates_buf;
          saveSyncBuf(syncBuf);
        }

        // 处理新消息
        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          // 只处理来自用户的消息（message_type === 1 表示用户消息）
          if (msg.message_type !== 1) continue;

          const text = extractText(msg);
          if (!text) continue;

          const dedupKey = buildMessageDedupKey(msg, text);
          if (dedupKey && !rememberSeenKey(seenMessages, dedupKey)) {
            console.log(`[WeChatBot] 跳过重复消息 msg_id=${msg.msg_id} from=${msg.from_user_id}`);
            continue;
          }

          const fromUserId = msg.from_user_id;
          this.rememberContextToken(fromUserId, msg.context_token);
          console.log(`[WeChatBot] 收到消息 from=${fromUserId}: ${text.slice(0, 50)}...`);

          // 加入队列处理
          this.enqueueMessage(fromUserId, msg, text);
        }

        // 清理旧去重记录。去重只作为短时间防重放保护，不能永久屏蔽同一用户后续消息。
        if (seenMessages.size > 2000) {
          const cutoff = Date.now() - 60_000;
          for (const [key, seenAt] of seenMessages) {
            if (seenAt < cutoff) seenMessages.delete(key);
          }
        }

        // 如果本轮没有收到任何新消息（长轮询正常超时返回），稍等片刻再继续，
        // 避免服务器瞬间响应时造成 busy-polling。
        if (msgs.length === 0) {
          await sleep(500);
        }
      } catch (err: unknown) {
        if (!this.polling || signal.aborted) break;

        const msg = err instanceof Error ? err.message : String(err);
        console.error("[WeChatBot] 轮询出错:", msg);

        // 短暂等待后重试
        await sleep(5000);
      }
    }

    console.log("[WeChatBot] 消息轮询已停止");
  }

  /** 停止轮询 */
  stopPolling(): void {
    this.polling = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /** 将消息加入处理队列 */
  private enqueueMessage(
    fromUserId: string,
    msg: WeixinMessage,
    text: string,
  ): void {
    if (!this.messageQueues.has(fromUserId)) {
      this.messageQueues.set(fromUserId, []);
    }
    this.messageQueues.get(fromUserId)!.push({ message: msg, text });
    this.processNextMessage(fromUserId);
  }

  /** 处理队列中的下一条消息（保证同一 session 串行） */
  private async processNextMessage(fromUserId: string): Promise<void> {
    if (this.processingUsers.has(fromUserId)) return;

    const queue = this.messageQueues.get(fromUserId);
    if (!queue || queue.length === 0) return;

    this.processingUsers.add(fromUserId);

    let currentMsg: WeixinMessage | null = null;

    try {
      const { message: msg, text } = queue.shift()!;
      currentMsg = msg;

      // 获取或创建用户的 Agent session
      const { sessionId, isNew } = await getOrCreateUserSession(fromUserId, this.defaultCwd);
      const session = getRpcSession(sessionId);
      if (!session || !session.isAlive()) {
        console.error(`[WeChatBot] Session ${sessionId} 不可用`);
        await this.sendReply(msg, "（Agent 会话不可用，请稍后重试）");
        return;
      }

      if (isNew) {
        console.log(`[WeChatBot] 为新用户 ${fromUserId} 创建 session: ${sessionId}`);
      }

      console.log(`[WeChatBot] 发送到 Agent: "${text.slice(0, 50)}..."`);

      // 先订阅事件，再发送 prompt，避免 Agent 很快开始输出时漏掉开头事件。
      const replyPromise = collectAgentReply(session);
      await session.send({ type: "prompt", message: text });

      const reply = await replyPromise;
      console.log(`[WeChatBot] Agent 回复: "${reply.slice(0, 50)}..."`);

      // 发送回复到微信
      await this.sendReply(msg, reply);
    } catch (err) {
      console.error(`[WeChatBot] 处理消息失败:`, err);
      if (currentMsg) {
        try {
          await this.sendReply(currentMsg, "（处理消息时出错，请重试）");
        } catch { /* ignore */ }
      }
    } finally {
      this.processingUsers.delete(fromUserId);
      // 继续处理队列中的下一条
      setTimeout(() => this.processNextMessage(fromUserId), 500);
    }
  }

  /** 通过 iLink API 发送回复 */
  private async sendReply(msg: WeixinMessage, reply: string): Promise<void> {
    if (!this.api) return;

    const contextToken = msg.context_token || this.getCachedContextToken(msg.from_user_id);
    if (!contextToken) {
      throw new Error(`缺少 context_token，无法回复用户 ${msg.from_user_id}`);
    }

    // 消息太长时分段发送
    const maxLen = 2000;
    if (reply.length <= maxLen) {
      await this.api.sendMessage(msg.from_user_id, reply, contextToken);
      return;
    }

    // 分段发送
    const chunks = splitText(reply, maxLen);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
      await this.api.sendMessage(msg.from_user_id, prefix + chunks[i], contextToken);
      if (i < chunks.length - 1) await sleep(500);
    }
  }

  /** 获取当前状态 */
  getStatus(): WeChatStatus {
    const userSessions = loadUserSessions();
    return {
      connected: Boolean(this.creds),
      polling: this.polling,
      accountId: this.creds?.accountId,
      qrcodeUrl: this.currentQRCodeUrl ?? undefined,
      activeUserCount: Object.keys(userSessions).length,
    };
  }

  /** 退出登录 */
  logout(): void {
    this.stopPolling();
    this.loginAbortController?.abort();
    this.creds = null;
    this.api = null;
    this.currentQRCodeUrl = null;
    clearCredentials();
    // 清除游标
    try { unlinkSync(getSyncBufPath()); } catch { /* ignore */ }
    clearContextTokens();
  }

  /** 更新默认工作目录 */
  setCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按自然边界拆分文本 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // 尝试在换行处断开
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) {
      // 尝试在句号处断开
      splitAt = remaining.lastIndexOf("。", maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      // 尝试在空格处断开
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ============================================================================
// 单例
// ============================================================================

let instance: WeChatBotService | null = null;

export function getWeChatBotService(cwd?: string): WeChatBotService {
  if (!instance) {
    instance = new WeChatBotService(cwd);
  }
  return instance;
}

/** 仅用于测试：重置单例 */
export function resetWeChatBotService(): void {
  instance?.stopPolling();
  instance = null;
}
