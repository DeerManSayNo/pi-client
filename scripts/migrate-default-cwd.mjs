#!/usr/bin/env node

/**
 * 迁移脚本：将 pi-cwd-YYYYMMDD 目录下的历史 session 合并到统一的 pi-cwd 目录。
 *
 * 背景：之前 /api/default-cwd 每天创建一个新的 ~/pi-cwd-YYYYMMDD 目录，
 * 导致 session 被分散存储在不同的目录下，在侧边栏中显示为不同的「项目」。
 * 修复后统一使用 ~/pi-cwd，此脚本将历史 session 迁移过去。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const AGENT_SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");

// 目标目录：统一后的 pi-cwd 对应的 session 目录
// cwd = ~/pi-cwd → session dir = --Users-huanghaoqi-pi-cwd--
const NEW_CWD = join(HOME, "pi-cwd");
const NEW_SESSION_DIR = join(AGENT_SESSIONS_DIR, `--${NEW_CWD.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);

// 扫描日期目录
const DATE_DIRS = readdirSync(AGENT_SESSIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.match(/^--Users-huanghaoqi-pi-cwd-\d{8}--$/))
  .map((d) => ({ name: d.name, path: join(AGENT_SESSIONS_DIR, d.name) }));

if (DATE_DIRS.length === 0) {
  console.log("未找到需要迁移的日期目录。");
  process.exit(0);
}

// Ensure target directory exists
if (!existsSync(NEW_SESSION_DIR)) {
  mkdirSync(NEW_SESSION_DIR, { recursive: true });
  console.log(`创建目标目录: ${NEW_SESSION_DIR}`);
}

let totalMigrated = 0;
let totalSkipped = 0;

for (const dir of DATE_DIRS) {
  const files = readdirSync(dir.path).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    // Remove empty directory
    try { renameSync(dir.path, dir.path + ".bak"); console.log(`清空目录已备份: ${dir.name}.bak`); } catch {}
    continue;
  }

  console.log(`\n处理 ${dir.name} (${files.length} 个 session):`);

  for (const file of files) {
    const srcPath = join(dir.path, file);
    const destPath = join(NEW_SESSION_DIR, file);

    // Skip if already exists in target
    if (existsSync(destPath)) {
      console.log(`  跳过 (已存在): ${file}`);
      totalSkipped++;
      continue;
    }

    try {
      const content = readFileSync(srcPath, "utf8");
      const lines = content.split("\n");

      // Update the cwd field in the session header (first line)
      if (lines.length > 0) {
        try {
          const header = JSON.parse(lines[0]);
          if (header.type === "session" && header.cwd) {
            // Replace ~/pi-cwd-YYYYMMDD with ~/pi-cwd
            const oldCwd = header.cwd;
            const newCwdValue = NEW_CWD.replace(/\/$/, ""); // strip trailing slash
            if (oldCwd !== newCwdValue) {
              header.cwd = newCwdValue;
              lines[0] = JSON.stringify(header);
            }
          }
        } catch {
          // If header parse fails, copy as-is
        }
      }

      const newContent = lines.join("\n");
      writeFileSync(destPath, newContent, "utf8");
      // Remove original file after successful copy
      unlinkSync(srcPath);
      console.log(`  ✓ ${file}`);
      totalMigrated++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}`);
    }
  }

  // Backup old directory after migrating all its files
  try {
    renameSync(dir.path, dir.path + ".bak");
    console.log(`  已备份旧目录: ${dir.name}.bak`);
  } catch (err) {
    console.error(`  无法备份旧目录: ${err.message}`);
  }
}

console.log(`\n迁移完成！`);
console.log(`  已迁移: ${totalMigrated} 个 session`);
console.log(`  已跳过: ${totalSkipped} 个 session`);
console.log(`  目标目录: ${NEW_SESSION_DIR}`);
console.log(`\n旧目录已重命名为 .bak，确认无误后可手动删除。`);
console.log(`请在迁移后重启 app (npm run dev) 以便重新加载 session 列表。`);
