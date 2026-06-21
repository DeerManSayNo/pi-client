/**
 * DeerLoopEngine 工具调用循环测试（M2 验收 #5）。
 *
 * 验证完整的 tool-calling 循环：
 *   1. toolCall → 执行 → ToolResultMessage → 下一轮 LLM
 *   2. 多轮 toolUse 循环
 *   3. abort during tool execution
 *   4. maxToolRounds 防死循环
 *
 * 运行：node --experimental-strip-types scripts/test-deer-loop-tools.mjs
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

/** 构造 assistant partial（纯文本）。 */
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

/** 构造带 ToolCall 的 assistant partial。 */
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

/** 构造 ToolCall。 */
function toolCall(id, name, args = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

/** 把事件列表包成 AsyncIterable。 */
function makeStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

/** 构造「先 toolUse 再 stop」的两轮事件序列。 */
function twoRoundStream(call) {
  return [
    // 第一轮：toolcall_start → end → done(toolUse)
    { type: "start", partial: toolCallPartial([call]) },
    { type: "toolcall_start", contentIndex: 0, partial: toolCallPartial([call]) },
    { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: toolCallPartial([call]) },
    { type: "done", reason: "toolUse", message: toolCallPartial([call]) },
  ];
}

function stopRoundStream(text = "All done") {
  return [
    { type: "start", partial: textPartial("") },
    { type: "text_delta", contentIndex: 0, delta: text, partial: textPartial(text) },
    { type: "done", reason: "stop", message: textPartial(text) },
  ];
}

/** 收集事件。 */
function collectEvents(engine) {
  const events = [];
  engine.subscribe((ev) => events.push(ev));
  return events;
}

/** mock 工具：记录被调次数 + 返回固定结果。 */
function makeMockTool(name, opts = {}) {
  const calls = [];
  return {
    tool: {
      name,
      label: name,
      description: `mock ${name}`,
      parameters: { type: "object", properties: {} },
      executionMode: opts.executionMode || "parallel",
      execute: async (toolCallId, params, _signal, _onUpdate, _ctx) => {
        calls.push({ toolCallId, params, time: Date.now() });
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.throw) throw new Error(`${name} failed`);
        return {
          content: [{ type: "text", text: opts.result ?? `${name} result` }],
          details: { name, params },
          changedFiles: opts.changedFiles,
        };
      },
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// 用例 1：单轮工具调用 → 下一轮 stop（完整循环）
// ---------------------------------------------------------------------------
console.log("\n[用例 1] 单轮工具调用 → 下一轮 stop");
{
  const mockRead = makeMockTool("read", { result: "file: hello world" });
  let streamCallCount = 0;
  const mockStreamFn = (_model, _context, _options) => {
    streamCallCount++;
    if (streamCallCount === 1) {
      // 第一轮：LLM 要调 read
      return makeStream(twoRoundStream(toolCall("call_1", "read", { path: "/foo" })));
    }
    // 第二轮：LLM 看到 read 结果后，返回纯文本 stop
    return makeStream(stopRoundStream("I read the file: hello world"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tool-test-1",
    systemPrompt: "you are helpful",
    tools: [mockRead.tool],
    activeToolNames: ["read"],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.prompt("read /foo");

  // streamSimple 被调 2 次（第一轮 toolUse + 第二轮 stop）
  assert(streamCallCount === 2, "streamFn 被调 2 次（工具循环 2 轮）", streamCallCount);

  // read 工具被执行 1 次
  assert(mockRead.calls.length === 1, "read 工具执行 1 次", mockRead.calls.length);
  assert(mockRead.calls[0].params.path === "/foo", "read 参数正确", mockRead.calls[0].params);

  // 事件类型序列
  const types = collected.map((e) => e.type);
  const toolStartIdx = types.indexOf("tool_execution_start");
  const toolEndIdx = types.indexOf("tool_execution_end");
  assert(toolStartIdx > 0, "有 tool_execution_start 事件");
  assert(toolEndIdx > toolStartIdx, "tool_execution_end 在 start 之后");

  // 验证两轮 message_start/message_end（第一轮 toolUse + 第二轮 stop）
  const startCount = types.filter((t) => t === "message_start").length;
  const endCount = types.filter((t) => t === "message_end").length;
  assert(startCount === 2, "2 次 message_start（2 轮 LLM）", startCount);
  assert(endCount === 2, "2 次 message_end", endCount);

  // 最后是 agent_end
  assert(types[types.length - 1] === "agent_end", "最后是 agent_end");

  // agent_end.messages 包含完整对话历史
  const agentEnd = collected.find((e) => e.type === "agent_end");
  // user + assistant(toolUse) + toolResult + assistant(stop) = 4
  assert(agentEnd.messages.length === 4, "transcript 含 4 条消息", agentEnd.messages.length);
  assert(agentEnd.messages[0].role === "user", "msg[0]=user");
  assert(agentEnd.messages[1].role === "assistant", "msg[1]=assistant(toolUse)");
  assert(agentEnd.messages[2].role === "toolResult", "msg[2]=toolResult");
  assert(agentEnd.messages[3].role === "assistant", "msg[3]=assistant(stop)");

  // toolResult 的内容
  const toolResult = agentEnd.messages[2];
  assert(toolResult.toolCallId === "call_1", "toolResult.toolCallId=call_1");
  assert(toolResult.toolName === "read", "toolResult.toolName=read");
  assert(!toolResult.isError, "toolResult.isError=false（成功）");

  console.log("    事件序列:", types.join(" → "));
}

// ---------------------------------------------------------------------------
// 用例 2：多轮工具调用（2 个不同工具，2 轮 toolUse）
// ---------------------------------------------------------------------------
console.log("\n[用例 2] 多轮工具调用（2 轮 toolUse 后 stop）");
{
  const mockRead = makeMockTool("read", { result: "content" });
  const mockGrep = makeMockTool("grep", { result: "found 3 matches" });
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    if (streamCallCount === 1) {
      return makeStream(twoRoundStream(toolCall("c1", "read", { path: "/a" })));
    }
    if (streamCallCount === 2) {
      return makeStream(twoRoundStream(toolCall("c2", "grep", { pattern: "foo" })));
    }
    return makeStream(stopRoundStream("done"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tool-test-2",
    tools: [mockRead.tool, mockGrep.tool],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.prompt("read and grep");

  assert(streamCallCount === 3, "streamFn 被调 3 次（2 轮工具 + 1 轮 stop）", streamCallCount);
  assert(mockRead.calls.length === 1, "read 执行 1 次");
  assert(mockGrep.calls.length === 1, "grep 执行 1 次");

  const agentEnd = collected.find((e) => e.type === "agent_end");
  // user + asst(toolUse) + toolResult + asst(toolUse) + toolResult + asst(stop) = 6
  assert(agentEnd.messages.length === 6, "transcript 含 6 条消息", agentEnd.messages.length);
  assert(agentEnd.messages[2].toolName === "read", "第 1 个 toolResult=read");
  assert(agentEnd.messages[4].toolName === "grep", "第 2 个 toolResult=grep");
}

// ---------------------------------------------------------------------------
// 用例 3：abort 在工具执行期间
// ---------------------------------------------------------------------------
console.log("\n[用例 3] abort during tool execution");
{
  const mockSlow = makeMockTool("slow_tool", { delayMs: 500, result: "slow" });
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(twoRoundStream(toolCall("c1", "slow_tool", {})));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tool-test-abort",
    tools: [mockSlow.tool],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  // 并发：prompt 开始后，等工具开始执行再 abort
  const promptPromise = engine.prompt("run slow tool");
  // 等 stream 第一轮完成（toolUse），工具开始执行
  await new Promise((r) => setTimeout(r, 100));
  await engine.abort();
  await promptPromise;

  const types = collected.map((e) => e.type);
  assert(types[types.length - 1] === "agent_end", "abort 后最后是 agent_end");
  assert(mockSlow.calls.length === 1, "slow_tool 被调用了（abort 可能已在执行中）", mockSlow.calls.length);

  // abort 后 agent_end，无第二轮 stream 调用
  assert(streamCallCount === 1, "abort 后只有 1 轮 stream（未进入第二轮）", streamCallCount);

  // 资源释放
  assert(engine.isStreaming === false, "abort 后 isStreaming=false");
}

// ---------------------------------------------------------------------------
// 用例 4：工具执行错误 → 结果回填给 LLM（不中断 loop）
// ---------------------------------------------------------------------------
console.log("\n[用例 4] 工具 throw → 错误结果回填 LLM");
{
  const mockBad = makeMockTool("bad_tool", { throw: true });
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    if (streamCallCount === 1) {
      return makeStream(twoRoundStream(toolCall("c1", "bad_tool", {})));
    }
    return makeStream(stopRoundStream("sorry it failed"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tool-test-err",
    tools: [mockBad.tool],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.prompt("use bad tool");

  // 工具 throw 不中断 loop：第二轮仍被调用
  assert(streamCallCount === 2, "工具 throw 后仍进入第二轮", streamCallCount);

  // tool_execution_end 带 isError
  const toolEnd = collected.find((e) => e.type === "tool_execution_end");
  assert(toolEnd.isError === true, "tool_execution_end.isError=true");
  assert(toolEnd.result.content[0].text.includes("failed"), "错误消息回填", toolEnd.result.content[0].text);

  // ToolResultMessage 带 isError=true
  const agentEnd = collected.find((e) => e.type === "agent_end");
  const toolResult = agentEnd.messages.find((m) => m.role === "toolResult");
  assert(toolResult.isError === true, "toolResult.isError=true（LLM 会看到错误）");

  // agent_end 无 error（工具错误被隔离，不是 agent 错误）
  assert(agentEnd.error === undefined, "agent_end 无 error（工具错误已隔离）");
}

// ---------------------------------------------------------------------------
// 用例 5：maxToolRounds 防死循环
// ---------------------------------------------------------------------------
console.log("\n[用例 5] maxToolRounds 防死循环");
{
  const mockLoop = makeMockTool("loop_tool", { result: "again" });
  let streamCallCount = 0;
  // LLM 永远要调工具（每轮都返回 toolUse）
  const mockStreamFn = () => {
    streamCallCount++;
    return makeStream(twoRoundStream(toolCall(`c${streamCallCount}`, "loop_tool", {})));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tool-test-loop",
    tools: [mockLoop.tool],
    streamFn: mockStreamFn,
    maxToolRounds: 3,  // 限制 3 轮
  });
  const collected = collectEvents(engine);

  await engine.prompt("infinite tool loop");

  // 最多 3 轮工具调用 + 可能的第 4 轮 stream（被 break）
  assert(mockLoop.calls.length <= 3, `loop_tool 执行 <= 3 次（maxToolRounds=3）`, mockLoop.calls.length);

  const agentEnd = collected.find((e) => e.type === "agent_end");
  assert(agentEnd.error !== undefined, "agent_end 带 error（强制停止）", agentEnd.error);
  assert(/最大工具调用轮数|超过最大/.test(agentEnd.error), "error 提及最大轮数", agentEnd.error);
}

// ---------------------------------------------------------------------------
// 用例 6：changedFiles 透传（tool_execution_end）
// ---------------------------------------------------------------------------
console.log("\n[用例 6] changedFiles 透传");
{
  const mockEdit = makeMockTool("edit", { changedFiles: ["/tmp/foo.txt", "/tmp/bar.txt"] });
  let streamCallCount = 0;
  const mockStreamFn = () => {
    streamCallCount++;
    if (streamCallCount === 1) {
      return makeStream(twoRoundStream(toolCall("c1", "edit", { file: "/tmp/foo.txt" })));
    }
    return makeStream(stopRoundStream("edited"));
  };

  const engine = new DeerLoopEngine({
    model: FAKE_MODEL,
    cwd: "/tmp",
    sessionId: "tool-test-files",
    tools: [mockEdit.tool],
    streamFn: mockStreamFn,
  });
  const collected = collectEvents(engine);

  await engine.prompt("edit file");

  const toolEnd = collected.find((e) => e.type === "tool_execution_end");
  assert(toolEnd.changedFiles != null, "tool_execution_end 带 changedFiles");
  assert(toolEnd.changedFiles.length === 2, "changedFiles 长度=2", toolEnd.changedFiles.length);
  assert(toolEnd.changedFiles.includes("/tmp/foo.txt"), "changedFiles 含 /tmp/foo.txt");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ DeerLoopEngine 工具循环测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ DeerLoopEngine 工具循环：全部断言通过（单轮/多轮/abort/错误隔离/防死循环/changedFiles）");
