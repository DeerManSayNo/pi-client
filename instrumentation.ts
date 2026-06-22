// ============================================================================
// Next.js Instrumentation — runs once at server startup
// - Migrates legacy ~/.pi/agent data into ~/.deerhux/agent on first startup
// - Sets DeerHux agent dir to ~/.deerhux/agent so the runtime uses DeerHux paths
// - Ensures default skills are installed to ~/.deerhux/agent/skills/
// - Registers the scheduler engine for cron-based task execution
// ============================================================================

export async function register() {
  // Only start scheduler on the Node.js server side (not Edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const fs = await import("fs");
    const path = await import("path");

    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      const { migratePiAgentDir } = await import("./lib/legacy-migration");
      migratePiAgentDir(home);

      // Set agent directory to DeerHux path before any pi-coding-agent module calls getAgentDir()
      const deerhuxAgentDir = path.join(home, ".deerhux", "agent");
      if (!process.env.DEERHUX_CODING_AGENT_DIR) {
        process.env.DEERHUX_CODING_AGENT_DIR = deerhuxAgentDir;
      }
      // Backward-compatible fallback for unpatched @earendil-works/pi-coding-agent builds.
      if (!process.env.PI_CODING_AGENT_DIR) {
        process.env.PI_CODING_AGENT_DIR = deerhuxAgentDir;
      }

      const targetDir = path.join(home, ".deerhux", "agent", "skills");
      fs.mkdirSync(targetDir, { recursive: true });

      // Resolve the bundled skills directory.
      // In production (Tauri), skills are bundled at app/standalone/skills/.
      // In dev, process.cwd() is the project root where skills/ lives.
      const skillsDir = path.join(process.cwd(), "skills");
      if (fs.existsSync(skillsDir)) {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

          const srcSkillMd = path.join(skillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(srcSkillMd)) continue;

          const destDir = path.join(targetDir, entry.name);
          const destSkillMd = path.join(destDir, "SKILL.md");

          // Only copy if not already present (respects user modifications)
          if (fs.existsSync(destSkillMd)) continue;

          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcSkillMd, destSkillMd);
          console.log(`[init] Installed default skill: ${entry.name}`);
        }
      }
    }

    const { startScheduler } = await import("./lib/scheduler/engine");
    startScheduler();

    // 启动期孤儿清理：清掉上一次进程遗留的 /tmp/deerhux-runs 目录 + git worktree 注册。
    // 放在 register() 末尾、且只跑一次：此时内存 Map 为空、无并发 run，清掉的全部是孤儿。
    try {
      const { cleanupOrphanedRuns } = await import("./lib/parallel-agent/worktree");
      const result = cleanupOrphanedRuns();
      if (result.removedDirs > 0 || result.pruned) {
        console.log(`[init] Cleaned orphaned subagent runs: ${result.removedDirs} dir(s), worktree prune ${result.pruned ? "done" : "skipped"}`);
      }
    } catch {
      /* best effort — 不影响启动 */
    }
  }
}
