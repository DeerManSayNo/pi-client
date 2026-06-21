/**
 * ToolRegistry 单测（M2 验收 #3）。
 *
 * 覆盖：register 覆盖、unregister、setActive 白名单过滤、
 * executionMode 覆盖（单工具 / 默认 / 自带）、replaceBatch 原子性。
 *
 * 运行：node --experimental-strip-types scripts/test-tool-registry.mjs
 */
import { ToolRegistry } from "../lib/engine/tool-registry.ts";

let failures = 0;
function assert(cond, msg, extra) {
  if (!cond) {
    console.error("  ❌ FAIL:", msg, extra === undefined ? "" : JSON.stringify(extra));
    failures++;
  } else {
    console.log("  ✅", msg);
  }
}

/** 构造一个最小 ToolDefinition mock。 */
function makeTool(name, opts = {}) {
  return {
    name,
    label: name,
    description: `mock ${name}`,
    parameters: { type: "object", properties: {} },
    executionMode: opts.executionMode,
    execute: async () => ({ content: [], details: {} }),
  };
}

// ---------------------------------------------------------------------------
// 用例 1：register / has / get / getAll
// ---------------------------------------------------------------------------
console.log("\n[用例 1] register / has / get / getAll");
{
  const reg = new ToolRegistry();
  const t1 = makeTool("read");
  const t2 = makeTool("grep");

  reg.register(t1);
  reg.register(t2);

  assert(reg.has("read"), "has(read)=true");
  assert(reg.has("grep"), "has(grep)=true");
  assert(!reg.has("bash"), "has(bash)=false");
  assert(reg.get("read") === t1, "get(read) 返回原对象");
  assert(reg.get("nope") === undefined, "get(未注册)=undefined");
  assert(reg.getAll().length === 2, "getAll() 长度=2", reg.getAll().length);

  // register 防呆：缺 name / 缺 execute
  let threw = false;
  try { reg.register({ label: "x" }); } catch { threw = true; }
  assert(threw, "register 缺 name 时 throw");
  threw = false;
  try { reg.register({ name: "bad" }); } catch { threw = true; }
  assert(threw, "register 缺 execute 时 throw");
}

// ---------------------------------------------------------------------------
// 用例 2：unregister（同时清白名单 + mode 覆盖）
// ---------------------------------------------------------------------------
console.log("\n[用例 2] unregister 清理联动");
{
  const reg = new ToolRegistry();
  reg.register(makeTool("read"));
  reg.setActive(["read"]);
  reg.setExecutionMode("read", "sequential");

  reg.unregister("read");

  assert(!reg.has("read"), "unregister 后 has=false");
  assert(reg.getActiveNames().length === 0, "unregister 后白名单清空");
  assert(reg.getExecutionMode("read") === "parallel", "unregister 后 mode 覆盖清除（回退默认）");
}

// ---------------------------------------------------------------------------
// 用例 3：setActive 白名单过滤（未注册的静默忽略）
// ---------------------------------------------------------------------------
console.log("\n[用例 3] setActive 白名单过滤");
{
  const reg = new ToolRegistry();
  reg.register(makeTool("read"));
  reg.register(makeTool("grep"));

  // 传入未注册的 ghost，不应进入白名单
  reg.setActive(["read", "grep", "ghost_tool"]);

  const active = reg.getActiveNames();
  assert(active.length === 2, "白名单长度=2（ghost 被过滤）", active);
  assert(active.includes("read") && active.includes("grep"), "白名单含 read+grep");
  assert(!active.includes("ghost_tool"), "白名单不含 ghost");

  // getActive 返回的是 ToolDefinition 数组
  const activeTools = reg.getActive();
  assert(activeTools.length === 2, "getActive() 长度=2");
  assert(activeTools.every((t) => typeof t.execute === "function"), "getActive 每项有 execute");

  // 传空数组 = 关闭全部
  reg.setActive([]);
  assert(reg.getActiveNames().length === 0, "setActive([]) 清空白名单");
}

// ---------------------------------------------------------------------------
// 用例 4：executionMode 优先级（覆盖 > 自带 > 默认）
// ---------------------------------------------------------------------------
console.log("\n[用例 4] executionMode 优先级");
{
  const reg = new ToolRegistry();
  reg.register(makeTool("read", { executionMode: "parallel" }));
  reg.register(makeTool("bash", { executionMode: "sequential" }));
  reg.register(makeTool("custom"));  // 无自带 mode

  // 默认：工具自带 mode
  assert(reg.getExecutionMode("read") === "parallel", "read 自带 parallel");
  assert(reg.getExecutionMode("bash") === "sequential", "bash 自带 sequential");
  assert(reg.getExecutionMode("custom") === "parallel", "custom 无自带 → 默认 parallel");

  // 覆盖优先
  reg.setExecutionMode("read", "sequential");
  assert(reg.getExecutionMode("read") === "sequential", "read 覆盖为 sequential");

  // 改默认
  reg.setDefaultExecutionMode("sequential");
  assert(reg.getExecutionMode("custom") === "sequential", "custom 跟随新默认 sequential");
  assert(reg.getExecutionMode("bash") === "sequential", "bash 仍 sequential（自带）");

  // 批量设
  reg.setExecutionModes({ read: "parallel", grep: "sequential" });
  assert(reg.getExecutionMode("read") === "parallel", "批量设后 read=parallel");
}

// ---------------------------------------------------------------------------
// 用例 5：replaceBatch 原子热替换（H9）
// ---------------------------------------------------------------------------
console.log("\n[用例 5] replaceBatch 原子热替换");
{
  const reg = new ToolRegistry();
  reg.register(makeTool("mcp_old1"));
  reg.register(makeTool("mcp_old2"));
  reg.register(makeTool("read"));
  reg.setActive(["mcp_old1", "mcp_old2", "read"]);

  // 热替换：移除旧 MCP，加入新 MCP，重设白名单
  reg.replaceBatch({
    removeNames: ["mcp_old1", "mcp_old2"],
    addTools: [makeTool("mcp_new1"), makeTool("mcp_new2")],
    activeToolNames: ["read", "mcp_new1", "mcp_new2"],
  });

  assert(!reg.has("mcp_old1"), "旧工具 mcp_old1 已移除");
  assert(!reg.has("mcp_old2"), "旧工具 mcp_old2 已移除");
  assert(reg.has("mcp_new1"), "新工具 mcp_new1 已注册");
  assert(reg.has("mcp_new2"), "新工具 mcp_new2 已注册");
  assert(reg.has("read"), "read 保留（不在 removeNames）");

  const active = reg.getActiveNames();
  assert(active.length === 3, "白名单=3", active);
  assert(active.includes("read") && active.includes("mcp_new1") && active.includes("mcp_new2"), "白名单正确");

  // extraAllowedNames：占位名字（即使未注册也保留在白名单...实际会被过滤）
  reg.replaceBatch({
    removeNames: [],
    addTools: [],
    activeToolNames: ["read"],
    extraAllowedNames: ["mcp_future"],
  });
  const active2 = reg.getActiveNames();
  assert(active2.length === 1 && active2[0] === "read", "extraAllowedNames 未注册的被过滤", active2);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ ToolRegistry 测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ ToolRegistry：全部断言通过（register/unregister/setActive/mode/replaceBatch）");
