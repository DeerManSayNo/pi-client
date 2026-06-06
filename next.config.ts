import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "@mariozechner/clipboard",
    "@silvia-odwyer/photon-node",
    "cross-spawn",
    "glob",
    "hosted-git-info",
    "ignore",
    "jiti",
    "node-cron",
    "proper-lockfile",
    "undici",
    "yaml",
  ],
  allowedDevOrigins: ["127.0.0.1", "192.168.*.*"],
  devIndicators: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
