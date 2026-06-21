/**
 * DeerLoopEngine system prompt 持久性测试（M3 验收 #1 / #3）。
 *
 * 验证设计文档 §六.M3 验收标准：
 *   setSystemPromptPersistent 后连发 3 个 prompt，每个 turn 构建的
 *   context.systemPrompt 都是设置的值（不被重置）；agent.state.systemPrompt 同步。
 *
 * ★ DeerLoopEngine 天然免疫 H1（pi 的 _baseSystemPrompt 私有字段重置 bug）：
 *   它自己拥有 _baseSystemPrompt，consumeStream 的 while 循环每轮顶部
 *   重新构造 context（systemPrompt: this._baseSystemPrompt），没有「外部
 *   pi 在 _rebuildSystemPrompt 里覆盖我」的问题。本测试即证明这一点。
 *
 * 运行：node --experimental-strip-types scripts/test-system-prompt-persistence.mjs
 */
import { DeerLoopEngine } from "../lib/engine/deer-loop.ts";

let failures = 0;
function assert(cond, msg, extra) {
  if (!cond) {
    console.error("  ❌ FAIL:", msg, extra === undefined ? "" : JSON.stringify(extra));
    failures++;
  } else {
    console.log("  ✅", msg);
  }
}

// ---------------------------------------------------------------------------
// mock helpers —— 自包含（与 test-deer-loop.mjs 同构的精简版）
// ---------------------------------------------------------------------------

/** 构造一个最小的 AssistantMessage partial（满足 pi-ai 类型形状）。 */
function makePartial({ text = "" } = {}) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: text.length,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: text.length,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * 最小结束流：start + done。
 * 每次调用返回一个新的独立 AsyncIterable（一个 prompt 消费一个）。
 */
function doneStream(text = "ok") {
  const events = [
    { type: "start", partial: makePartial({ text: "" }) },
    { type: "done", reason: "stop", message: makePartial({ text }) },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

/** 满足 pi-ai Model<any> 形状的 fake model。 */
const FAKE_MODEL = {
  id: "test-model",
  name: "Test Model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

// ===========================================================================
// 用例 1：持久性核心 —— setSystemPromptPersistent 后连发 3 prompt，值不变
// ===========================================================================

console.log("\n[用例 1] setSystemPromptPersistent 后连发 3 prompt，context.systemPrompt 恒等");
{
  const observed = [];
  const mockStreamFn = (_m, context) => {
    observed.push(context.systemPrompt);
    return doneStream();
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "persist-1",
    streamFn: mockStreamFn,
  });

  const TARGET = "You are a code reviewer. Be concise.";
  engine.setSystemPromptPersistent(TARGET);

  await engine.prompt("turn 1");
  await engine.prompt("turn 2");
  await engine.prompt("turn 3");

  assert(observed.length === 3, "streamFn 恰好被调用 3 次（3 轮 prompt）", { calls: observed.length });
  assert(
    observed.every((p) => p === TARGET),
    "3 轮 context.systemPrompt 全等于设置的值（不被重置——免疫 H1）",
    observed,
  );
  assert(
    engine.agent.state.systemPrompt === TARGET,
    "agent.state.systemPrompt 与设置值同步",
    engine.agent.state.systemPrompt,
  );

  console.log("    observed:", observed);
}

// ===========================================================================
// 用例 2：中途改持久值 —— 下一轮立即读到新值（证明 context 每轮读最新 _baseSystemPrompt，不缓存）
// ===========================================================================

console.log("\n[用例 2] 中途 setSystemPromptPersistent，下一轮 consumeStream 立即读到新值");
{
  const observed = [];
  const mockStreamFn = (_m, context) => {
    observed.push(context.systemPrompt);
    return doneStream();
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "persist-2",
    streamFn: mockStreamFn,
  });

  engine.setSystemPromptPersistent("prompt-A");
  await engine.prompt("turn 1"); // → prompt-A
  engine.setSystemPromptPersistent("prompt-B");
  await engine.prompt("turn 2"); // → prompt-B（立即生效，不缓存）
  await engine.prompt("turn 3"); // → prompt-B（持久）

  assert(observed.length === 3, "3 轮 streamFn 调用", observed.length);
  assert(observed[0] === "prompt-A", "第 1 轮读 prompt-A", observed[0]);
  assert(observed[1] === "prompt-B", "第 2 轮读 prompt-B（中途改后立即生效）", observed[1]);
  assert(observed[2] === "prompt-B", "第 3 轮仍读 prompt-B（持久）", observed[2]);
  assert(
    engine.agent.state.systemPrompt === "prompt-B",
    "agent.state 同步为 prompt-B",
    engine.agent.state.systemPrompt,
  );

  console.log("    observed:", observed);
}

// ===========================================================================
// 用例 3：构造期 systemPrompt → agent.state.systemPrompt 同步（含空串边界）
// ===========================================================================

console.log("\n[用例 3] 构造期 systemPrompt 与 setSystemPromptPersistent 一致性");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "persist-3",
    systemPrompt: "initial-from-ctor",
    streamFn: () => doneStream(),
  });

  assert(
    engine.agent.state.systemPrompt === "initial-from-ctor",
    "构造期 systemPrompt 写入 agent.state",
    engine.agent.state.systemPrompt,
  );

  engine.setSystemPromptPersistent("changed");
  assert(
    engine.agent.state.systemPrompt === "changed",
    "setSystemPromptPersistent 后 agent.state 同步",
    engine.agent.state.systemPrompt,
  );

  // setSystemPromptPersistent 写空串也应同步（边界）
  engine.setSystemPromptPersistent("");
  assert(
    engine.agent.state.systemPrompt === "",
    "setSystemPromptPersistent('') 同步空串",
    engine.agent.state.systemPrompt,
  );
}

