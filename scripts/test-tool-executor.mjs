/**
 * ToolExecutor 单测（M2 验收 #4）。
 *
 * 覆盖：
 *   1. 并发：3 个 parallel 工具真并发（用计时验证，非串行）
 *   2. 串行：sequential 工具严格串行（后一个等前一个完成）
 *   3. 错误隔离：1 个 throw 不影响同批其他工具
 *   4. executionMode 覆盖：setExecutionMode 后该工具变串行
 *   5. 事件成对：tool_execution_start ↔ tool_execution_end
 *   6. 源序返回：结果顺序 = 输入 toolCalls 顺序（非完成序）
 *
 * 运行：node --experimental-strip-types scripts/test-tool-executor.mjs
 */
import { ToolRegistry } from "../lib/engine/tool-registry.ts";
import { ToolExecutor } from "../lib/engine/tool-executor.ts";

let failures = 0;
function assert(cond, msg, extra) {
  if (!cond) {
    console.error("  ❌ FAIL:", msg, extra === undefined ? "" : JSON.stringify(extra));
    failures++;
  } else {
    console.log("  ✅", msg);
  }
}

const FAKE_CTX = {
  ui: new Proxy({}, { get: () => () => undefined }),
  hasUI: false,
  cwd: "/tmp",
  model: undefined,
  isIdle: () => true,
  signal: undefined,
  abort: () => {},
  hasPendingMessages: () => false,
  shutdown: () => {},
  getContextUsage: () => undefined,
  compact: () => {},
  getSystemPrompt: () => "",
};

/** 构造 ToolCall。 */
function makeCall(name, args = {}) {
  return { type: "toolCall", id: `call_${name}_${Math.random().toString(36).slice(2, 7)}`, name, arguments: args };
}

/** 构造一个带计时能力的 mock 工具。 */
function makeTimedTool(name, { executionMode, delayMs = 50 } = {}) {
  const log = { startTimes: [], endTimes: [] };
  return {
    tool: {
      name,
      label: name,
      description: `mock ${name}`,
      parameters: { type: "object", properties: {} },
      executionMode,
      execute: async (id, _params, _signal, _onUpdate, _ctx) => {
        log.startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, delayMs));
        log.endTimes.push(Date.now());
        return { content: [{ type: "text", text: `${name} done` }], details: { name } };
      },
    },
    log,
  };
}

/** 构造一个会 throw 的 mock 工具。 */
function makeThrowingTool(name, { executionMode } = {}) {
  return {
    name,
    label: name,
    description: `mock ${name} (throws)`,
    parameters: { type: "object", properties: {} },
    executionMode,
    execute: async () => {
      throw new Error(`${name} exploded`);
    },
  };
}

/** 收集事件。 */
function makeCollector() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

const NO_ABORT = new AbortController().signal;

// ---------------------------------------------------------------------------
// 用例 1：并发执行（3 个 parallel，验证真并发非串行）
// ---------------------------------------------------------------------------
console.log("\n[用例 1] 并发：3 个 parallel 工具真并发");
{
  const reg = new ToolRegistry();
  const a = makeTimedTool("pa", { executionMode: "parallel", delayMs: 60 });
  const b = makeTimedTool("pb", { executionMode: "parallel", delayMs: 60 });
  const c = makeTimedTool("pc", { executionMode: "parallel", delayMs: 60 });
  reg.register(a.tool); reg.register(b.tool); reg.register(c.tool);
  const exec = new ToolExecutor(reg);
  const col = makeCollector();

  const calls = [makeCall("pa"), makeCall("pb"), makeCall("pc")];
  const t0 = Date.now();
  const outputs = await exec.executeBatch(calls, NO_ABORT, FAKE_CTX, col.emit);
  const elapsed = Date.now() - t0;

  assert(outputs.length === 3, "返回 3 个结果");
  assert(elapsed < 150, `并发总耗时 < 150ms（实际 ${elapsed}ms，串行会 ~180ms）`, elapsed);

  // 三个工具的 start 时间应该非常接近（都在前 30ms 内启动）
  const minStart = Math.min(a.log.startTimes[0], b.log.startTimes[0], c.log.startTimes[0]);
  const maxStart = Math.max(a.log.startTimes[0], b.log.startTimes[0], c.log.startTimes[0]);
  assert(maxStart - minStart < 30, `三个 parallel 工具启动时间差 < 30ms（实际 ${maxStart - minStart}ms）`, maxStart - minStart);

  // 每个工具都成功
  assert(outputs.every((o) => !o.isError), "全部成功（无错误）");
}

