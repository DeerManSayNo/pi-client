import crypto from "crypto";
import fs from "fs";
import path from "path";
import { INDEX_DIR } from "./config";

export function cwdHash(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function getIndexPath(cwd: string): string {
  return path.join(INDEX_DIR, `${cwdHash(cwd)}.json`);
}

export function ensureIndexDir(): void {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
}
