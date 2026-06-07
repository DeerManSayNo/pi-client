#!/usr/bin/env node

/**
 * 迁移脚本：将 deerhux-cwd-YYYYMMDD / pi-cwd-YYYYMMDD 目录下的历史 session
 * 合并到统一的 ~/deerhux-cwd 目录。
 *
 * 背景：之前 /api/default-cwd 每天创建一个新的 ~/*-cwd-YYYYMMDD 目录，
 * 导致 session 被分散存储在不同的目录下，在侧边栏中显示为不同的「项目」。
 * 修复后统一使用 ~/deerhux-cwd，此脚本将历史 session 迁移过去。
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();

function encodeCwdForSessionDir(cwd) {
  return `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
}

function resolveAgentSessionsDir() {
  const deerhux = join(HOME, ".deerhux", "agent", "sessions");
  if (existsSync(deerhux)) return deerhux;
  const legacy = join(HOME, ".pi", "agent", "sessions");
  if (existsSync(legacy)) return legacy;
  return deerhux;
}

const AGENT_SESSIONS_DIR = resolveAgentSessionsDir();
const NEW_CWD = join(HOME, "deerhux-cwd");
const NEW_SESSION_DIR = join(AGENT_SESSIONS_DIR, encodeCwdForSessionDir(NEW_CWD));

const homePrefix = encodeCwdForSessionDir(HOME).replace(/^--/, "").replace(/--$/, "");
const DATE_DIR_RE = new RegExp(
  `^--${homePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(?:deerhux-cwd|pi-cwd)-\\d{8}--$`,
);

const DATE_DIRS = existsSync(AGENT_SESSIONS_DIR)
  ? readdirSync(AGENT_SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && DATE_DIR_RE.test(d.name))
      .map((d) => ({ name: d.name, path: join(AGENT_SESSIONS_DIR, d.name) }))
  : [];

if (DATE_DIRS.length === 0) {
  console.log("未找到需要迁移的日期目录。");
  process.exit(0);
}

if (!existsSync(NEW_SESSION_DIR)) {
  mkdirSync(NEW_SESSION_DIR, { recursive: true });
  console.log(`创建目标目录: ${NEW_SESSION_DIR}`);
}

let totalMigrated = 0;
let totalSkipped = 0;

for (const dir of DATE_DIRS) {
  const files = readdirSync(dir.path).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    try {
      renameSync(dir.path, dir.path + ".bak");
      console.log(`清空目录已备份: ${dir.name}.bak`);
    } catch {}
    continue;
  }

  console.log(`\n处理 ${dir.name} (${files.length} 个 session):`);

  for (const file of files) {
    const srcPath = join(dir.path, file);
    const destPath = join(NEW_SESSION_DIR, file);

    if (existsSync(destPath)) {
      console.log(`  跳过 (已存在): ${file}`);
      totalSkipped++;
      continue;
    }

    try {
      const content = readFileSync(srcPath, "utf8");
      const lines = content.split("\n");

      if (lines.length > 0) {
        try {
          const header = JSON.parse(lines[0]);
          if (header.type === "session" && header.cwd) {
            const newCwdValue = NEW_CWD.replace(/\/$/, "");
            if (header.cwd !== newCwdValue) {
              header.cwd = newCwdValue;
              lines[0] = JSON.stringify(header);
            }
          }
        } catch {
          // If header parse fails, copy as-is
        }
      }

      writeFileSync(destPath, lines.join("\n"), "utf8");
      unlinkSync(srcPath);
      console.log(`  ✓ ${file}`);
      totalMigrated++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}`);
    }
  }

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
