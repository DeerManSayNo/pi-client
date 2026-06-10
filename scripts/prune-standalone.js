const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const standaloneDir = path.join(repoRoot, ".next", "standalone");

const generatedPaths = [
  path.join(standaloneDir, "src-tauri", "target"),
];

for (const generatedPath of generatedPaths) {
  if (!fs.existsSync(generatedPath)) continue;
  fs.rmSync(generatedPath, { recursive: true, force: true });
  console.log(`Removed generated build output from standalone: ${path.relative(repoRoot, generatedPath)}`);
}
