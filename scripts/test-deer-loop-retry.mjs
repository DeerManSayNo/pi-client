/**
 * DeerLoopEngine 重试循环测试（M4 验收 #4）。
 *
 * 覆盖：
 *   1. 前 N-1 次失败、第 N 次成功 → auto_retry 事件正确
 *   2. 全部失败 → 达到 maxAttempts 后 agent_end{error}
 *   3. H3：premature-stream + contentLength >= 20 → 不重试
 *   4. abort during retry sleep → 立即停止
 *   5. autoRetryEnabled=false → 不重试
 *   6. agent_end{willRetry:true} 在重试时发射
 *
 * ★ 测试加速：注入自定义 RetryPolicy（minDelayMs=10, settleMs=5），避免等 5 秒。
 *
 * 运行：node --experimental-strip-types scripts/test-deer-loop-retry.mjs
 */
import { DeerLoopEngine } from "../lib/engine/deer-loop.ts";
import { DefaultRetryPolicy } from "../lib/engine/retry-policy.ts";

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
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
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

function stopStream(text = "ok") {
  return [
    { type: "start", partial: textPartial("") },
    { type: "text_delta", contentIndex: 0, delta: text, partial: textPartial(text) },
    { type: "done", reason: "stop", message: textPartial(text) },
  ];
}

function errorStream(errMsg = "Internal Server Error", partial = null) {
  const events = [{ type: "start", partial: partial ?? textPartial("") }];
  if (partial) events.push({ type: "text_delta", contentIndex: 0, delta: partial.content?.[0]?.text ?? "", partial });
  events.push({ type: "error", reason: "error", error: { ...textPartial(""), stopReason: "error", errorMessage: errMsg } });
  return events;
}

function collectEvents(engine) {
  const events = [];
  engine.subscribe((ev) => events.push(ev));
  return events;
}

/** 极速 RetryPolicy（测试用，避免等 5 秒）。 */
function fastPolicy(maxAttempts = 3) {
  return new DefaultRetryPolicy({ maxAttempts, minDelayMs: 10, settleMs: 5 });
}

// ---------------------------------------------------------------------------
// 用例 1：前 2 次失败、第 3 次成功 → 重试成功
// ---------------------------------------------------------------------------
console.log("\n[用例 1] 前 2 次失败、第 3 次成功 → 重试成功");
{
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    if (streamCallCount <= 2) return makeStream(errorStream("500 error"));
    return makeStream(stopStream("finally works"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "retry-1",
    streamFn: mockStreamFn, retryPolicy: fastPolicy(3),
  });
  const collected = collectEvents(engine);

  const t0 = Date.now();
  await engine.prompt("hi");
  const elapsed = Date.now() - t0;

  assert(streamCallCount === 3, "streamFn 被调 3 次（2 失败 + 1 成功）", streamCallCount);

  const types = collected.map((e) => e.type);
  const retryStarts = collected.filter((e) => e.type === "auto_retry_start");
  const retryEnds = collected.filter((e) => e.type === "auto_retry_end");

  assert(retryStarts.length === 2, "2 次 auto_retry_start", retryStarts.length);
  assert(retryEnds.length === 1, "1 次 auto_retry_end（成功）", retryEnds.length);
  assert(retryEnds[0].success === true, "auto_retry_end.success=true");
  assert(retryEnds[0].attempt === 2, "auto_retry_end.attempt=2", retryEnds[0].attempt);

  // 2 次 willRetry:true 的 agent_end（每次失败重试前）
  const willRetryEnds = collected.filter((e) => e.type === "agent_end" && e.willRetry === true);
  assert(willRetryEnds.length === 2, "2 次 agent_end{willRetry:true}", willRetryEnds.length);

  // 最后的 agent_end{willRetry:false}
  const finalEnd = collected.filter((e) => e.type === "agent_end").pop();
  assert(finalEnd.willRetry === false, "最终 agent_end.willRetry=false");

  // auto_retry_start 事件字段
  assert(retryStarts[0].attempt === 1, "首次 retry attempt=1", retryStarts[0].attempt);
  assert(retryStarts[0].maxAttempts === 3, "maxAttempts=3", retryStarts[0].maxAttempts);
  assert(retryStarts[0].delayMs >= 10, "delayMs >= 10", retryStarts[0].delayMs);
  assert(retryStarts[0].errorMessage === "500 error", "errorMessage 透传");

  // 总耗时合理（2 次 retry，每次 settleMs(5) + delayMs(10,20) ≈ 15+25=40ms，加上容差）
  assert(elapsed < 500, `总耗时 < 500ms（实际 ${elapsed}ms）`, elapsed);

  console.log("    事件序列:", types.join(" → "));
}

// ---------------------------------------------------------------------------
// 用例 2：全部失败 → 达到 maxAttempts 后 agent_end{error}
// ---------------------------------------------------------------------------
console.log("\n[用例 2] 全部失败 → agent_end{error}");
{
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(errorStream("persistent failure"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "retry-2",
    streamFn: mockStreamFn, retryPolicy: fastPolicy(2),
  });
  const collected = collectEvents(engine);

  await engine.prompt("hi");

  // maxAttempts=2，所以总调用 = 1（初始）+ 2（重试）= 3
  assert(streamCallCount === 3, "streamFn 被调 3 次（初始 + 2 次重试）", streamCallCount);

  const finalEnd = collected.filter((e) => e.type === "agent_end").pop();
  assert(finalEnd.willRetry === false, "最终 agent_end.willRetry=false");
  assert(finalEnd.error !== undefined, "agent_end 带 error", finalEnd.error);
  assert(/persistent failure/.test(finalEnd.error), "error 含原始消息", finalEnd.error);
}

