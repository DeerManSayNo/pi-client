/**
 * DeerLoopEngine 手动测试（M1 验收 #5）。
 *
 * 不接真实 LLM：注入一个 mock streamFn，返回固定的 AssistantMessageEvent 序列，
 * 收集 DeerLoopEngine emit 的 LoopEvent，断言序列与契约一致。
 *
 * 覆盖：
 *   1. 正常流式：agent_start → message_start → message_update*N → message_end → agent_end
 *   2. abort：中途 abort，message_end.stopReason === "aborted"，资源释放
 *   3. 错误：streamFn 抛错，agent_end.error 携带消息
 *
 * 运行：node --experimental-strip-types scripts/test-deer-loop.mjs
 */
import {
  DeerLoopEngine,
} from "../lib/engine/deer-loop.ts";

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
// mock 工具：构造 AssistantMessage partial / AssistantMessageEvent 序列
// ---------------------------------------------------------------------------

/** 构造一个最小的 AssistantMessage partial（满足 pi-ai 类型形状）。 */
function makePartial({ text = "", thinking = "" } = {}) {
  const content = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text });
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: text.length + thinking.length,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: text.length + thinking.length,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** 构造一个最终 AssistantMessage（done 事件用）。 */
function makeFinalMessage({ text = "Hello", stopReason = "stop", errorMessage } = {}) {
  const msg = makePartial({ text });
  msg.stopReason = stopReason;
  if (errorMessage !== undefined) msg.errorMessage = errorMessage;
  return msg;
}

/** 把一组原始事件构造成 fake streamFn 返回的 AsyncIterable。 */
function makeStream(events, options = {}) {
  const { throwErrorAt, abortable = false } = options;
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events.length; i++) {
        if (throwErrorAt === i) {
          throw new Error("mock stream exploded");
        }
        // 让 abort 有机会在事件之间生效。
        if (abortable) {
          await Promise.resolve();
        }
        yield events[i];
      }
    },
  };
}

/** 收集 DeerLoopEngine emit 的全部 LoopEvent。 */
function collectEvents(engine) {
  const events = [];
  engine.subscribe((ev) => {
    events.push(ev);
  });
  return events;
}

/** 构造一个 fake model（满足 pi-ai Model<any> 的形状）。 */
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

/** 构造正常流的 AssistantMessageEvent 序列：start + 3 个 text_delta + done。 */
function normalFlowEvents() {
  return [
    { type: "start", partial: makePartial({ text: "" }) },
    { type: "text_start", contentIndex: 0, partial: makePartial({ text: "" }) },
    { type: "text_delta", contentIndex: 0, delta: "Hello", partial: makePartial({ text: "Hello" }) },
    { type: "text_delta", contentIndex: 0, delta: " world", partial: makePartial({ text: "Hello world" }) },
    { type: "text_end", contentIndex: 0, content: "Hello world", partial: makePartial({ text: "Hello world" }) },
    { type: "done", reason: "stop", message: makeFinalMessage({ text: "Hello world", stopReason: "stop" }) },
  ];
}

// ---------------------------------------------------------------------------
// 用例 1：正常流式 —— 事件序列正确
// ---------------------------------------------------------------------------

