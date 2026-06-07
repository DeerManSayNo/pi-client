import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const INDEX_DIR = path.join(getAgentDir(), "indexes");
export const MAX_FILE_SIZE = 512 * 1024;
export const SNIPPET_CONTEXT_LINES = 3;
export const DEFAULT_SEARCH_LIMIT = 20;

export const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
]);

export const IGNORED_EXTENSIONS = new Set([
  ".lock",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".gz", ".tgz", ".rar", ".7z",
  ".mp3", ".mp4", ".mov", ".avi",
  ".wasm", ".bin", ".exe", ".dll", ".dylib", ".so",
]);
