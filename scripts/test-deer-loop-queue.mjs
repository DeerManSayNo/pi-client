/**
 * DeerLoopEngine steering / followUp 队列测试（M5 验收 #3 #4 #5）。
 *
 * 覆盖：
 *   1. steer 入 steeringQueue → emit queue_update{steering}
 *   2. followUp 入 followUpQueue → emit queue_update{followUp}
 *   3. steering drain（"all" 模式）：turn 进行中 steer，下一轮 LLM 看见（transcript 多 user 消息）
 *   4. steering drain（"one-at-a-time"）：只注入最老一条，其余留队列
 *   5. followUp drain（"all" 模式）：turn 结束后触发新 turn（多一轮 stream 调用）
 *   6. followUp drain（"one-at-a-time"）：只触发一轮新 turn，剩余留队列
 *   7. followUp 重置 toolRounds（新 turn 独立 maxToolRounds 预算）
 *   8. maxFollowUps 防死循环（达上限后正常结束）
 *   9. abort 不清空队列（保留到下次交互）
 *   10. clearQueues / clearSteeringQueue / clearFollowUpQueue + queue_update 事件
 *   11. queue_update 事件形状（steering/followUp 只暴露 text，不含 images）
 *   12. hasQueuedMessages 状态（buildExtensionContext 用）
 *
 * 运行：node --experimental-strip-types scripts/test-deer-loop-queue.mjs
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

function textPartial(text) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: text.length, cacheRead: 0, cacheWrite: 0, totalTokens: text.length, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolCallPartial(toolCalls) {
  return {
    role: "assistant",
    content: [...toolCalls],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolCall(id, name, args = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

function makeStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

function stopRoundStream(text = "done") {
  return [
    { type: "start", partial: textPartial("") },
    { type: "text_delta", contentIndex: 0, delta: text, partial: textPartial(text) },
    { type: "done", reason: "stop", message: textPartial(text) },
  ];
}

function toolRoundStream(call) {
  return [
    { type: "start", partial: toolCallPartial([call]) },
    { type: "toolcall_start", contentIndex: 0, partial: toolCallPartial([call]) },
    { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: toolCallPartial([call]) },
    { type: "done", reason: "toolUse", message: toolCallPartial([call]) },
  ];
}

function collectEvents(engine) {
  const events = [];
  engine.subscribe((ev) => events.push(ev));
  return events;
}

function makeMockTool(name) {
  const calls = [];
  return {
    tool: {
      name,
      label: name,
      description: `mock ${name}`,
      parameters: { type: "object", properties: {} },
      executionMode: "parallel",
      execute: async (toolCallId, params) => {
        calls.push({ toolCallId, params, time: Date.now() });
        return {
          content: [{ type: "text", text: `${name} ok` }],
          details: { name, params },
        };
      },
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// 用例 1：steer 入队 → emit queue_update{steering}
// ---------------------------------------------------------------------------
console.log("\n[用例 1] steer 入队 + queue_update 事件");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q1",
    streamFn: () => makeStream(stopRoundStream()),
  });
  const collected = collectEvents(engine);

  // 初始：队列空，hasQueuedMessages=false
  assert(engine.steeringQueueLength === 0, "初始 steeringQueueLength=0");
  assert(engine.hasQueuedMessages() === false, "初始 hasQueuedMessages=false");

  await engine.steer("补充说明 A");
  await engine.steer("补充说明 B");

  assert(engine.steeringQueueLength === 2, "两次 steer 后 steeringQueueLength=2", engine.steeringQueueLength);

  const queueUpdates = collected.filter((e) => e.type === "queue_update");
  assert(queueUpdates.length === 2, "2 次 queue_update 事件", queueUpdates.length);
  assert(
    Array.isArray(queueUpdates[1].steering) &&
      queueUpdates[1].steering.length === 2 &&
      queueUpdates[1].steering[0] === "补充说明 A" &&
      queueUpdates[1].steering[1] === "补充说明 B",
    "queue_update.steering 只暴露 text 列表",
    queueUpdates[1].steering,
  );
  assert(
    Array.isArray(queueUpdates[1].followUp) && queueUpdates[1].followUp.length === 0,
    "queue_update.followUp 为空数组",
    queueUpdates[1].followUp,
  );
}

// ---------------------------------------------------------------------------
// 用例 2：followUp 入队 → emit queue_update{followUp}
// ---------------------------------------------------------------------------
console.log("\n[用例 2] followUp 入队 + queue_update 事件");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q2",
    streamFn: () => makeStream(stopRoundStream()),
  });
  const collected = collectEvents(engine);

  await engine.followUp("继续追问 1");

  assert(engine.followUpQueueLength === 1, "followUpQueueLength=1", engine.followUpQueueLength);
  assert(engine.hasQueuedMessages() === true, "hasQueuedMessages=true");

  const queueUpdates = collected.filter((e) => e.type === "queue_update");
  assert(queueUpdates.length === 1, "1 次 queue_update");
  assert(
    queueUpdates[0].followUp.length === 1 && queueUpdates[0].followUp[0] === "继续追问 1",
    "queue_update.followUp 含文本",
    queueUpdates[0].followUp,
  );
}

// ---------------------------------------------------------------------------
// 用例 3：steering drain（"all" 模式）—— turn 进行中 steer，下一轮 LLM 看见
// ---------------------------------------------------------------------------
console.log("\n[用例 3] steering drain（all 模式）：插嘴消息注入到 transcript");
{
  const mockRead = makeMockTool("read");
  let streamCallCount = 0;
  const mockStreamFn = (_model, _context, _opts) => {
    streamCallCount++;
    if (streamCallCount === 1) {
      // 第一轮：LLM 要调 read（turn 进行中）
      return makeStream(toolRoundStream(toolCall("c1", "read", { path: "/foo" })));
    }
    // 第二轮：LLM 看到 read 结果，stop
    return makeStream(stopRoundStream("done after tool"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q3-steer-all",
    steeringMode: "all",
    tools: [mockRead.tool],
    activeToolNames: ["read"],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  // 在 prompt 进行中 steer（用 unblock trick：prompt 是 async，steer 在它启动后立即排队）
  const promptPromise = engine.prompt("read /foo");
  // 让 agent_start + 第一轮 consumeStream 启动（不 await 完成）
  await Promise.resolve();
  await Promise.resolve();
  // turn 进行中：插嘴两条
  await engine.steer("补充说明 X");
  await engine.steer("补充说明 Y");
  await promptPromise;

  // ★ drain 时机：在第二轮 consumeStream 之前注入（第一轮 consumeStream 后、工具执行后，
  //   下一轮循环顶部检查 steeringQueue，注入到 transcript，然后第二轮 LLM 看见）。
  const agentEnd = collected.find((e) => e.type === "agent_end");
  // transcript 应含：user(prompt) + assistant(toolUse) + toolResult + user(steer X) + user(steer Y) + assistant(stop) = 6
  assert(agentEnd.messages.length === 6, "transcript 含 6 条（含 2 条 steer user 消息）", agentEnd.messages.length);
  assert(agentEnd.messages[3].role === "user", "msg[3] 是 steer 注入的 user 消息", agentEnd.messages[3].role);
  assert(agentEnd.messages[3].content === "补充说明 X", "msg[3].content === steer X", agentEnd.messages[3].content);
  assert(agentEnd.messages[4].role === "user", "msg[4] 是 steer Y");
  assert(agentEnd.messages[4].content === "补充说明 Y", "msg[4].content === steer Y", agentEnd.messages[4].content);
  assert(agentEnd.messages[5].role === "assistant", "msg[5] 是最终 assistant(stop)");

  // 队列已清空（drain 后 splice）
  assert(engine.steeringQueueLength === 0, "drain 后 steeringQueueLength=0", engine.steeringQueueLength);

  // queue_update 在 drain 时发了一次（队列变空）
  const queueUpdates = collected.filter((e) => e.type === "queue_update");
  // 2 次 push（steer X / steer Y）+ 1 次 drain = 3
  assert(queueUpdates.length === 3, "3 次 queue_update（2 入队 + 1 drain）", queueUpdates.length);
  assert(
    queueUpdates[queueUpdates.length - 1].steering.length === 0,
    "最后一次 queue_update：steering 空（drain 后）",
    queueUpdates[queueUpdates.length - 1].steering,
  );
}

// ---------------------------------------------------------------------------
// 用例 4：steering drain（"one-at-a-time" 模式）—— 只注入最老一条
// ---------------------------------------------------------------------------
console.log("\n[用例 4] steering drain（one-at-a-time）：只注入最老一条");
{
  const mockRead = makeMockTool("read");
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    if (streamCallCount === 1) return makeStream(toolRoundStream(toolCall("c1", "read", { path: "/foo" })));
    if (streamCallCount === 2) return makeStream(toolRoundStream(toolCall("c2", "read", { path: "/bar" })));
    return makeStream(stopRoundStream("done"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q4-steer-one",
    steeringMode: "one-at-a-time",
    tools: [mockRead.tool],
    activeToolNames: ["read"],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  const promptPromise = engine.prompt("read /foo");
  await Promise.resolve();
  await Promise.resolve();
  await engine.steer("第一插嘴");
  await engine.steer("第二插嘴");
  await promptPromise;

  const agentEnd = collected.find((e) => e.type === "agent_end");
  // ★ one-at-a-time：3 轮循环，每轮只注入最老一条
  //   第一轮顶部 drain：空（steer 还没 push）
  //   第二轮顶部 drain：注入「第一插嘴」（队列剩「第二插嘴」）
  //   第三轮顶部 drain：注入「第二插嘴」（队列空）
  // transcript: user(prompt) + asst + toolResult + user(第一) + asst + toolResult + user(第二) + asst(stop) = 8
  assert(agentEnd.messages.length === 8, "transcript 含 8 条（2 条 steer 分两轮注入）", agentEnd.messages.length);
  assert(agentEnd.messages[3].content === "第一插嘴", "msg[3]=第一插嘴", agentEnd.messages[3].content);
  assert(agentEnd.messages[6].content === "第二插嘴", "msg[6]=第二插嘴", agentEnd.messages[6].content);

  assert(engine.steeringQueueLength === 0, "drain 后 steeringQueueLength=0");
}

// ---------------------------------------------------------------------------
// 用例 5：followUp drain（"all" 模式）—— turn 结束后触发新 turn
// ---------------------------------------------------------------------------
console.log("\n[用例 5] followUp drain（all 模式）：turn 结束触发新 turn");
{
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(stopRoundStream(`round ${streamCallCount}`));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q5-follow-all",
    followUpMode: "all",
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  // prompt 启动前先入队 followUp（模拟 turn 还没开始用户就追问）
  await engine.followUp("继续 1");
  await engine.followUp("继续 2");

  await engine.prompt("原始问题");

  // ★ 第一轮 LLM stop 后，drain followUp（all 模式），全部注入，触发新 turn
  //   新 turn 又 stop，followUp 已空，正常结束。
  assert(streamCallCount === 2, "streamFn 被调 2 次（原始 turn + followUp 新 turn）", streamCallCount);

  const agentEnd = collected.find((e) => e.type === "agent_end");
  // transcript: user(原始) + asst(round1) + user(继续1) + user(继续2) + asst(round2) = 5
  assert(agentEnd.messages.length === 5, "transcript 含 5 条（含 2 条 followUp user）", agentEnd.messages.length);
  assert(agentEnd.messages[0].content === "原始问题", "msg[0]=原始问题");
  assert(agentEnd.messages[2].content === "继续 1", "msg[2]=followUp 1", agentEnd.messages[2].content);
  assert(agentEnd.messages[3].content === "继续 2", "msg[3]=followUp 2", agentEnd.messages[3].content);

  assert(engine.followUpQueueLength === 0, "drain 后 followUpQueueLength=0");

  // 只有一次 agent_end（最后），中间不发 agent_end
  const agentEnds = collected.filter((e) => e.type === "agent_end");
  assert(agentEnds.length === 1, "只有 1 次 agent_end（followUp 新 turn 不发）", agentEnds.length);

  // 有 2 次 message_start / message_end（两轮 LLM）
  const starts = collected.filter((e) => e.type === "message_start").length;
  const ends = collected.filter((e) => e.type === "message_end").length;
  assert(starts === 2, "2 次 message_start（2 轮 LLM）", starts);
  assert(ends === 2, "2 次 message_end", ends);
}

// ---------------------------------------------------------------------------
// 用例 6：followUp drain（"one-at-a-time" 模式）—— 只触发一轮新 turn
// ---------------------------------------------------------------------------
console.log("\n[用例 6] followUp drain（one-at-a-time）：只触发一轮新 turn");
{
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(stopRoundStream(`r${streamCallCount}`));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q6-follow-one",
    followUpMode: "one-at-a-time",
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.followUp("追问 A");
  await engine.followUp("追问 B");
  await engine.followUp("追问 C");

  await engine.prompt("主问题");

  // ★ one-at-a-time followUp：每个 turn 结束只触发一条
  //   第 1 轮 stop → drain「追问 A」（队列剩 B/C）→ 新 turn
  //   第 2 轮 stop → drain「追问 B」（队列剩 C）→ 新 turn
  //   第 3 轮 stop → drain「追问 C」（队列空）→ 新 turn
  //   第 4 轮 stop → 队列空 → 正常结束
  assert(streamCallCount === 4, "streamFn 被调 4 次（1 主 + 3 followUp）", streamCallCount);

  const agentEnd = collected.find((e) => e.type === "agent_end");
  // transcript: user(主) + asst + user(A) + asst + user(B) + asst + user(C) + asst = 8
  assert(agentEnd.messages.length === 8, "transcript 含 8 条", agentEnd.messages.length);
  assert(agentEnd.messages[2].content === "追问 A", "msg[2]=追问 A", agentEnd.messages[2].content);
  assert(agentEnd.messages[4].content === "追问 B", "msg[4]=追问 B");
  assert(agentEnd.messages[6].content === "追问 C", "msg[6]=追问 C");
  assert(engine.followUpQueueLength === 0, "drain 后 followUpQueueLength=0");
}

// ---------------------------------------------------------------------------
// 用例 7：followUp 触发的新 turn 重置 toolRounds（独立预算）
// ---------------------------------------------------------------------------
console.log("\n[用例 7] followUp 重置 toolRounds（新 turn 独立预算）");
{
  const mockRead = makeMockTool("read");
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    // 奇数号调用（1、3）：返回 toolCall；偶数号（2、4）：返回 stop
    if (streamCallCount % 2 === 1) {
      const callId = `c${streamCallCount}`;
      const path = streamCallCount === 1 ? "/a" : "/b";
      return makeStream(toolRoundStream(toolCall(callId, "read", { path })));
    }
    return makeStream(stopRoundStream("done"));
  };

  // maxToolRounds=1：主 turn 调一轮工具就到上限。
  // followUp 触发的新 turn 重置 toolRounds，又能调一轮工具。
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q7-reset",
    maxToolRounds: 1,
    tools: [mockRead.tool],
    activeToolNames: ["read"],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.followUp("继续");
  await engine.prompt("主问题");

  // 主 turn：2 轮（1 toolCall + 1 stop）；followUp 新 turn：2 轮（1 toolCall + 1 stop） = 4
  assert(streamCallCount === 4, "streamFn 被调 4 次（主 turn 2 轮 + followUp turn 2 轮）", streamCallCount);
  assert(mockRead.calls.length === 2, "read 执行 2 次（每个 turn 一次）", mockRead.calls.length);

  const agentEnd = collected.filter((e) => e.type === "agent_end").pop();
  assert(agentEnd.error === undefined, "无 error（未超 maxToolRounds，followUp 重置了预算）", agentEnd.error);
}

// ---------------------------------------------------------------------------
// 用例 8：maxFollowUps 防死循环（one-at-a-time 模式）
// ---------------------------------------------------------------------------
console.log("\n[用例 8] maxFollowUps 上限防死循环（one-at-a-time）");
{
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(stopRoundStream(`r${streamCallCount}`));
  };

  // ★ one-at-a-time 模式：每个 turn 结束只 drain 一条 followUp。
  //   maxFollowUps=2 + 队列 5 条 → 最多触发 2 次新 turn，剩下 3 条保留在队列。
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q8-max",
    maxFollowUps: 2,
    followUpMode: "one-at-a-time",
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  for (let i = 0; i < 5; i++) await engine.followUp(`f${i}`);
  await engine.prompt("主问题");

  // 1 主 turn + 2 followUp turn（达上限后停） = 3
  assert(streamCallCount === 3, "streamFn 被调 3 次（1 主 + 2 followUp，达上限）", streamCallCount);

  // 队列还剩 3 条（5 - 2 = 3）
  assert(engine.followUpQueueLength === 3, "达上限后队列剩 3 条", engine.followUpQueueLength);
}

// ---------------------------------------------------------------------------
// 用例 9：abort 不清空队列（保留到下次交互）
// ---------------------------------------------------------------------------
console.log("\n[用例 9] abort 不清空队列");
{
  const mockSlow = makeMockTool("slow");
  const slowTool = {
    name: "slow",
    label: "slow",
    description: "slow tool",
    parameters: { type: "object", properties: {} },
    executionMode: "parallel",
    execute: async (id, p) => {
      mockSlow.calls.push({ toolCallId: id, params: p, time: Date.now() });
      await new Promise((r) => setTimeout(r, 500));
      return { content: [{ type: "text", text: "slow ok" }], details: {} };
    },
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q9-abort",
    tools: [slowTool],
    activeToolNames: ["slow"],
    streamFn: () => makeStream(toolRoundStream(toolCall("c1", "slow", {}))),
  });

  // ★ 关键：steer/followUp 要在【第一轮 drain 之后】注入（否则第一轮顶部 drain 会清空）。
  //   工具执行期间（第一轮 consumeStream 已完成、第二轮 drain 未到）正好是窗口。
  const p = engine.prompt("hi");
  // 等待 agent_start + 第一轮 consumeStream + 进入工具执行（500ms delay）
  await new Promise((r) => setTimeout(r, 100));
  // 工具执行期间 steer + followUp（此时队列不会被 drain，因为还在工具执行中）
  await engine.steer("插嘴保留");
  await engine.followUp("追问保留");
  assert(engine.steeringQueueLength === 1, "工具执行期间 steer 入队后 steeringQueueLength=1");
  assert(engine.followUpQueueLength === 1, "followUp 入队后 followUpQueueLength=1");

  await engine.abort();
  await p;

  // ★ abort 后队列保留（abort 不调 clearQueues）
  assert(engine.steeringQueueLength === 1, "abort 后 steering 仍 1 条", engine.steeringQueueLength);
  assert(engine.followUpQueueLength === 1, "abort 后 followUp 仍 1 条", engine.followUpQueueLength);
  assert(engine.hasQueuedMessages() === true, "abort 后 hasQueuedMessages=true");
}

// ---------------------------------------------------------------------------
// 用例 10：clearQueues / clearSteeringQueue / clearFollowUpQueue
// ---------------------------------------------------------------------------
console.log("\n[用例 10] clearQueues / clearSteeringQueue / clearFollowUpQueue");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q10-clear",
    streamFn: () => makeStream(stopRoundStream()),
  });
  const collected = collectEvents(engine);

  await engine.steer("s1");
  await engine.steer("s2");
  await engine.followUp("f1");

  // clearSteeringQueue
  const removedS = engine.clearSteeringQueue();
  assert(removedS.length === 2 && removedS[0] === "s1", "clearSteeringQueue 返回 2 条", removedS);
  assert(engine.steeringQueueLength === 0, "steering 清空");
  assert(engine.followUpQueueLength === 1, "followUp 不受影响");

  // clearFollowUpQueue
  const removedF = engine.clearFollowUpQueue();
  assert(removedF.length === 1 && removedF[0] === "f1", "clearFollowUpQueue 返回 1 条", removedF);
  assert(engine.hasQueuedMessages() === false, "全清空后 hasQueuedMessages=false");

  // 重新入队，测 clearQueues（清两个）
  await engine.steer("s3");
  await engine.followUp("f2");
  const cleared = engine.clearQueues();
  assert(cleared.steering.length === 1 && cleared.followUp.length === 1, "clearQueues 清两个", cleared);
  assert(engine.hasQueuedMessages() === false, "clearQueues 后空");

  // queue_update 在每次入队 + 每次清空时都 emit
  const queueUpdates = collected.filter((e) => e.type === "queue_update");
  // 入队 3 次（s1, s2, f1）+ clearSteering(1) + clearFollowUp(1) + 入队 2 次（s3, f2）+ clearQueues(1) = 8
  assert(queueUpdates.length === 8, "8 次 queue_update 事件", queueUpdates.length);
}

// ---------------------------------------------------------------------------
// 用例 11：queue_update 事件形状（只暴露 text，不含 images）
// ---------------------------------------------------------------------------
console.log("\n[用例 11] queue_update 事件形状（text only）");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q11-shape",
    streamFn: () => makeStream(stopRoundStream()),
  });
  const collected = collectEvents(engine);

  const fakeImg = { type: "image", data: "base64data", mimeType: "image/png" };
  await engine.steer("带图的 steer", [fakeImg]);

  const qu = collected.filter((e) => e.type === "queue_update");
  assert(qu.length === 1, "1 次 queue_update");
  assert(qu[0].steering.length === 1, "steering 含 1 条");
  assert(qu[0].steering[0] === "带图的 steer", "steering[0] 是 text");
  // 形状验证：steering 是 string[]，不含 images 字段
  assert(typeof qu[0].steering[0] === "string", "steering 元素是 string（不是对象）");
  assert(Array.isArray(qu[0].followUp) && qu[0].followUp.length === 0, "followUp 是空 string[]");
}

// ---------------------------------------------------------------------------
// 用例 12：hasQueuedMessages + setSteeringMode/setFollowUpMode 运行时切换
// ---------------------------------------------------------------------------
console.log("\n[用例 12] setSteeringMode/setFollowUpMode 运行时切换");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q12-mode",
    streamFn: () => makeStream(stopRoundStream()),
  });

  assert(engine.steeringMode === "all", "默认 steeringMode=all");
  assert(engine.followUpMode === "all", "默认 followUpMode=all");

  engine.setSteeringMode("one-at-a-time");
  engine.setFollowUpMode("one-at-a-time");
  assert(engine.steeringMode === "one-at-a-time", "切换后 steeringMode=one-at-a-time");
  assert(engine.followUpMode === "one-at-a-time", "切换后 followUpMode=one-at-a-time");

  // 构造期注入也生效
  const engine2 = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q12-mode-ctor",
    steeringMode: "one-at-a-time",
    followUpMode: "all",
    streamFn: () => makeStream(stopRoundStream()),
  });
  assert(engine2.steeringMode === "one-at-a-time", "构造期注入 steeringMode");
  assert(engine2.followUpMode === "all", "构造期注入 followUpMode");
}

// ---------------------------------------------------------------------------
// 用例 13：dispose 清空队列（与 abort 不同）
// ---------------------------------------------------------------------------
console.log("\n[用例 13] dispose 清空队列");
{
  const engine = new DeerLoopEngine({
    model: FAKE_MODEL, cwd: "/tmp", sessionId: "q13-dispose",
    streamFn: () => makeStream(stopRoundStream()),
  });

  await engine.steer("s1");
  await engine.followUp("f1");
  assert(engine.hasQueuedMessages() === true, "dispose 前有队列");

  engine.dispose();
  assert(engine.steeringQueueLength === 0, "dispose 后 steering 空");
  assert(engine.followUpQueueLength === 0, "dispose 后 followUp 空");
  assert(engine.hasQueuedMessages() === false, "dispose 后 hasQueuedMessages=false");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ DeerLoopEngine 队列测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ DeerLoopEngine 队列：全部断言通过（steer/followUp 入队 + drain all/one + followUp 触发新 turn + maxFollowUps + abort 保留 + clear + dispose）");
