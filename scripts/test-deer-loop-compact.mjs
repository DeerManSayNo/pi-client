/**
 * DeerLoopEngine.compact 测试（M6 验收 #4）。
 *
 * 覆盖：
 *   1. 正常压缩 → transcript 替换成 summary + compaction 事件
 *   2. abortCompaction 打断 → transcript 不变 + aborted=true
 *   3. compact 时 prompt 正在跑 → throw
 *   4. getContextUsage 真实估算
 *   5. customInstructions 注入
 *   6. stream 抛错 → compaction_end 带 errorMessage + 向上抛
 *
 * 运行：node --experimental-strip-types scripts/test-deer-loop-compact.mjs
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

const FAKE_MODEL = {
  id: "test-model", name: "Test", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "http://localhost", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1024,
};

function textPartial(text) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages", provider: "anthropic", model: "test-model",
    usage: { input: 0, output: text.length, cacheRead: 0, cacheWrite: 0, totalTokens: text.length, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

function makeStream(events) {
  return { async *[Symbol.asyncIterator]() { for (const ev of events) yield ev; } };
}

function compactStream(summary) {
  return [
    { type: "start", partial: textPartial("") },
    { type: "text_delta", contentIndex: 0, delta: summary, partial: textPartial(summary) },
    { type: "done", reason: "stop", message: textPartial(summary) },
  ];
}

function collectEvents(engine) {
  const events = [];
  engine.subscribe((ev) => events.push(ev));
  return events;
}

// 构造一个有内容的 transcript（需要先 prompt 一次让消息入 transcript）
async function seedTranscript(engine, messages) {
  for (const msg of messages) {
    let calls = 0;
    const orig = engine._streamFn;
    engine._streamFn = () => { calls++; return makeStream([{ type: "done", reason: "stop", message: textPartial(msg) }]); };
    await engine.prompt(`user msg ${msg}`);
    engine._streamFn = orig;
  }
}

// ---------------------------------------------------------------------------
// 用例 1：正常压缩
// ---------------------------------------------------------------------------
console.log("\n[用例 1] 正常压缩 → transcript 替换");
{
  let compactCalls = 0;
  const mockStreamFn = () => {
    compactCalls++;
    return makeStream(compactStream("This is a summary of the conversation."));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "compact-1",
    systemPrompt: "you are helpful",
    streamFn: () => makeStream(compactStream("original response")),
  });
  // 先 seed 一些 transcript（用 prompt）
  engine._streamFn = () => makeStream([{ type: "done", reason: "stop", message: textPartial("Long conversation content here.") }]);
  await engine.prompt("first message");
  engine._streamFn = () => makeStream([{ type: "done", reason: "stop", message: textPartial("Second response.") }]);
  await engine.prompt("second message");

  const beforeLen = engine.getContextUsage().tokens;
  assert(beforeLen > 0, `压缩前 tokens > 0 (${beforeLen})`);

  // 换成 compact 的 streamFn
  engine._streamFn = mockStreamFn;
  const collected = collectEvents(engine);

  assert(engine.isCompacting === false, "compact 前 isCompacting=false");
  const result = await engine.compact("focus on file changes");
  assert(engine.isCompacting === false, "compact 后 isCompacting=false");

  assert(compactCalls === 1, "streamFn 调了 1 次");
  assert(typeof result.summary === "string", "result.summary 是 string");
  assert(result.summary.includes("summary"), "summary 内容正确", result.summary);
  assert(result.tokensBefore > result.tokensAfter, `tokens 减少 (${result.tokensBefore} → ${result.tokensAfter})`, { before: result.tokensBefore, after: result.tokensAfter });

  // transcript 被替换成 1 条
  const afterLen = engine.getContextUsage().tokens;
  assert(afterLen < beforeLen, `压缩后 tokens 减少 (${afterLen} < ${beforeLen})`);

  // compaction 事件
  const starts = collected.filter((e) => e.type === "compaction_start");
  const ends = collected.filter((e) => e.type === "compaction_end");
  assert(starts.length === 1, "1 次 compaction_start");
  assert(ends.length === 1, "1 次 compaction_end");
  assert(starts[0].reason === "manual", "compaction_start.reason=manual");
  assert(ends[0].aborted === false, "compaction_end.aborted=false");
  assert(ends[0].result !== undefined, "compaction_end.result 非空");
  assert(ends[0].willRetry === false, "compaction_end.willRetry=false");
}

// ---------------------------------------------------------------------------
// 用例 2：abortCompaction 打断
// ---------------------------------------------------------------------------
console.log("\n[用例 2] abortCompaction 打断");
{
  // ★ 用慢 stream：yield 后 await 200ms，让 abort 有机会介入
  const slowStreamFn = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: textPartial("") };
      await new Promise((r) => setTimeout(r, 200));
      yield { type: "text_delta", contentIndex: 0, delta: "S", partial: textPartial("S") };
      await new Promise((r) => setTimeout(r, 200));
      yield { type: "done", reason: "stop", message: textPartial("should not reach") };
    },
  });

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "compact-abort",
    streamFn: () => makeStream([{ type: "done", reason: "stop", message: textPartial("seed content") }]),
  });
  // seed transcript
  await engine.prompt("seed");

  engine._streamFn = slowStreamFn;
  const collected = collectEvents(engine);
  const beforeLen = engine.getContextUsage().tokens;

  const compactPromise = engine.compact();
  // 等 compaction_start + 进入 stream 迭代
  await new Promise((r) => setTimeout(r, 50));
  assert(engine.isCompacting === true, "compact 进行中 isCompacting=true");

  engine.abortCompaction();
  await compactPromise;

  assert(engine.isCompacting === false, "abort 后 isCompacting=false");

  const ends = collected.filter((e) => e.type === "compaction_end");
  assert(ends.length === 1, "有 compaction_end");
  assert(ends[0].aborted === true, "compaction_end.aborted=true");

  // transcript 不变（abort 不替换）
  const afterLen = engine.getContextUsage().tokens;
  assert(afterLen === beforeLen, "abort 后 transcript 不变", { beforeLen, afterLen });
}

// ---------------------------------------------------------------------------
// 用例 3：prompt 正在跑时 compact → throw
// ---------------------------------------------------------------------------
console.log("\n[用例 3] prompt 运行时 compact → throw");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "compact-running",
    streamFn: () => makeStream([{ type: "done", reason: "stop", message: textPartial("x") }]),
  });

  const p = engine.prompt("hi");
  // prompt 还没跑完（同步进入 _isRunning）——实际上这个 mock stream 会立即完成
  // 所以我们用一个更慢的 mock
  let threw = false;
  try {
    // prompt 已经返回了（mock stream 同步完成），所以这里测的是「真正并发」场景
    // 改用直接设 _isRunning 的方式不太干净，跳过这个精确断言
  } catch (e) { threw = true; }
  await p;

  // 单独测：手动模拟 running 状态（通过构造一个慢 prompt）
  const slowEngine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "compact-slow",
    streamFn: () => {
      const events = [{ type: "start", partial: textPartial("") }];
      return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; await new Promise((r) => setTimeout(r, 200)); } };
    },
  });
  const slowP = slowEngine.prompt("hi");
  await new Promise((r) => setTimeout(r, 20));
  let threw2 = false;
  try {
    await slowEngine.compact();
  } catch (e) {
    threw2 = true;
    assert(/无法压缩|正在运行/.test(e.message), "错误消息含'正在运行'", e.message);
  }
  assert(threw2, "prompt 运行时 compact 抛错");
  slowEngine.abort();
  await slowP;
}

// ---------------------------------------------------------------------------
// 用例 4：getContextUsage 真实估算
// ---------------------------------------------------------------------------
console.log("\n[用例 4] getContextUsage 真实估算");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "usage",
    systemPrompt: "short prompt",
    streamFn: () => makeStream([{ type: "done", reason: "stop", message: textPartial("ok") }]),
  });

  const usage0 = engine.getContextUsage();
  assert(usage0 !== undefined, "getContextUsage 非 undefined");
  assert(usage0.contextWindow === 1000, "contextWindow=1000", usage0.contextWindow);
  assert(usage0.tokens > 0, "初始 tokens > 0（systemPrompt）", usage0.tokens);
  assert(usage0.percent > 0 && usage0.percent < 1, "初始 percent 在 0-1", usage0.percent);

  await engine.prompt("a longer user message to increase token count");
  const usage1 = engine.getContextUsage();
  assert(usage1.tokens > usage0.tokens, `prompt 后 tokens 增加 (${usage1.tokens} > ${usage0.tokens})`);
}

// ---------------------------------------------------------------------------
// 用例 5：customInstructions 注入 systemPrompt
// ---------------------------------------------------------------------------
console.log("\n[用例 5] customInstructions 注入");
{
  let capturedContext;
  const mockStreamFn = (_m, ctx) => {
    capturedContext = ctx;
    return makeStream(compactStream("summary"));
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "compact-instr",
    streamFn: () => makeStream([{ type: "done", reason: "stop", message: textPartial("seed") }]),
  });
  await engine.prompt("seed");

  engine._streamFn = mockStreamFn;
  await engine.compact("FOCUS ON TESTING");

  assert(capturedContext !== undefined, "streamFn 被调用");
  assert(capturedContext.systemPrompt.includes("FOCUS ON TESTING"), "customInstructions 出现在 systemPrompt", capturedContext.systemPrompt);
  assert(capturedContext.systemPrompt.includes("summarizer") || capturedContext.systemPrompt.includes("Summarize"), "systemPrompt 含总结指令");
}

// ---------------------------------------------------------------------------
// 用例 6：stream 抛错 → compaction_end 带 errorMessage + 向上抛
// ---------------------------------------------------------------------------
console.log("\n[用例 6] stream 抛错");
{
  const mockStreamFn = () => {
    return { async *[Symbol.asyncIterator]() { throw new Error("LLM exploded"); } };
  };
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "compact-err",
    streamFn: () => makeStream([{ type: "done", reason: "stop", message: textPartial("seed") }]),
  });
  await engine.prompt("seed");
  engine._streamFn = mockStreamFn;
  const collected = collectEvents(engine);

  let threw = false;
  try {
    await engine.compact();
  } catch (e) {
    threw = true;
    assert(/exploded/.test(e.message), "向上抛的错含原始消息", e.message);
  }
  assert(threw, "compact 向上抛错");

  const ends = collected.filter((e) => e.type === "compaction_end");
  assert(ends.length === 1, "有 compaction_end");
  assert(ends[0].errorMessage !== undefined, "compaction_end 带 errorMessage", ends[0].errorMessage);
  assert(engine.isCompacting === false, "出错后 isCompacting=false");
}

// ---------------------------------------------------------------------------
// 用例 7：空 transcript compact
// ---------------------------------------------------------------------------
console.log("\n[用例 7] 空 transcript compact");
{
  const mockStreamFn = () => makeStream(compactStream("empty summary"));
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "compact-empty",
    streamFn: mockStreamFn,
  });

  const result = await engine.compact();
  assert(typeof result.summary === "string", "空 transcript 也能 compact");
  assert(result.tokensBefore >= 0, "tokensBefore >= 0");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ DeerLoopEngine compact 测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ DeerLoopEngine compact：全部断言通过（正常压缩/abort打断/运行时抛错/用量估算/指令注入/错误处理/空transcript）");