// ===========================================================================
// 用例 4：空 _baseSystemPrompt 时 context.systemPrompt === undefined
//         （deer-loop.ts: `systemPrompt: this._baseSystemPrompt || undefined`）
// ===========================================================================

console.log("\n[用例 4] 空 _baseSystemPrompt 时 context.systemPrompt === undefined");
{
  let seen;
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "persist-4",
    streamFn: (_m, context) => {
      seen = context.systemPrompt;
      return doneStream();
    },
  });

  await engine.prompt("hi");

  assert(
    seen === undefined,
    "空 baseSystemPrompt 时 context.systemPrompt === undefined",
    seen,
  );
}

// ===========================================================================
// 用例 5：多轮 prompt 后 agent.state.systemPrompt === 最后一轮 context.systemPrompt
//         （双写同步的端到端证据：wrapper 读 agent.state 拿到的就是 LLM 看到的）
// ===========================================================================

console.log("\n[用例 5] 多轮 prompt 后 agent.state.systemPrompt === 最后一轮 context.systemPrompt");
{
  let lastObserved;
  const mockStreamFn = (_m, context) => {
    lastObserved = context.systemPrompt;
    return doneStream();
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "persist-5",
    systemPrompt: "base",
    streamFn: mockStreamFn,
  });

  engine.setSystemPromptPersistent("final-value");
  await engine.prompt("t1");
  await engine.prompt("t2");
  await engine.prompt("t3");

  assert(
    lastObserved === "final-value",
    "最后一轮 context.systemPrompt === final-value",
    lastObserved,
  );
  assert(
    engine.agent.state.systemPrompt === lastObserved,
    "agent.state.systemPrompt === 最后一轮 context.systemPrompt（双写同步）",
    { state: engine.agent.state.systemPrompt, context: lastObserved },
  );
}

// ===========================================================================
// 用例 6：transcript 累积但 systemPrompt 不漂移
//         （_messages 每轮增长，但 systemPrompt 恒等于 _baseSystemPrompt——
//          证明持久性独立于 transcript 演化）
// ===========================================================================

console.log("\n[用例 6] transcript 累积，systemPrompt 不随轮次漂移");
{
  const observed = [];
  const mockStreamFn = (_m, context) => {
    observed.push(context.systemPrompt);
    return doneStream();
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "persist-6",
    systemPrompt: "stable-prompt",
    streamFn: mockStreamFn,
  });

  for (let i = 0; i < 5; i++) {
    await engine.prompt(`msg ${i}`);
  }

  assert(observed.length === 5, "5 轮 prompt", observed.length);
  assert(
    observed.every((p) => p === "stable-prompt"),
    "5 轮 context.systemPrompt 全等于构造期值（无漂移）",
    observed,
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ system prompt 持久性测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ system prompt 持久性：全部断言通过（M3 验收 #1 / #3）");
