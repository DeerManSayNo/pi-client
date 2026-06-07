import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const RUNS_BASE_DIR = path.join(os.tmpdir(), "deerhux-runs");

export interface WorktreeResult {
  worktreePath: string;
  isValid: boolean;
}

/**
 * Check if a directory is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory for a given path.
 */
function getGitRoot(cwd: string): string {
  return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
}

/**
 * Ensure the base runs directory exists.
 */
function ensureRunsDir(): string {
  const runDir = path.join(RUNS_BASE_DIR, `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

/**
 * Create a git worktree for a worker.
 * Returns the worktree path.
 */
export function createWorktree(cwd: string, workerName: string, runDir: string): string {
  const safeName = workerName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const worktreePath = path.join(runDir, safeName);
  const gitRoot = getGitRoot(cwd);
  const headRef = "HEAD";

  execSync(`git worktree add "${worktreePath}" ${headRef}`, { cwd: gitRoot, stdio: "pipe" });

  return worktreePath;
}

/**
 * Create a temp directory copy for non-git projects.
 * Returns the temp directory path.
 */
export function createTempCopy(cwd: string, workerName: string, runDir: string): string {
  const safeName = workerName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const destPath = path.join(runDir, safeName);
  fs.cpSync(cwd, destPath, { recursive: true });
  return destPath;
}

/**
 * Remove a git worktree.
 */
export function removeWorktree(worktreePath: string, gitRoot: string): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: gitRoot, stdio: "pipe" });
  } catch {
    // Clean up manually if worktree remove fails
    try {
      const lockFile = path.join(gitRoot, ".git", "worktrees", path.basename(worktreePath), "locked");
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: gitRoot, stdio: "pipe" });
    } catch {
      // Best effort cleanup
    }
  }
}

/**
 * Clean up a temp directory.
 */
export function removeTempCopy(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Generate a diff for a worker's worktree against the main cwd.
 */
export function generateDiff(worktreePath: string): { diff: string; stats: string } {
  try {
    const diff = execSync("git diff HEAD", { cwd: worktreePath, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const stats = execSync("git diff --stat HEAD", { cwd: worktreePath, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { diff, stats };
  } catch {
    return { diff: "", stats: "" };
  }
}

/**
 * Apply a patch from a worktree to the main cwd.
 * Returns { success, conflict }.
 */
export function applyPatch(mainCwd: string, worktreePath: string): { success: boolean; error?: string } {
  try {
    // Generate patch and apply
    const diff = execSync("git diff HEAD", { cwd: worktreePath, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (!diff.trim()) {
      return { success: true };
    }

    // Check working tree is clean
    const status = execSync("git status --porcelain", { cwd: mainCwd, encoding: "utf8" });
    if (status.trim()) {
      // Try to apply anyway but warn about potential conflicts
      execSync("git apply", { cwd: mainCwd, input: diff, stdio: "pipe" });
    } else {
      execSync("git apply", { cwd: mainCwd, input: diff, stdio: "pipe" });
    }

    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // Check if it's a merge conflict
    if (errMsg.includes("patch does not apply") || errMsg.includes("conflict")) {
      return { success: false, error: `Patch conflict: ${errMsg.split("\n")[0]}` };
    }

    return { success: false, error: errMsg.split("\n")[0] };
  }
}

/**
 * Create worktree setup for all workers in a run.
 * Returns { runDir, gitRoot, isGit }
 */
export function setupIsolatedWorkspace(
  cwd: string,
  workerNames: string[],
): { runDir: string; gitRoot: string | null; isGit: boolean; worktrees: Map<string, string> } {
  const git = isGitRepo(cwd);
  const runDir = ensureRunsDir();
  const gitRoot = git ? getGitRoot(cwd) : null;
  const worktrees = new Map<string, string>();

  for (const name of workerNames) {
    if (git) {
      const wPath = createWorktree(cwd, name, runDir);
      worktrees.set(name, wPath);
    } else {
      const wPath = createTempCopy(cwd, name, runDir);
      worktrees.set(name, wPath);
    }
  }

  return { runDir, gitRoot, isGit: git, worktrees };
}

/**
 * Clean up all worktrees for a run.
 */
export function cleanupWorkspace(runDir: string, gitRoot: string | null, isGit: boolean): void {
  if (isGit && gitRoot) {
    // Remove worktrees
    const entries = fs.readdirSync(runDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        removeWorktree(path.join(runDir, entry.name), gitRoot);
      }
    }
  }

  // Remove run directory
  removeTempCopy(runDir);
}

/**
 * Get the main repo's current status (for conflict detection before apply).
 */
export function getRepoStatus(cwd: string): { clean: boolean; files: string[] } {
  const status = execSync("git status --porcelain", { cwd, encoding: "utf8" }).trim();
  if (!status) return { clean: true, files: [] };
  const files = status.split("\n").map(l => l.slice(3).trim()).filter(Boolean);
  return { clean: false, files };
}
