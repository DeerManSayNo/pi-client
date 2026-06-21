// 验证 DeerLoopEngine 注入真实 pi SessionManager 后会把消息写入 jsonl。
// 这是默认切换到 DeerLoopEngine 后「流式输出完 → 聊天记录清零/session 消失」的根因回归测试。
//
// 复现路径：
//   - 之前 startDeerLoopSession 在创建 engine 之后才 new SessionManager，
//     且没有注入 engine。DeerLoopEngine 的 sessionManager getter 返回最小 no-op 代理
//     （isPersisted 恒 false / appendCustomEntry 返回占位 id），所以流式结束后
//     _messages 有内容、jsonl 文件不存在，前端一刷新就全空。
//   - 现在通过 DeerLoopOptions.sessionManager 注入真实 SessionManager，
//     engine 在 prompt 的关键 push 点调 persistMessage → manager.appendMessage。

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { DeerLoopEngine } = await import("../lib/engine/deer-loop.ts");

// 一个最简单的 fake streamFn：直接返回一条 done 事件，content 是纯文本。
function makeDoneStream(text) {
  return async function* () {
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    yield { type: "done", message, reason: "stop" };
  };
}

let pass = 0;
const tmp = mkdtempSync(join(tmpdir(), "deer-loop-persist-"));

try {
  // 用 SessionManager.create(cwd) 生成真实 jsonl 路径（persist=true）。
  const cwd = tmp;
  const sm = SessionManager.create(cwd, undefined);
  const sessionFile = sm.getSessionFile();

  const engine = new DeerLoopEngine({
    model: {
      id: "claude-test",
      name: "claude-test",
      api: "anthropic",
      provider: "anthropic",
      baseUrl: "https://example.invalid",
      input: ["text"],
      contextWindow: 100000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    cwd,
    sessionId: "test-persist",
    systemPrompt: "you are a test",
    streamFn: makeDoneStream("hello world"),
    sessionManager: sm,
    // 工具关闭，纯文本一轮
    tools: [],
    activeToolNames: [],
  });

  // 引擎的 sessionManager getter 现在应该返回真实 sm（isPersisted true）
  assert.equal(engine.sessionManager.isPersisted(), true, "engine.sessionManager 应是注入的真实 SessionManager");
  assert.equal(engine.sessionManager.getSessionFile(), sessionFile, "sessionFile 应与传入 sm 一致");

  await engine.prompt("hi");

  // 等一个微任务，确保 appendFileSync 落盘
  await new Promise((r) => setTimeout(r, 10));

  // 文件应存在，且包含 user + assistant 两条 message
  assert.ok(existsSync(sessionFile), `jsonl 应已落盘：${sessionFile}`);
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const parsed = lines.map((l) => JSON.parse(l));
  const types = parsed.map((e) => e.type);

  assert.ok(types.includes("session"), "jsonl 应含 session header");
  const messages = parsed.filter((e) => e.type === "message");
  assert.equal(messages.length, 2, `应有 2 条 message（user+assistant），实际 ${messages.length}`);
  const roles = messages.map((m) => m.message.role);
  assert.deepEqual(roles, ["user", "assistant"], `消息角色顺序应为 user→assistant，实际 ${JSON.stringify(roles)}`);

  pass++;

  // 用例 2：appendCustomEntry 也应透传到 jsonl（wrapper 用它写 turn_context / display_user_message）
  const sm2 = SessionManager.create(cwd, undefined);
  const file2 = sm2.getSessionFile();
  const engine2 = new DeerLoopEngine({
    model: { id: "m", name: "m", api: "anthropic", provider: "anthropic", baseUrl: "https://x", input: ["text"], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    cwd,
    systemPrompt: "",
    streamFn: makeDoneStream("ok"),
    sessionManager: sm2,
    tools: [],
    activeToolNames: [],
  });

  const customId = engine2.appendCustomEntry("turn_context", { mode: "agent" });
  assert.ok(!customId.startsWith("deer-loop-custom-"), `注入了 sm 后 appendCustomEntry 应返回真实 entry id，实际 ${customId}`);
  await engine2.prompt("again");
  await new Promise((r) => setTimeout(r, 10));

  const raw2 = readFileSync(file2, "utf8");
  const types2 = raw2.trim().split("\n").map((l) => JSON.parse(l).type);
  assert.ok(types2.includes("custom"), "jsonl 应含 custom entry（turn_context）");
  pass++;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`✅ DeerLoopEngine session 持久化：${pass} 个用例全过（注入 SessionManager → prompt 后 jsonl 含 user+assistant / appendCustomEntry 透传）`);
