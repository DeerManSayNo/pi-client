#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const resourceDir = process.env.PI_AGENT_RESOURCE_DIR;
const port = process.env.PORT || "30141";
if (!resourceDir) {
  console.error("PI_AGENT_RESOURCE_DIR is not set");
  process.exit(1);
}

// Set env before requiring server.js so it picks up correct config
process.env.HOSTNAME = "127.0.0.1";
process.env.NODE_ENV = "production";
process.env.PORT = port;

const bundledStandaloneDir = path.join(resourceDir, "app", "standalone");
const standaloneDir = fs.existsSync(path.join(bundledStandaloneDir, "server.js"))
  ? bundledStandaloneDir
  : path.join(resourceDir, ".next", "standalone");

process.chdir(standaloneDir);
require(path.join(standaloneDir, "server.js"));
