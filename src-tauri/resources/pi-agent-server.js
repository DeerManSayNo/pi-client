#!/usr/bin/env node
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const resourceDir = process.env.PI_AGENT_RESOURCE_DIR;
const port = process.env.PORT || "30141";
if (!resourceDir) {
  console.error("PI_AGENT_RESOURCE_DIR is not set");
  process.exit(1);
}

const bundledStandaloneDir = path.join(resourceDir, "app", "standalone");
const standaloneDir = fs.existsSync(path.join(bundledStandaloneDir, "server.js"))
  ? bundledStandaloneDir
  : path.join(resourceDir, ".next", "standalone");
const child = spawn(process.execPath, [path.join(standaloneDir, "server.js")], {
  cwd: standaloneDir,
  stdio: "inherit",
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    PORT: port,
  },
});

const shutdown = () => child.kill();
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
