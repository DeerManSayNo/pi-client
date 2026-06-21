/**
 * RetryPolicy 单测（M4 验收 #3）。
 *
 * 覆盖：
 *   1. isRetryable 基本判定（普通错误重试、超过 maxAttempts 不重试）
 *   2. H3：premature-stream 错误 + contentLength >= 20 → 不重试
 *   3. H3 边界：premature-stream + contentLength < 20 → 重试
 *   4. H2：delayMs 退避递增（>= minDelayMs，指数）
 *   5. H4：getSettleMs 返回配置值
 *   6. 自定义参数（maxAttempts/minDelayMs/settleMs）
 *
 * 运行：node --experimental-strip-types scripts/test-retry-policy.mjs
 */
import {
  DefaultRetryPolicy,
  getAssistantContentLength,
  PREMATURE_STREAM_ERROR_RE,
  MIN_AUTO_RETRY_DELAY_MS,
  AUTO_RETRY_SETTLE_MS,
} from "../lib/engine/retry-policy.ts";

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
// 用例 1：基本重试判定
// ---------------------------------------------------------------------------
console.log("\n[用例 1] isRetryable 基本判定");
{
  const policy = new DefaultRetryPolicy({ maxAttempts: 3 });
  assert(policy.maxAttempts === 3, "maxAttempts=3");

  // 普通错误：可重试
  const d1 = policy.isRetryable({ attempt: 1, errorMessage: "Internal Server Error", partialMessage: null, contentLength: 0 });
  assert(d1.retry === true, "普通错误 attempt=1 可重试");
  assert(d1.delayMs >= MIN_AUTO_RETRY_DELAY_MS, `delayMs >= ${MIN_AUTO_RETRY_DELAY_MS}`, d1.delayMs);

  // 超过 maxAttempts：不重试
  const d4 = policy.isRetryable({ attempt: 4, errorMessage: "err", partialMessage: null, contentLength: 0 });
  assert(d4.retry === false, "attempt=4 > maxAttempts=3 不重试");
}

// ---------------------------------------------------------------------------
// 用例 2：H3 —— premature-stream + 长内容 → 不重试
// ---------------------------------------------------------------------------
console.log("\n[用例 2] H3：premature-stream + contentLength >= 20 → 不重试");
{
  const policy = new DefaultRetryPolicy();
  const prematureErr = "Connection lost: websocket closed";
  assert(PREMATURE_STREAM_ERROR_RE.test(prematureErr), "测试用的错误消息匹配 PREMATURE_STREAM_ERROR_RE");

  // contentLength >= 20 + premature → 不重试
  const d = policy.isRetryable({ attempt: 1, errorMessage: prematureErr, partialMessage: null, contentLength: 25 });
  assert(d.retry === false, "premature + contentLength=25 → 不重试（H3）");

  // 边界：恰好 20
  const d20 = policy.isRetryable({ attempt: 1, errorMessage: prematureErr, partialMessage: null, contentLength: 20 });
  assert(d20.retry === false, "premature + contentLength=20 → 不重试（边界 >= 20）");
}

// ---------------------------------------------------------------------------
// 用例 3：H3 边界 —— premature-stream + 短内容 → 重试
// ---------------------------------------------------------------------------
console.log("\n[用例 3] H3 边界：premature-stream + contentLength < 20 → 重试");
{
  const policy = new DefaultRetryPolicy();

  // contentLength < 20 + premature → 重试（LLM 没产出有效内容，值得重试）
  const d = policy.isRetryable({ attempt: 1, errorMessage: "websocket closed", partialMessage: null, contentLength: 10 });
  assert(d.retry === true, "premature + contentLength=10 → 重试（内容太少）");

  // contentLength = 0（连接都没建立）
  const d0 = policy.isRetryable({ attempt: 1, errorMessage: "terminated", partialMessage: null, contentLength: 0 });
  assert(d0.retry === true, "premature + contentLength=0 → 重试");
}

