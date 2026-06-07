#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const resourceDir = process.env.DEERHUX_RESOURCE_DIR;
const port = process.env.PORT || "30141";
if (!resourceDir) {
  console.error("DEERHUX_RESOURCE_DIR is not set");
  process.exit(1);
}

// Set env before requiring server.js so it picks up correct config
process.env.HOSTNAME = "127.0.0.1";
process.env.NODE_ENV = "production";
process.env.PORT = port;

// Point agent data to DeerHux directory
const home = process.env.HOME || require("os").homedir();
const deerhuxAgentDir = require("path").join(home, ".deerhux", "agent");
if (!process.env.DEERHUX_CODING_AGENT_DIR) {
  process.env.DEERHUX_CODING_AGENT_DIR = deerhuxAgentDir;
}
// Backward-compatible fallback for unpatched @earendil-works/pi-coding-agent builds.
if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = deerhuxAgentDir;
}

const bundledStandaloneDir = path.join(resourceDir, "app", "standalone");
const standaloneDir = fs.existsSync(path.join(bundledStandaloneDir, "server.js"))
  ? bundledStandaloneDir
  : path.join(resourceDir, ".next", "standalone");

process.chdir(standaloneDir);
require(path.join(standaloneDir, "server.js"));
