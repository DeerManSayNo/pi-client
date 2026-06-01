import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { dirname, join, delimiter } from "path";
import { execPath } from "process";

const execFileAsync = promisify(execFile);

const EXTRA_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

function withNpxPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const currentPath = env.PATH || env.Path || env.path || "";
  const parts = currentPath.split(delimiter).filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return { ...env, PATH: parts.join(delimiter) };
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const paths = (env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, command);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Locate `npx-cli.js` shipped with the running Node.js installation.
 *
 * On Windows the `npx` on PATH is actually `npx.cmd`, which Node.js (since
 * 20.12 due to CVE-2024-27980) refuses to spawn from `execFile`/`spawn`
 * without `shell: true`. Going through a shell reintroduces quoting bugs for
 * user-supplied args. Instead we find the real `npx-cli.js` and invoke it
 * directly via the current `node` binary, which works identically on every
 * platform and needs no shell.
 */
function findNpxCli(): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [
    // Windows MSI installer layout: node.exe and node_modules share a dir
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    // Unix layout: .../bin/node + .../lib/node_modules/npm/bin/npx-cli.js
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * Cross-platform wrapper for invoking `npx <args>` without ever using a
 * shell, so user-controlled arguments are never interpreted as shell syntax.
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  const env = withNpxPath(opts.env);
  const npxCli = findNpxCli();
  const npxBin = findOnPath(process.platform === "win32" ? "npx.cmd" : "npx", env);
  const { command, commandArgs } = npxCli
    ? { command: execPath, commandArgs: [npxCli, ...args] }
    : { command: npxBin || "npx", commandArgs: args };
  return execFileAsync(command, commandArgs, {
    timeout: opts.timeout,
    cwd: opts.cwd,
    env,
  });
}
