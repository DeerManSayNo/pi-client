#!/usr/bin/env node
/**
 * Download the Node.js binary for the target platform as a Tauri sidecar.
 *
 * Usage:
 *   node scripts/download-node-binary.js                  # current platform
 *   node scripts/download-node-binary.js --platform win32 # Windows x64
 *   node scripts/download-node-binary.js --platform darwin --arch x64  # Intel Mac
 *   node scripts/download-node-binary.js --list           # show all targets
 *
 * The binary is placed in src-tauri/binaries/ with Tauri's expected naming convention:
 *   node-{targetTriple}[.exe]
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { parseArgs } = require("util");

const { values: args } = parseArgs({
  options: {
    platform: { type: "string" },
    arch:     { type: "string" },
    list:     { type: "boolean", default: false },
  },
  strict: false,
});

// ── Platform → Node.js download manifest ──────────────────────────────────────
const NODE_VERSION = "22.14.0"; // LTS

const TARGETS = {
  "darwin-arm64": {
    nodeTriple: "darwin-arm64",
    tauriTriple: "aarch64-apple-darwin",
    ext: "",
  },
  "darwin-x64": {
    nodeTriple: "darwin-x64",
    tauriTriple: "x86_64-apple-darwin",
    ext: "",
  },
  "win32-x64": {
    nodeTriple: "win-x64",
    tauriTriple: "x86_64-pc-windows-msvc",
    ext: ".exe",
  },
};

if (args.list) {
  console.log("Available targets:");
  for (const [key, t] of Object.entries(TARGETS)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${t.nodeTriple}.tar.gz`;
    console.log(`  ${key.padEnd(16)} → ${url}`);
  }
  process.exit(0);
}

// ── Resolve target ────────────────────────────────────────────────────────────
const platform = args.platform ?? process.platform;
const arch = args.arch ?? (process.arch === "arm64" ? "arm64" : "x64");
const key = `${platform}-${arch}`;
const target = TARGETS[key];

if (!target) {
  console.error(`Unsupported target: ${key}`);
  console.error("Use --list to see available targets.");
  process.exit(1);
}

const binariesDir = path.join(__dirname, "..", "src-tauri", "binaries");
const destName = `node-${target.tauriTriple}${target.ext}`;
const destPath = path.join(binariesDir, destName);

// ── Check if already downloaded ───────────────────────────────────────────────
if (fs.existsSync(destPath)) {
  console.log(`✅ Binary already exists: ${destPath}`);
  console.log(`   Delete it first if you want to re-download.`);
  process.exit(0);
}

// ── Download & extract ────────────────────────────────────────────────────────
const archiveName = `node-v${NODE_VERSION}-${target.nodeTriple}.tar.gz`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;

console.log(`⬇  Downloading Node.js ${NODE_VERSION} for ${key}...`);
console.log(`   ${url}`);

// Download to temp file
const tmpArchive = path.join(binariesDir, archiveName);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return download(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const total = parseInt(response.headers["content-length"], 10);
      let downloaded = 0;
      response.on("data", (chunk) => {
        downloaded += chunk.length;
        if (total) process.stdout.write(`\r   ${((downloaded / total) * 100).toFixed(1)}%`);
      });
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        process.stdout.write("\r   Done!          \n");
        resolve();
      });
      file.on("error", reject);
    }).on("error", reject);
  });
}

fs.mkdirSync(binariesDir, { recursive: true });

download(url, tmpArchive)
  .then(() => {
    // Extract
    console.log("📦 Extracting...");
    execSync(`tar -xzf "${archiveName}"`, { cwd: binariesDir, stdio: "inherit" });

    // Move binary into place
    const extractedDir = `node-v${NODE_VERSION}-${target.nodeTriple}`;
    const extractedBin = path.join(binariesDir, extractedDir, "bin", `node${target.ext}`);
    fs.renameSync(extractedBin, destPath);

    // Make executable on Unix
    if (target.ext === "") {
      fs.chmodSync(destPath, 0o755);
    }

    // Cleanup
    fs.rmSync(path.join(binariesDir, extractedDir), { recursive: true, force: true });
    fs.unlinkSync(tmpArchive);

    console.log(`✅ Binary saved as: ${destPath}`);
  })
  .catch((err) => {
    console.error(`❌ Failed: ${err.message}`);
    // Cleanup temp file
    try { fs.unlinkSync(tmpArchive); } catch {}
    process.exit(1);
  });
