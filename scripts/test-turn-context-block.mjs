/**
 * DeerLoopEngine turn_context 块注入与恢复测试（M3 验收 #2）。
 *
 * 验证设计文档 §六.M3 验收标准 & §7.1 风险点「system prompt 泄漏」：
 *   wrapper 的 withTemporarySystemPrompt 调 setSystemPromptPersistent 注入
 *   <turn_context>...</turn_context> 块，turn 结束 .finally(applyRolePrompt) 恢复。
 *
 * ★ 责任分工（M3 关键认知）：
 *   - DeerLoopEngine 是「纯透传 + 持久」：set 什么，context 就用什么，且多轮持久。
 *     它【不】自动 strip turn_context（它不知道 turn_context 是什么）。
 *   - strip turn_context 是 wrapper 的职责（rpc-manager.ts 的 stripTurnContextBlock
 *     + applyRolePrompt + withTemporarySystemPrompt.finally）。DeerLoopEngine 只负责
 *     「值精确透传、不被外部重置」。
 *
 *   所以本测试验证的是 DeerLoopEngine 本身的行为契约：
 *     1. setSystemPromptPersistent(base + turn_context_block) → 本轮 LLM 看到完整内容
 *     2. setSystemPromptPersistent(base) → 下一轮不含 turn_context（精确透传）
 *     3. 连续两轮不同 turn_context 互不混合（无「第一轮冻结」泄漏）
 *     4. DeerLoopEngine 不自动 strip（set 什么得什么）
 *
 *   wrapper 侧的 strip 行为由 rpc-manager.ts 自身保证（applyRolePrompt 里
 *   baseSystemPrompt = stripModePrompt(stripTurnContextBlock(...))），不在本测试范围。
 *
 * 运行：node --experimental-strip-types scripts/test-turn-context-block.mjs
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
// mock helpers（自包含，与 test-system-prompt-persistence.mjs 同构）
// ---------------------------------------------------------------------------

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

/** 与 rpc-manager.ts 的 turn_context 块格式一致（references 段）。 */
const TURN_CONTEXT_BLOCK = `<turn_context>
references: src/foo.ts
references: src/bar.ts
</turn_context>`;

// ===========================================================================
// 用例 1：注入 turn_context 块 —— 本轮 LLM 看到完整内容（base + block）
// ===========================================================================

console.log("\n[用例 1] setSystemPromptPersistent(base + turn_context) → 本轮看到完整内容");
{
  let observed;
  const mockStreamFn = (_m, context) => {
    observed = context.systemPrompt;
    return doneStream();
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tc-1",
    streamFn: mockStreamFn,
  });

  const base = "You are a helpful assistant.";
  // 模拟 wrapper 的 withTemporarySystemPrompt：把 turn_context 块拼到 base 后面
  engine.setSystemPromptPersistent(`${base}\n\n${TURN_CONTEXT_BLOCK}`);
  await engine.prompt("edit foo.ts");

  assert(observed !== undefined, "streamFn 被调用，context.systemPrompt 已捕获", observed);
  assert(observed?.includes(base), "本轮 context 含 base prompt", observed);
  assert(observed?.includes("<turn_context>"), "本轮 context 含 <turn_context> 块", observed);
  assert(
    observed?.includes("references: src/foo.ts"),
    "turn_context 块内容完整透传",
    observed,
  );
  assert(
    observed === `${base}\n\n${TURN_CONTEXT_BLOCK}`,
    "精确透传：set 的字符串原样到达 LLM",
    observed,
  );
}

// ===========================================================================
// 用例 2：恢复后无残留 —— wrapper 调 setSystemPromptPersistent(base) 后下一轮不含 block
//         （证明 DeerLoopEngine 精确透传：set 什么得什么，不自动 strip 也不残留）
// ===========================================================================

console.log("\n[用例 2] wrapper 恢复后 setSystemPromptPersistent(base) → 下一轮不含 turn_context");
{
  const observed = [];
  const mockStreamFn = (_m, context) => {
    observed.push(context.systemPrompt);
    return doneStream();
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tc-2",
    streamFn: mockStreamFn,
  });

  const base = "You are a helpful assistant.";

  // 模拟 wrapper 的 withTemporarySystemPrompt：注入 block
  engine.setSystemPromptPersistent(`${base}\n\n${TURN_CONTEXT_BLOCK}`);
  await engine.prompt("turn with context");

  // 模拟 wrapper 的 .finally(applyRolePrompt)：
  //   applyRolePrompt 内部 baseSystemPrompt = stripTurnContextBlock(...)
  //   然后调 setSystemPromptPersistent(stripped)。
  //   stripTurnContextBlock 是 wrapper 的局部函数；DeerLoopEngine 不持有它。
  //   这里直接用 strip 后的 base，验证 DeerLoopEngine 精确透传。
  engine.setSystemPromptPersistent(base);
  await engine.prompt("next turn");

  assert(observed.length === 2, "2 轮 prompt", observed.length);
  assert(
    observed[0]?.includes("<turn_context>"),
    "第 1 轮含 turn_context（注入）",
    observed[0],
  );
  assert(
    !observed[1]?.includes("<turn_context>"),
    "第 2 轮不含 turn_context（恢复后精确透传）",
    observed[1],
  );
  assert(
    observed[1] === base,
    "第 2 轮 === 纯 base（无残留）",
    observed[1],
  );

  console.log("    ℹ️  turn-2 不含 block 是因为 wrapper 调了 setSystemPromptPersistent(base)，");
  console.log("       不是 DeerLoopEngine 自动 strip（见用例 4）。");
}