// ---------------------------------------------------------------------------
// 用例 3：H3 —— premature-stream + 长内容 → 不重试
// ---------------------------------------------------------------------------
console.log("\n[用例 3] H3：premature-stream + contentLength >= 20 → 不重试");
{
  let streamCallCount = 0;
  // 构造一个带 25 字内容的 partial，然后 connection lost
  const longPartial = textPartial("This is a complete answer for the user.");
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(errorStream("websocket closed", longPartial));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "retry-h3",
    streamFn: mockStreamFn, retryPolicy: fastPolicy(3),
  });
  const collected = collectEvents(engine);

  await engine.prompt("hi");

  // H3：不重试，只调 1 次
  assert(streamCallCount === 1, "streamFn 只调 1 次（H3 不重试）", streamCallCount);

  const retryStarts = collected.filter((e) => e.type === "auto_retry_start");
  assert(retryStarts.length === 0, "无 auto_retry_start（H3 拦截）", retryStarts.length);

  const finalEnd = collected.filter((e) => e.type === "agent_end").pop();
  assert(finalEnd.error !== undefined, "agent_end 带 error（不重试直接失败）");
}

// ---------------------------------------------------------------------------
// 用例 4：abort during retry sleep → 立即停止
// ---------------------------------------------------------------------------
console.log("\n[用例 4] abort during retry sleep");
{
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(errorStream("first attempt fails"));
  };

  // 用一个较大 delay 的 policy，确保 abort 能在 sleep 期间触发
  const policy = new DefaultRetryPolicy({ maxAttempts: 5, minDelayMs: 2000, settleMs: 100 });

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "retry-abort",
    streamFn: mockStreamFn, retryPolicy: policy,
  });
  const collected = collectEvents(engine);

  const t0 = Date.now();
  const promptPromise = engine.prompt("hi");
  // 等首次失败 + auto_retry_start，然后 abort
  await new Promise((r) => setTimeout(r, 150));
  await engine.abort();
  await promptPromise;
  const elapsed = Date.now() - t0;

  assert(streamCallCount === 1, "streamFn 只调 1 次（首次失败后 abort）", streamCallCount);

  const retryStarts = collected.filter((e) => e.type === "auto_retry_start");
  assert(retryStarts.length === 1, "有 1 次 auto_retry_start", retryStarts.length);

  const retryEnds = collected.filter((e) => e.type === "auto_retry_end");
  assert(retryEnds.length === 1, "有 1 次 auto_retry_end", retryEnds.length);
  assert(retryEnds[0].success === false, "auto_retry_end.success=false");
  assert(/aborted/.test(retryEnds[0].finalError), "finalError 含 aborted", retryEnds[0].finalError);

  // abort 打断 sleep：总耗时应远小于 delayMs(2000)
  assert(elapsed < 1000, `abort 打断 sleep，总耗时 < 1000ms（实际 ${elapsed}ms，delayMs=2000）`, elapsed);
}

// ---------------------------------------------------------------------------
// 用例 5：autoRetryEnabled=false → 不重试
// ---------------------------------------------------------------------------
console.log("\n[用例 5] autoRetryEnabled=false → 不重试");
{
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(errorStream("error"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "retry-disabled",
    streamFn: mockStreamFn, retryPolicy: fastPolicy(3),
  });
  // 运行时关闭重试
  engine.setAutoRetryEnabled(false);
  assert(engine.autoRetryEnabled === false, "autoRetryEnabled=false");

  const collected = collectEvents(engine);
  await engine.prompt("hi");

  assert(streamCallCount === 1, "streamFn 只调 1 次（重试已禁用）", streamCallCount);
  const retryStarts = collected.filter((e) => e.type === "auto_retry_start");
  assert(retryStarts.length === 0, "无 auto_retry_start", retryStarts.length);

  const finalEnd = collected.filter((e) => e.type === "agent_end").pop();
  assert(finalEnd.error !== undefined, "agent_end 带 error");
}

// ---------------------------------------------------------------------------
// 用例 6：installRetryHardening 安装默认 policy（无注入时）
// ---------------------------------------------------------------------------
console.log("\n[用例 6] installRetryHardening 安装默认 policy");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "retry-install",
    streamFn: () => makeStream(stopStream()),
  });
  assert(engine.autoRetryEnabled === false, "安装前 autoRetryEnabled=false");

  engine.installRetryHardening();
  assert(engine.autoRetryEnabled === true, "installRetryHardening 后 autoRetryEnabled=true");

  // 运行时关闭
  engine.setAutoRetryEnabled(false);
  assert(engine.autoRetryEnabled === false, "setAutoRetryEnabled(false) 生效");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ DeerLoopEngine 重试循环测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ DeerLoopEngine 重试循环：全部断言通过（重试成功/全部失败/H3/abort打断/禁用/install）");
