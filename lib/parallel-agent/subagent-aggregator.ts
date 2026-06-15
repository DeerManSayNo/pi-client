import type { CollaborationRunState } from "./collaboration-types";

export function buildSubagentSummary(run: CollaborationRunState): string {
  const completed = run.workers.filter((worker) => worker.status === "complete");
  const failed = run.workers.filter((worker) => worker.status === "error");
  const changed = run.workers.filter((worker) => worker.diffStats?.trim());

  const sections = [
    `## ${run.title ?? "Subagent task"}`,
    `状态：${failed.length > 0 ? "部分失败" : "已完成"} · ${completed.length}/${run.workers.length} 个子 Agent 完成`,
  ];

  if (completed.length > 0) {
    sections.push("## 结果摘要");
    sections.push(completed.map((worker) => {
      const body = (worker.result ?? "").trim() || "(无摘要)";
      const diff = worker.diffStats?.trim() ? `\n\n变更概览：\n${worker.diffStats.trim()}` : "";
      return `### ${worker.name}\n${body.slice(0, 1600)}${diff}`;
    }).join("\n\n"));
  }

  if (changed.length > 1) {
    sections.push("## 方案对比");
    sections.push(changed.map((worker) => `- ${worker.name}: ${(worker.diffStats ?? "").split("\n").map((line) => line.trim()).filter(Boolean).join("; ")}`).join("\n"));
    const recommended = chooseRecommendedWorker(changed);
    if (recommended) {
      sections.push("## 推荐方案");
      sections.push(`推荐优先审阅并应用 ${recommended.name}。它的变更范围相对更小，通常更容易检查和回滚；如果目标需要更高覆盖度，再对比其他方案的 diff。`);
    }
  }

  if (failed.length > 0) {
    sections.push("## 失败项");
    sections.push(failed.map((worker) => `- ${worker.name}: ${worker.error ?? "Unknown error"}`).join("\n"));
  }

  sections.push("## 下一步");
  sections.push(run.mode === "isolated_coding"
    ? "请先审阅子 Agent 的 diff，再选择要应用的方案或文件。"
    : "可打开子会话查看完整推理与证据，或让主 Agent 基于结论继续执行。");

  return sections.join("\n\n");
}

function chooseRecommendedWorker(workers: CollaborationRunState["workers"]): CollaborationRunState["workers"][number] | null {
  if (workers.length === 0) return null;
  return [...workers].sort((a, b) => diffScore(a.diffStats) - diffScore(b.diffStats))[0] ?? null;
}

function diffScore(stats?: string): number {
  if (!stats?.trim()) return Number.MAX_SAFE_INTEGER;
  const totals = [...stats.matchAll(/(\d+)\s+insertions?|\b(\d+)\s+deletions?/g)]
    .flatMap((match) => [match[1], match[2]])
    .filter(Boolean)
    .map(Number);
  const fileCount = Number(stats.match(/(\d+)\s+files?\s+changed/)?.[1] ?? 0);
  return fileCount * 1000 + totals.reduce((sum, value) => sum + value, 0);
}
