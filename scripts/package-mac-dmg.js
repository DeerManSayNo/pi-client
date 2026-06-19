const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.platform !== "darwin") {
  console.error("package:mac-dmg can only run on macOS.");
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const tauriConfig = require(path.join(repoRoot, "src-tauri", "tauri.conf.json"));

const productName = tauriConfig.productName || packageJson.name;
const version = tauriConfig.version || packageJson.version;
const arch = os.arch() === "arm64" ? "aarch64" : os.arch();

const bundleRoot = path.join(repoRoot, "src-tauri", "target", "release", "bundle");
const appPath = path.join(bundleRoot, "macos", `${productName}.app`);
const dmgDir = path.join(bundleRoot, "dmg");
const dmgPath = path.join(dmgDir, `${productName}_${version}_${arch}.dmg`);

if (!fs.existsSync(appPath)) {
  console.error(`Missing app bundle: ${appPath}`);
  console.error("Run `tauri build --bundles app` before packaging the DMG.");
  process.exit(1);
}

fs.mkdirSync(dmgDir, { recursive: true });

const stagingDir = fs.mkdtempSync(path.join(dmgDir, `${packageJson.name}-dmg-staging-`));

try {
  fs.cpSync(appPath, path.join(stagingDir, `${productName}.app`), { recursive: true });
  fs.symlinkSync("/Applications", path.join(stagingDir, "Applications"));

  run("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    stagingDir,
    "-ov",
    // ULFO uses LZMA compression — ~10% smaller than zlib's UDZO.
    // Requires macOS 10.11+ to mount; our minimumSystemVersion is 11.0.
    "-format",
    "ULFO",
    dmgPath,
  ]);

  run("hdiutil", ["verify", dmgPath]);

  console.log(`Created DMG: ${dmgPath}`);
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
