import path from "path";
import { DEFAULT_SEARCH_LIMIT, SNIPPET_CONTEXT_LINES } from "./config";
import { readIndex } from "./database";

export interface CodeSearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}_$.-]+/u).map(t => t.trim()).filter(Boolean);
}

function buildSnippet(content: string, matchedLine: number): { startLine: number; endLine: number; snippet: string } {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, matchedLine - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length - 1, matchedLine + SNIPPET_CONTEXT_LINES);
  return {
    startLine: start + 1,
    endLine: end + 1,
    snippet: lines.slice(start, end + 1).map((line, i) => `${start + i + 1}: ${line}`).join("\n"),
  };
}

export async function searchIndex(
  cwd: string,
  query: string,
  options: { path?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<CodeSearchResult[]> {
  options.signal?.throwIfAborted();
  const index = await readIndex(path.resolve(cwd));
  if (!index) return [];

  const q = query.trim();
  if (!q) return [];
  const needle = q.toLowerCase();
  const queryTerms = terms(q);
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, 100));
  const pathPrefix = options.path?.replace(/^\/+/, "");
  const results: CodeSearchResult[] = [];

  for (const file of index.files) {
    options.signal?.throwIfAborted();
    if (pathPrefix && !file.path.startsWith(pathPrefix)) continue;
    const lower = file.content.toLowerCase();
    const lines = file.content.split(/\r?\n/);
    let bestLine = -1;
    let score = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      let lineScore = 0;
      if (line.includes(needle)) lineScore += 10;
      for (const term of queryTerms) if (line.includes(term)) lineScore += 1;
      if (lineScore > score) {
        score = lineScore;
        bestLine = i;
      }
    }

    if (score === 0) {
      const fileScore = queryTerms.reduce((acc, term) => acc + (lower.includes(term) ? 1 : 0), 0);
      if (fileScore === 0) continue;
      const firstMatch = queryTerms.find(t => lower.includes(t)) ?? "";
      const pos = lower.indexOf(firstMatch);
      bestLine = pos >= 0
        ? file.content.slice(0, pos).split(/\r?\n/).length - 1
        : 0;
      score = fileScore;
    }

    const snippet = buildSnippet(file.content, bestLine);
    results.push({ ...snippet, path: file.path, score });
  }

  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
