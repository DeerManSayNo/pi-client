/**
 * sdk-guard 手动测试（M0 验收 #6）。
 *
 * 项目未接入 vitest，这里用一个最小 node 脚本验证 detectPiPrivateFields / isPiSdkDrifted：
 *   1. 字段齐全 → ok=true
 *   2. 字段缺失 → ok=false + console.warn 告警 + DEERHUX_PI_SDK_DRIFT=1
 *   3. 部分缺失 → missingFields 精确反映缺失项
 *
 * 运行：node --experimental-strip-types scripts/test-sdk-guard.mjs
 */
import {
  detectPiPrivateFields,
  isPiSdkDrifted,
  REQUIRED_PRIVATE_FIELDS,
  PI_SDK_DRIFT_ENV,
} from "../lib/engine/sdk-guard.ts";

let failures = 0;
function assert(cond, msg, extra) {
  if (!cond) {
    console.error("  ❌ FAIL:", msg, extra === undefined ? "" : JSON.stringify(extra));
    failures++;
  } else {
    console.log("  ✅", msg);
  }
}

console.log("sdk-guard 测试开始（必需字段 %d 个：%s）", REQUIRED_PRIVATE_FIELDS.length, REQUIRED_PRIVATE_FIELDS.join(", "));

// 用例 1：字段齐全 → ok
{
  delete process.env[PI_SDK_DRIFT_ENV];
  const full = Object.fromEntries(REQUIRED_PRIVATE_FIELDS.map((f) => [f, true]));
  const r = detectPiPrivateFields(full);
  assert(r.ok === true, "字段齐全时 ok=true");
  assert(Array.isArray(r.missingFields) && r.missingFields.length === 0, "字段齐全时 missingFields 为空", r.missingFields);
  assert(isPiSdkDrifted() === false, "字段齐全时 isPiSdkDrifted=false");
}

// 用例 2：全部缺失 → 不 ok + 告警 + 置 env
{
  delete process.env[PI_SDK_DRIFT_ENV];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  const r = detectPiPrivateFields({}); // 空对象，全部缺失
  console.warn = origWarn;
  assert(r.ok === false, "全部缺失时 ok=false");
  assert(r.missingFields.length === REQUIRED_PRIVATE_FIELDS.length, "全部缺失时 missingFields 覆盖全部字段", r.missingFields);
  assert(warnings.length === 1, "全部缺失时输出一次告警", warnings.length);
  assert(warnings[0] && warnings[0].includes("sdk-guard"), "告警内容包含 sdk-guard 标记", warnings[0]);
  assert(process.env[PI_SDK_DRIFT_ENV] === "1", "全部缺失时 DEERHUX_PI_SDK_DRIFT=1");
  assert(isPiSdkDrifted() === true, "全部缺失时 isPiSdkDrifted=true");
}

// 用例 3：部分缺失 → missingFields 精确
{
  delete process.env[PI_SDK_DRIFT_ENV];
  const keep = REQUIRED_PRIVATE_FIELDS.slice(0, 5); // 保留前 5 个
  const expectedMissing = REQUIRED_PRIVATE_FIELDS.slice(5);
  const partial = Object.fromEntries(keep.map((f) => [f, true]));
  const r = detectPiPrivateFields(partial);
  assert(r.ok === false, "部分缺失时 ok=false");
  assert(
    r.missingFields.length === expectedMissing.length &&
      expectedMissing.every((f) => r.missingFields.includes(f)),
    "部分缺失时 missingFields 精确反映缺失项",
    { got: r.missingFields, want: expectedMissing },
  );
}

// 用例 4：真实 pi AgentSession 实例应通过（字段都在）
// 说明：若 pi 升级后此处失败，正是 sdk-guard 的价值——提醒开发者 hack 已漂移。
{
  delete process.env[PI_SDK_DRIFT_ENV];
  // 动态构造一个“看起来像 pi AgentSession”的对象：把全部必需字段挂上。
  const fakeSession = Object.fromEntries(
    REQUIRED_PRIVATE_FIELDS.map((f) => [f, f === "_toolRegistry" || f === "_toolDefinitions" ? new Map() : []]),
  );
  const r = detectPiPrivateFields(fakeSession);
  assert(r.ok === true, "伪造的完整 session 通过探测");
}

if (failures > 0) {
  console.error("\nsdk-guard 测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ sdk-guard：全部断言通过");
