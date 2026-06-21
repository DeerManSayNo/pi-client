/**
 * PiSessionStoreAdapter 单测（M6 验收 #3）。
 *
 * 用 mock pi SessionManager，验证 Adapter 方法委托正确（调用转发 + 参数透传 + 返回值）。
 *
 * 运行：node --experimental-strip-types scripts/test-session-store.mjs
 */
import { PiSessionStoreAdapter } from "../lib/session/pi-session-store.ts";

let failures = 0;
function assert(cond, msg, extra) {
  if (!cond) {
    console.error("  ❌ FAIL:", msg, extra === undefined ? "" : JSON.stringify(extra));
    failures++;
  } else {
    console.log("  ✅", msg);
  }
}

/** mock pi SessionManager（记录所有调用）。 */
function makeMockSm(overrides = {}) {
  const calls = [];
  const sm = {
    getSessionFile: () => overrides.filePath ?? "/tmp/test.jsonl",
    getCwd: () => overrides.cwd ?? "/tmp/work",
    isPersisted: () => overrides.persisted ?? true,
    appendMessage: (msg) => { calls.push({ method: "appendMessage", msg }); return `msg-${calls.length}`; },
    appendCustomEntry: (type, data) => { calls.push({ method: "appendCustomEntry", type, data }); return `custom-${calls.length}`; },
    getEntries: () => overrides.entries ?? [{ id: "e1", type: "message" }],
    getBranch: (leafId) => { calls.push({ method: "getBranch", leafId }); return overrides.branch ?? [{ id: "e1" }]; },
    createBranchedSession: (parentLeafId, options) => { calls.push({ method: "createBranchedSession", parentLeafId, options }); return `/tmp/branched-${calls.length}.jsonl`; },
    getLeaves: () => overrides.leaves ?? [{ id: "leaf1" }],
    ...overrides.mockMethods,
  };
  return { sm, calls };
}

// ---------------------------------------------------------------------------
// 用例 1：只读属性
// ---------------------------------------------------------------------------
console.log("\n[用例 1] 只读属性委托");
{
  const { sm } = makeMockSm({ filePath: "/a/b.jsonl", cwd: "/work", persisted: true });
  const adapter = new PiSessionStoreAdapter(sm);
  assert(adapter.filePath === "/a/b.jsonl", "filePath 委托");
  assert(adapter.getCwd() === "/work", "getCwd 委托");
  assert(adapter.isPersisted() === true, "isPersisted 委托");
}

// ---------------------------------------------------------------------------
// 用例 2：appendMessage / appendCustomEntry 参数透传
// ---------------------------------------------------------------------------
console.log("\n[用例 2] appendMessage / appendCustomEntry 参数透传");
{
  const { sm, calls } = makeMockSm();
  const adapter = new PiSessionStoreAdapter(sm);
  const msg = { role: "user", content: "hi", timestamp: 1 };
  const id1 = adapter.appendMessage(msg);
  assert(id1.startsWith("msg-"), "appendMessage 返回 id");
  assert(calls[0].method === "appendMessage", "调了 appendMessage");
  assert(calls[0].msg === msg, "appendMessage 参数透传");

  const id2 = adapter.appendCustomEntry("role_profile", { roleId: "coder" });
  assert(id2.startsWith("custom-"), "appendCustomEntry 返回 id");
  assert(calls[1].method === "appendCustomEntry", "调了 appendCustomEntry");
  assert(calls[1].type === "role_profile", "type 参数透传");
  assert(calls[1].data.roleId === "coder", "data 参数透传");
}

// ---------------------------------------------------------------------------
// 用例 3：getEntries / getBranch / getLeaves
// ---------------------------------------------------------------------------
console.log("\n[用例 3] getEntries / getBranch / getLeaves");
{
  const entries = [{ id: "e1" }, { id: "e2" }];
  const { sm, calls } = makeMockSm({ entries, branch: [{ id: "e2" }] });
  const adapter = new PiSessionStoreAdapter(sm);

  const got = adapter.getEntries();
  // ★ adapter 内部 .map(toSessionEntry) 产生新数组，不能 === 比较引用
  assert(got.length === 2, "getEntries 返回 2 条");
  assert(got[0].id === "e1", "getEntries[0].id=e1");
  assert(got[1].id === "e2", "getEntries[1].id=e2");

  const branch = adapter.getBranch("leaf-x");
  assert(branch.length === 1, "getBranch 长度");
  assert(calls[0].method === "getBranch", "调了 getBranch");
  assert(calls[0].leafId === "leaf-x", "getBranch leafId 透传");

  const leaves = adapter.getLeaves();
  assert(Array.isArray(leaves), "getLeaves 返回数组");
}

// ---------------------------------------------------------------------------
// 用例 4：createBranchedSession
// ---------------------------------------------------------------------------
console.log("\n[用例 4] createBranchedSession");
{
  const { sm, calls } = makeMockSm();
  const adapter = new PiSessionStoreAdapter(sm);
  // ★ pi@0.75.5 真实签名只接受 parentLeafId，options 被忽略（adapter 内部丢弃）
  const newFile = adapter.createBranchedSession("parent-1", { position: "at" });
  assert(typeof newFile === "string", "createBranchedSession 返回 string");
  assert(calls[0].method === "createBranchedSession", "调了 createBranchedSession");
  assert(calls[0].parentLeafId === "parent-1", "parentLeafId 透传");
}

// ---------------------------------------------------------------------------
// 用例 5：无参 getBranch
// ---------------------------------------------------------------------------
console.log("\n[用例 5] getBranch 无参调用");
{
  const { sm, calls } = makeMockSm();
  const adapter = new PiSessionStoreAdapter(sm);
  adapter.getBranch();
  assert(calls[0].method === "getBranch", "无参也调了 getBranch");
  assert(calls[0].leafId === undefined, "leafId=undefined 透传");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ PiSessionStoreAdapter 测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ PiSessionStoreAdapter：全部断言通过（只读属性/写入/查询/分支/无参）");