// ---------------------------------------------------------------------------
// 用例 2：串行执行（sequential 严格串行）
// ---------------------------------------------------------------------------
console.log("\n[用例 2] 串行：3 个 sequential 工具严格串行");
{
  const reg = new ToolRegistry();
  const a = makeTimedTool("sa", { executionMode: "sequential", delayMs: 50 });
  const b = makeTimedTool("sb", { executionMode: "sequential", delayMs: 50 });
  const c = makeTimedTool("sc", { executionMode: "sequential", delayMs: 50 });
  reg.register(a.tool); reg.register(b.tool); reg.register(c.tool);
  const exec = new ToolExecutor(reg);
  const col = makeCollector();

  const calls = [makeCall("sa"), makeCall("sb"), makeCall("sc")];
  const t0 = Date.now();
  await exec.executeBatch(calls, NO_ABORT, FAKE_CTX, col.emit);
  const elapsed = Date.now() - t0;

  assert(elapsed >= 140, `串行总耗时 >= 140ms（实际 ${elapsed}ms，并发会 < 90ms）`, elapsed);

  // 验证顺序：a.end < b.start < b.end < c.start（严格串行无重叠）
  assert(a.log.endTimes[0] <= b.log.startTimes[0], "a 结束后 b 才开始");
  assert(b.log.endTimes[0] <= c.log.startTimes[0], "b 结束后 c 才开始");
}

// ---------------------------------------------------------------------------
// 用例 3：错误隔离（1 个 throw 不影响其他）
// ---------------------------------------------------------------------------
console.log("\n[用例 3] 错误隔离：1 个 throw 不拖垮同批");
{
  const reg = new ToolRegistry();
  const ok1 = makeTimedTool("ok1", { executionMode: "parallel", delayMs: 30 });
  const bad = makeThrowingTool("bad", { executionMode: "parallel" });
  const ok2 = makeTimedTool("ok2", { executionMode: "parallel", delayMs: 30 });
  reg.register(ok1.tool); reg.register(bad); reg.register(ok2.tool);
  const exec = new ToolExecutor(reg);
  const col = makeCollector();

  const calls = [makeCall("ok1"), makeCall("bad"), makeCall("ok2")];
  const outputs = await exec.executeBatch(calls, NO_ABORT, FAKE_CTX, col.emit);

  assert(outputs.length === 3, "返回 3 个结果（throw 的也有结果）");
  assert(!outputs[0].isError, "ok1 成功");
  assert(outputs[1].isError, "bad 标记为错误");
  assert(!outputs[2].isError, "ok2 成功（未被 bad 拖垮）");
  assert(outputs[1].result.content[0].text.includes("exploded"), "bad 错误消息透传", outputs[1].result.content[0].text);
}

// ---------------------------------------------------------------------------
// 用例 4：executionMode 覆盖（setExecutionMode 改变行为）
// ---------------------------------------------------------------------------
console.log("\n[用例 4] executionMode 覆盖：自带 parallel → 覆盖为 sequential");
{
  const reg = new ToolRegistry();
  const a = makeTimedTool("ov_a", { executionMode: "parallel", delayMs: 50 });
  const b = makeTimedTool("ov_b", { executionMode: "parallel", delayMs: 50 });
  reg.register(a.tool); reg.register(b.tool);
  // 覆盖 a 为 sequential
  reg.setExecutionMode("ov_a", "sequential");
  const exec = new ToolExecutor(reg);

  const calls = [makeCall("ov_a"), makeCall("ov_b")];
  const t0 = Date.now();
  await exec.executeBatch(calls, NO_ABORT, FAKE_CTX, () => {});
  const elapsed = Date.now() - t0;

  // ov_a 是 sequential，ov_b 是 parallel → sequential 组先跑完（50ms），再跑 parallel（50ms）= ~100ms
  assert(elapsed >= 90, `sequential-first 耗时 >= 90ms（实际 ${elapsed}ms）`, elapsed);
  assert(a.log.endTimes[0] <= b.log.startTimes[0] + 5, "sequential 组先完成，parallel 组后开始");
}