// ---------------------------------------------------------------------------
// 用例 4：H2 —— delayMs 退避递增（指数）
// ---------------------------------------------------------------------------
console.log("\n[用例 4] H2：delayMs 指数退避递增");
{
  const policy = new DefaultRetryPolicy({ minDelayMs: 1000, maxAttempts: 5 });

  const d1 = policy.isRetryable({ attempt: 1, errorMessage: "err", partialMessage: null, contentLength: 0 });
  const d2 = policy.isRetryable({ attempt: 2, errorMessage: "err", partialMessage: null, contentLength: 0 });
  const d3 = policy.isRetryable({ attempt: 3, errorMessage: "err", partialMessage: null, contentLength: 0 });

  assert(d1.delayMs === 1000, `attempt=1 delayMs=1000 (= minDelayMs)`, d1.delayMs);
  assert(d2.delayMs === 2000, `attempt=2 delayMs=2000 (2x)`, d2.delayMs);
  assert(d3.delayMs === 4000, `attempt=3 delayMs=4000 (4x)`, d3.delayMs);
  assert(d1.delayMs < d2.delayMs && d2.delayMs < d3.delayMs, "delayMs 严格递增");
}

// ---------------------------------------------------------------------------
// 用例 5：H4 —— getSettleMs
// ---------------------------------------------------------------------------
console.log("\n[用例 5] H4：getSettleMs 返回配置值");
{
  const defaultPolicy = new DefaultRetryPolicy();
  assert(defaultPolicy.getSettleMs() === AUTO_RETRY_SETTLE_MS, `默认 settleMs=${AUTO_RETRY_SETTLE_MS}`);

  const custom = new DefaultRetryPolicy({ settleMs: 250 });
  assert(custom.getSettleMs() === 250, "自定义 settleMs=250");
}

// ---------------------------------------------------------------------------
// 用例 6：自定义参数 / 默认值
// ---------------------------------------------------------------------------
console.log("\n[用例 6] 自定义参数与默认值");
{
  const defaultPolicy = new DefaultRetryPolicy();
  assert(defaultPolicy.maxAttempts === 3, "默认 maxAttempts=3");

  const custom = new DefaultRetryPolicy({ maxAttempts: 5, minDelayMs: 500, settleMs: 100 });
  assert(custom.maxAttempts === 5, "自定义 maxAttempts=5");
  assert(custom.isRetryable({ attempt: 1, errorMessage: "x", partialMessage: null, contentLength: 0 }).delayMs === 500, "自定义 minDelayMs=500 生效");
  assert(custom.getSettleMs() === 100, "自定义 settleMs=100 生效");
}

// ---------------------------------------------------------------------------
// 用例 7：getAssistantContentLength helper
// ---------------------------------------------------------------------------
console.log("\n[用例 7] getAssistantContentLength helper");
{
  assert(getAssistantContentLength({ content: "hello world" }) === 11, "字符串 content 长度正确");
  assert(getAssistantContentLength({ content: "  trim me  " }) === 7, "字符串 trim 后长度");
  assert(getAssistantContentLength({ content: [] }) === 0, "空数组=0");
  assert(getAssistantContentLength({ content: null }) === 0, "null=0");
  assert(getAssistantContentLength({ content: [{ type: "text", text: "abc" }] }) === 3, "text block");
  assert(getAssistantContentLength({ content: [{ type: "thinking", thinking: "xyz" }] }) === 3, "thinking block");
  assert(getAssistantContentLength({ content: [{ type: "text", text: "ab" }, { type: "thinking", thinking: "cd" }] }) === 4, "多 block 累加");
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error("\n❌ RetryPolicy 测试失败：%d 项未通过", failures);
  process.exit(1);
}
console.log("\n✅ RetryPolicy：全部断言通过（基本判定/H3/H2退避/H4静默/自定义/helper）");
