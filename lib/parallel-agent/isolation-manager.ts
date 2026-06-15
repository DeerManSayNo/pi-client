import {
  applyPatch,
  cleanupWorkspace,
  generateDiff,
  getRepoStatus,
  isGitRepo,
  setupIsolatedWorkspace,
} from "./worktree";

export {
  cleanupWorkspace,
  generateDiff,
  getRepoStatus,
  isGitRepo,
};

export function prepareIsolatedWorkspace(cwd: string, workerNames: string[]) {
  return setupIsolatedWorkspace(cwd, workerNames);
}

export function applyWorkerPatch(mainCwd: string, worktreePath: string, files?: string[]) {
  return applyPatch(mainCwd, worktreePath, files);
}