// ---------------------------------------------------------------------------
// 用例 5：事件成对（tool_execution_start ↔ end，按源序）
// ---------------------------------------------------------------------------
console.log("\n[用例 5] 事件成对发射");
{
  const reg = new ToolRegistry();
  reg.register(makeTimedTool("e1", { executionMode: "parallel", delayMs: 10 }).tool);
  reg.register(makeTimedTool("e2", { executionMode: "parallel", delayMs: 10 }).tool);
  const exec = new ToolExecutor(reg);
  const col = makeCollector();

  await exec.executeBatch([makeCall("e1"), makeCall("e2")], NO_ABORT, FAKE_CTX, col.emit);

  const starts = col.events.filter((e) => e.type === "tool_execution_start");
  const ends = col.events.filter((e) => e.type === "tool_execution_end");
  assert(starts.length === 2, "2 个 tool_execution_start");
  assert(ends.length === 2, "2 个 tool_execution_end");

  // 每个 start 都有对应的 end（按 toolCallId 配对）
  for (const s of starts) {
    const matchingEnd = ends.find((e) => e.toolCallId === s.toolCallId);
    assert(matchingEnd != null, `start(${s.toolName}) 有配对 end`);
    const sIdx = col.events.indexOf(s);
    const eIdx = col.events.indexOf(matchingEnd);
    assert(sIdx < eIdx, `start(${s.toolName}) 在 end 之前`);
  }
}

// ---------------------------------------------------------------------------
// 用例 6：源序返回（结果顺序 = 输入顺序，非完成序）
// ---------------------------------------------------------------------------
console.log("\n[用例 6] 源序返回");
{
  const reg = new ToolRegistry();
  // 故意让快的在前慢的在后，验证返回仍按源序
  reg.register(makeTimedTool("fast", { executionMode: "parallel", delayMs: 10 }).tool);
  reg.register(makeTimedTool("slow", { executionMode: "parallel", delayMs: 80 }).tool);
  const exec = new ToolExecutor(reg);

  const calls = [makeCall("slow"), makeCall("fast")];  // slow 在前
  const outputs = await exec.executeBatch(calls, NO_ABORT, FAKE_CTX, () => {});

  assert(outputs[0].result.details.name === "slow", "结果[0]=slow（源序，虽后完成）");
  assert(outputs[1].result.details.name === "fast", "结果[1]=fast（源序，虽先完成）");
}

// ---------------------------------------------------------------------------
// 用例 7：工具不存在 → 合成错误结果（不 crash）
// ---------------------------------------------------------------------------
console.log("\n[用例 7] 工具不存在 → 错误结果");
{
  const reg = new ToolRegistry();
  const exec = new ToolExecutor(reg);
  const col = makeCollector();

  const outputs = await exec.executeBatch([makeCall("ghost")], NO_ABORT, FAKE_CTX, col.emit);

  assert(outputs.length === 1, "返回 1 个结果");
  assert(outputs[0].isError, "ghost 标记错误");
  assert(outputs[0].result.content[0].text.includes("not registered"), "错误消息含 not registered");

  const end = col.events.find((e) => e.type === "tool_execution_end");
  assert(end != null && end.isError, "事件：tool_execution_end 带 isError");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ ToolExecutor 测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ ToolExecutor：全部断言通过（并发/串行/错误隔离/mode覆盖/事件成对/源序/未注册）");
