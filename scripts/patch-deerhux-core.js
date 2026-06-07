#!/usr/bin/env node
/*
 * Patch @earendil-works/pi-coding-agent so DeerHux uses DeerHux config paths:
 * - global agent dir: ~/.deerhux/agent
 * - project config dir: .deerhux
 *
 * This is needed because the upstream package defaults to the legacy config paths.
 */
const fs = require("fs");
const path = require("path");

const pkgPath = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");

if (!fs.existsSync(pkgPath)) {
  console.warn("[patch-deerhux-core] package not found:", pkgPath);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.piConfig = {
  ...(pkg.piConfig || {}),
  name: "deerhux",
  configDir: ".deerhux",
};

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("[patch-deerhux-core] patched @earendil-works/pi-coding-agent piConfig -> deerhux/.deerhux");