// ===========================================================================
// 用例 3：连续两轮 turn_context 不同 —— 第二轮的 block 不与第一轮混合
//         （设计文档 §7.1 风险点：第一轮 context 冻结到每轮）
// ===========================================================================

console.log("\n[用例 3] 连续两轮不同 turn_context，互不混合（无冻结）");
{
  const observed = [];
  const mockStreamFn = (_m, context) => {
    observed.push(context.systemPrompt);
    return doneStream();
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tc-3",
    streamFn: mockStreamFn,
  });

  const base = "BASE";
  const block1 = `<turn_context>\nreferences: a.ts\n</turn_context>`;
  const block2 = `<turn_context>\nreferences: b.ts\n</turn_context>`;

  // 第 1 轮：wrapper 注入 block1（基于 strip 后的 base）
  engine.setSystemPromptPersistent(`${base}\n\n${block1}`);
  await engine.prompt("edit a");
  // 第 2 轮：wrapper 恢复后注入 block2
  engine.setSystemPromptPersistent(`${base}\n\n${block2}`);
  await engine.prompt("edit b");

  assert(observed.length === 2, "2 轮", observed.length);
  assert(observed[0]?.includes("references: a.ts"), "第 1 轮含 a.ts", observed[0]);
  assert(
    !observed[0]?.includes("references: b.ts"),
    "第 1 轮不含 b.ts（无冻结）",
    observed[0],
  );
  assert(observed[1]?.includes("references: b.ts"), "第 2 轮含 b.ts", observed[1]);
  assert(
    !observed[1]?.includes("references: a.ts"),
    "第 2 轮不含 a.ts（上一轮 block 不残留）",
    observed[1],
  );
}

// ===========================================================================
// 用例 4：DeerLoopEngine 不自动 strip —— setSystemPromptPersistent 是纯透传
//         （责任分工：strip 是 wrapper 职责，DeerLoopEngine set 什么得什么）
// ===========================================================================

console.log("\n[用例 4] DeerLoopEngine 不自动 strip turn_context（纯透传契约）");
{
  let observed;
  const mockStreamFn = (_m, context) => {
    observed = context.systemPrompt;
    return doneStream();
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tc-4",
    streamFn: mockStreamFn,
  });

  // 故意 set 一个带 block 的 prompt，不调 strip —— DeerLoopEngine 应原样透传
  const withBlock = `keep me\n\n${TURN_CONTEXT_BLOCK}`;
  engine.setSystemPromptPersistent(withBlock);
  await engine.prompt("turn");

  assert(
    observed === withBlock,
    "setSystemPromptPersistent 纯透传：set 什么，context 就用什么（不自动 strip）",
    { observed, withBlock },
  );
  assert(
    engine.agent.state.systemPrompt === withBlock,
    "agent.state.systemPrompt 也原样同步（不 strip）",
    engine.agent.state.systemPrompt,
  );

  console.log("    ℹ️  strip turn_context 是 wrapper 的职责（rpc-manager.ts 的");
  console.log("       stripTurnContextBlock + applyRolePrompt），DeerLoopEngine 不持有。");
  console.log("       若 loop 也 strip，会与 wrapper 重叠且改变 set 的语义，故刻意不加。");
}

// ===========================================================================
// 用例 5：多块 turn_context 也精确透传（不丢块）
// ===========================================================================

console.log("\n[用例 5] 多块 turn_context 精确透传（不丢块）");
{
  let observed;
  const mockStreamFn = (_m, context) => {
    observed = context.systemPrompt;
    return doneStream();
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tc-5",
    streamFn: mockStreamFn,
  });

  // 构造含两个 turn_context 块的极端输入（验证不丢块、不合并）
  const twoBlocks = `base\n\n<turn_context>\nreferences: a.ts\n</turn_context>\n\n<turn_context>\nskill: foo\n</turn_context>`;
  engine.setSystemPromptPersistent(twoBlocks);
  await engine.prompt("turn");

  assert(
    observed === twoBlocks,
    "两块 turn_context 原样透传（不丢块、不合并）",
    observed,
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ turn_context 块测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ turn_context 注入与恢复：全部断言通过（M3 验收 #2）");