console.log("\n[用例 1] 正常流式：事件序列正确");
{
  const events = normalFlowEvents();
  let streamCalls = 0;
  const mockStreamFn = (_model, _context, _options) => {
    streamCalls++;
    return makeStream(events);
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "test-1",
    systemPrompt: "you are helpful",
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.prompt("hi");

  const types = collected.map((e) => e.type);
  assert(streamCalls === 1, "streamFn 被调用恰好一次", { streamCalls });
  assert(types[0] === "agent_start", "第一个事件是 agent_start", types);
  assert(types[types.length - 1] === "agent_end", "最后一个事件是 agent_end", types);
  const startIdx = types.indexOf("message_start");
  const endIdx = types.indexOf("message_end");
  assert(startIdx > 0, "message_start 在 agent_start 之后", { types, startIdx });
  assert(endIdx > startIdx, "message_end 在 message_start 之后", { types, startIdx, endIdx });
  assert(endIdx < types.length - 1, "message_end 在 agent_end 之前", { types, endIdx });

  // 中间的 message_update 数量 = 至少 2（text_start + 2 text_delta + text_end = 5 个 partial 事件）
  const updateCount = types.filter((t) => t === "message_update").length;
  assert(updateCount >= 2, `message_update 至少 2 次（实际 ${updateCount}）`, { updateCount });

  // message_end.message.stopReason === "stop"
  const endEvent = collected.find((e) => e.type === "message_end");
  assert(endEvent?.message?.stopReason === "stop", "message_end.stopReason === stop", endEvent?.message?.stopReason);
  assert(endEvent?.message?.role === "assistant", "message_end.message.role === assistant", endEvent?.message?.role);

  // agent_end.messages 包含 user + assistant
  const agentEnd = collected.find((e) => e.type === "agent_end");
  assert(agentEnd?.messages?.length === 2, "agent_end.messages 包含 user + assistant（2 条）", agentEnd?.messages?.length);
  assert(agentEnd?.willRetry === false, "agent_end.willRetry === false", agentEnd?.willRetry);
  assert(agentEnd?.error === undefined, "agent_end 无 error（正常流）", agentEnd?.error);

  // transcript 里能查到 user 消息内容
  assert(agentEnd.messages[0].content === "hi", "transcript 第一条是 user 输入", agentEnd.messages[0]);

  // isRunning / isStreaming 已归零
  assert(engine.isStreaming === false, "prompt 完成后 isStreaming=false", engine.isStreaming);

  console.log("    事件序列:", types.join(" → "));
}

// ---------------------------------------------------------------------------
// 用例 2：abort —— 中途 abort，stopReason === "aborted"
// ---------------------------------------------------------------------------

console.log("\n[用例 2] abort：中途 abort，stopReason === aborted");
{
  // 构造一个长流：先发 start + 1 个 delta，然后在第 3 个事件前 abort。
  // abortable: true 让 stream 在每次 yield 前 await 一个 microtask，给 abort 信号传播机会。
  const events = [
    { type: "start", partial: makePartial({ text: "" }) },
    { type: "text_delta", contentIndex: 0, delta: "H", partial: makePartial({ text: "H" }) },
    { type: "text_delta", contentIndex: 0, delta: "e", partial: makePartial({ text: "He" }) },
    { type: "text_delta", contentIndex: 0, delta: "llo", partial: makePartial({ text: "Hello" }) },
    { type: "done", reason: "stop", message: makeFinalMessage({ text: "Hello", stopReason: "stop" }) },
  ];

  const abortController = new AbortController();
  const mockStreamFn = (_model, _context, options) => {
    abortController.signal = options?.signal;
    return makeStream(events, { abortable: true });
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "test-abort",
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  // 并发：prompt 跑起来后立刻 abort。
  const promptPromise = engine.prompt("hi");
  // 等 start + 第一个 delta 进入。
  await Promise.resolve();
  await Promise.resolve();
  await engine.abort();
  await promptPromise;

  const types = collected.map((e) => e.type);
  assert(types[0] === "agent_start", "abort 用例：第一个事件是 agent_start", types);
  assert(types[types.length - 1] === "agent_end", "abort 用例：最后一个是 agent_end", types);

  const endEvent = collected.find((e) => e.type === "message_end");
  assert(endEvent != null, "abort 用例：有 message_end 事件", !!endEvent);
  assert(
    endEvent?.message?.stopReason === "aborted",
    "abort 用例：message_end.stopReason === aborted",
    endEvent?.message?.stopReason,
  );

  const agentEnd = collected.find((e) => e.type === "agent_end");
  assert(agentEnd?.willRetry === false, "abort 用例：agent_end.willRetry === false", agentEnd?.willRetry);

  // 资源释放：isRunning / isStreaming 归零，abortController 清空。
  assert(engine.isStreaming === false, "abort 后 isStreaming=false", engine.isStreaming);

  console.log("    事件序列:", types.join(" → "));
}

// ---------------------------------------------------------------------------
// 用例 3：错误 —— stream 抛错，agent_end 带 error
// ---------------------------------------------------------------------------

console.log("\n[用例 3] 错误：streamFn 抛错，agent_end.error 携带消息");
{
  const events = normalFlowEvents();
  const mockStreamFn = (_model, _context, _options) => {
    // 在第 2 个事件（index=2，即第一个 text_delta 之后）抛错。
    return makeStream(events, { throwErrorAt: 2 });
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "test-err",
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.prompt("hi");

  const types = collected.map((e) => e.type);
  assert(types[0] === "agent_start", "错误用例：第一个事件是 agent_start", types);
  assert(types[types.length - 1] === "agent_end", "错误用例：最后一个是 agent_end", types);

  const agentEnd = collected.find((e) => e.type === "agent_end");
  assert(agentEnd?.error !== undefined, "错误用例：agent_end.error 非空", agentEnd?.error);
  assert(
    typeof agentEnd?.error === "string" && agentEnd.error.includes("mock stream exploded"),
    "错误用例：agent_end.error 包含原始错误消息",
    agentEnd?.error,
  );
  assert(
    agentEnd?.willRetry === false,
    "错误用例：agent_end.willRetry === false（M1 不重试）",
    agentEnd?.willRetry,
  );

  // 错误也保证 message_start / message_end 成对（用 lastPartial 合成）。
  const startCount = types.filter((t) => t === "message_start").length;
  const endCount = types.filter((t) => t === "message_end").length;
  assert(startCount === 1, "错误用例：恰好一次 message_start", startCount);
  assert(endCount === 1, "错误用例：恰好一次 message_end", endCount);

  // 资源释放。
  assert(engine.isStreaming === false, "错误后 isStreaming=false", engine.isStreaming);

  console.log("    事件序列:", types.join(" → "));
}

// ---------------------------------------------------------------------------
// 用例 4：stream emit error 事件（reason: error）—— 走 error 分支
// ---------------------------------------------------------------------------

console.log("\n[用例 4] stream emit error 事件：agent_end 带 error");
{
  const events = [
    { type: "start", partial: makePartial({ text: "" }) },
    { type: "text_delta", contentIndex: 0, delta: "Hi", partial: makePartial({ text: "Hi" }) },
    {
      type: "error",
      reason: "error",
      error: makeFinalMessage({ text: "Hi", stopReason: "error", errorMessage: "provider 500" }),
    },
  ];
  const mockStreamFn = () => makeStream(events);
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "test-stream-err",
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.prompt("hi");

  const endEvent = collected.find((e) => e.type === "message_end");
  assert(endEvent?.message?.stopReason === "error", "stream error：stopReason === error", endEvent?.message?.stopReason);

  const agentEnd = collected.find((e) => e.type === "agent_end");
  assert(agentEnd?.error !== undefined, "stream error：agent_end.error 非空", agentEnd?.error);

  console.log("    事件序列:", collected.map((e) => e.type).join(" → "));
}

// ---------------------------------------------------------------------------
// 用例 5：subscribe 返回取消订阅函数；dispose 清空监听
// ---------------------------------------------------------------------------

console.log("\n[用例 5] subscribe 取消订阅 / dispose 清空");
{
  const mockStreamFn = () => makeStream(normalFlowEvents());
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "test-sub",
    streamFn: mockStreamFn,
  });

  let countA = 0;
  let countB = 0;
  const unsubA = engine.subscribe(() => countA++);
  engine.subscribe(() => countB++);

  await engine.prompt("hi");
  assert(countA > 0 && countB > 0, "两个订阅都收到事件", { countA, countB });
  assert(countA === countB, "两个订阅收到相同数量事件", { countA, countB });

  unsubA();
  const countAAfterFirst = countA;
  await engine.prompt("hi again");
  assert(countA === countAAfterFirst, "取消后 A 不再增长（等于首轮事件数）", { countA, countAAfterFirst });
  assert(countB > countAAfterFirst, "B 继续增长（第二轮）", { countB, countAAfterFirst });

  engine.dispose();
  // dispose 后再 prompt 不应抛，且订阅者收不到。
  let countB2 = countB;
  await engine.prompt("after dispose");
  assert(countB === countB2, "dispose 后订阅者不再收到事件", { countB, countB2 });
}

// ---------------------------------------------------------------------------
// 用例 6：Port 只读属性 & M2-M6 方法 throw
// ---------------------------------------------------------------------------

console.log("\n[用例 6] 只读属性 / M2 工具能力 / M3-M6 方法 throw");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp/work",
    sessionId: "test-props",
    systemPrompt: "sys",
    thinkingLevel: "medium",
    streamFn: () => makeStream(normalFlowEvents()),
  });

  assert(engine.sessionId === "test-props", "sessionId 正确", engine.sessionId);
  assert(engine.sessionFile === undefined, "sessionFile 为 undefined（M1 不持久化）", engine.sessionFile);
  assert(engine.isStreaming === false, "初始 isStreaming=false", engine.isStreaming);
  assert(engine.isCompacting === false, "isCompacting=false", engine.isCompacting);
  assert(engine.autoCompactionEnabled === false, "autoCompactionEnabled=false", engine.autoCompactionEnabled);
  assert(engine.autoRetryEnabled === false, "autoRetryEnabled=false", engine.autoRetryEnabled);
  assert(engine.model?.id === "test-model", "model.id 正确", engine.model?.id);
  assert(engine.thinkingLevel === "medium", "thinkingLevel 正确", engine.thinkingLevel);
  assert(engine.agent.state.systemPrompt === "sys", "agent.state.systemPrompt 正确", engine.agent.state.systemPrompt);
  assert(engine.agent.state.thinkingLevel === "medium", "agent.state.thinkingLevel 正确", engine.agent.state.thinkingLevel);
  assert(engine.sessionManager.getCwd() === "/tmp/work", "sessionManager.getCwd() 正确", engine.sessionManager.getCwd());
  assert(engine.sessionManager.isPersisted() === false, "sessionManager.isPersisted()=false", engine.sessionManager.isPersisted());
  assert(Array.isArray(engine.getAllTools()) && engine.getAllTools().length === 0, "getAllTools() 返回空数组", engine.getAllTools());
  assert(Array.isArray(engine.getActiveToolNames()) && engine.getActiveToolNames().length === 0, "getActiveToolNames() 返回空数组", engine.getActiveToolNames());

  // ★ M2 工具能力：applyToolExecutionModes / replaceCustomTools 不再 throw，正常工作
  engine.applyToolExecutionModes();  // M2 实现（写 registry mode 表）
  engine.installRetryHardening();    // M4 仍空实现
  engine.setSystemPromptPersistent("new prompt");
  assert(engine.agent.state.systemPrompt === "new prompt", "setSystemPromptPersistent 写入生效", engine.agent.state.systemPrompt);

  // replaceCustomTools：M2 已实现（热替换不 throw）
  const mockTool = {
    name: "test_tool",
    label: "Test",
    description: "test",
    parameters: { type: "object" },
    execute: async () => ({ content: [], details: {} }),
  };
  engine.replaceCustomTools({
    removeNames: [],
    addTools: [mockTool],
    extraAllowedNames: [],
    activeToolNames: ["test_tool"],
  });
  assert(engine.getActiveToolNames().includes("test_tool"), "replaceCustomTools 注册并激活 test_tool", engine.getActiveToolNames());
  assert(engine.getAllTools().some((t) => t.name === "test_tool"), "getAllTools 包含 test_tool", engine.getAllTools());

  // M3-M6 未实现的方法 throw（正则匹配 "not implemented"，不再限定 M1）
  let threwCount = 0;
  const expectThrow = async (fn, name) => {
    try {
      await fn();
      console.error("  ❌ FAIL:", name, "未抛错");
      failures++;
    } catch (e) {
      assert(
        /not implemented/.test(e.message),
        `${name} 抛 "not implemented"`,
        e.message,
      );
      threwCount++;
    }
  };
  await expectThrow(() => engine.setModel(FAKE_MODEL), "setModel");
  await expectThrow(() => engine.navigateTree("x"), "navigateTree");
  await expectThrow(() => engine.setThinkingLevel("high"), "setThinkingLevel");
  await expectThrow(() => engine.compact(), "compact");
  // ★ M5 后 steer/followUp 不再 throw（已实现），验证它们入队 + 发 queue_update
  await engine.steer("steer-msg");
  await engine.followUp("followup-msg");
  assert(engine.steeringQueueLength === 1, "M5 steer 入 steeringQueue", engine.steeringQueueLength);
  assert(engine.followUpQueueLength === 1, "M5 followUp 入 followUpQueue", engine.followUpQueueLength);
  assert(engine.hasQueuedMessages() === true, "M5 hasQueuedMessages=true（两队列都有）");
  // 清空
  const cleared = engine.clearQueues();
  assert(cleared.steering.length === 1 && cleared.steering[0] === "steer-msg", "clearQueues 返回 steering 内容", cleared.steering);
  assert(cleared.followUp.length === 1 && cleared.followUp[0] === "followup-msg", "clearQueues 返回 followUp 内容", cleared.followUp);
  assert(engine.hasQueuedMessages() === false, "clearQueues 后 hasQueuedMessages=false");
  assert(threwCount === 4, "M3-M6 共 4 个方法 throw（steer/followUp 已在 M5 实现）", threwCount);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ DeerLoopEngine 测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ DeerLoopEngine：全部断言通过（M1 流式 / abort / error / subscribe / 属性）");
