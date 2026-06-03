import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: string;
}

interface MemoryFile {
  version: 1;
  global: MemoryItem[];
}

function nowIso(): string { return new Date().toISOString(); }
function uid(): string { return `memory_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export function memoryFilePath(): string {
  return path.join(getAgentDir(), "memory.json");
}

export function readGlobalMemory(): MemoryItem[] {
  const file = memoryFilePath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MemoryFile>;
    return Array.isArray(parsed.global)
      ? parsed.global.filter((m): m is MemoryItem => Boolean(m?.id && typeof m.text === "string")).map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt ?? nowIso() }))
      : [];
  } catch {
    return [];
  }
}

export function writeGlobalMemory(items: MemoryItem[]): MemoryItem[] {
  const normalized = items
    .filter((m) => typeof m.text === "string")
    .map((m) => ({ id: m.id || uid(), text: m.text, createdAt: m.createdAt || nowIso() }));
  const file = memoryFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, global: normalized }, null, 2));
  return normalized;
}

export function composeGlobalMemoryPrompt(): string {
  const items = readGlobalMemory().filter((m) => m.text.trim());
  if (!items.length) return "";
  return ["# Global Memory / 全局记忆", ...items.map((m) => `- ${m.text.trim()}`)].join("\n");
}
