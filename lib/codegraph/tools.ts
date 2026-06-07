import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCodeGraphJson } from "./cli";
import { getCodeGraphStatus } from "./detect";

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function limit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value as number), max));
}

export async function createCodeGraphTools(cwd: string): Promise<ToolDefinition[]> {
  const status = await getCodeGraphStatus(cwd);
  if (!status?.initialized) return [];

  return [
    defineTool({
      name: "codegraph_status",
      label: "CodeGraph Status",
      description: "Get CodeGraph index status for the current project.",
      promptSnippet: "codegraph_status: Inspect semantic code graph index status, file count, symbol count, and pending changes.",
      parameters: Type.Object({}),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, _params, signal) => {
        const result = await runCodeGraphJson(["status", "--json"], { cwd, signal, timeoutMs: 10_000 });
        return { content: [{ type: "text" as const, text: pretty(result) }], details: result };
      },
    }),

    defineTool({
      name: "codegraph_search",
      label: "CodeGraph Search",
      description: "Search semantic code symbols using the CodeGraph index. Prefer this before grep/find for symbol lookup.",
      promptSnippet: "codegraph_search: Search semantic symbols in the CodeGraph index by name, qualified name, signature, or docstring.",
      promptGuidelines: [
        "Use codegraph_search before grep/find when looking for functions, classes, components, exported values, or other code symbols.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Symbol or natural-language search query" }),
        limit: Type.Optional(Type.Number({ description: "Maximum results, default 10, max 50" })),
        kind: Type.Optional(Type.String({ description: "Optional node kind filter, e.g. function, class, method, interface, component" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, params, signal) => {
        const args = ["query", params.query, "--json", "--limit", String(limit(params.limit, 10, 50))];
        if (params.kind) args.push("--kind", params.kind);
        const result = await runCodeGraphJson(args, { cwd, signal });
        return { content: [{ type: "text" as const, text: pretty(result) }], details: result };
      },
    }),

    defineTool({
      name: "codegraph_callers",
      label: "CodeGraph Callers",
      description: "Find functions or methods that call a symbol using CodeGraph call edges.",
      promptSnippet: "codegraph_callers: Find callers of a symbol from the semantic call graph.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Symbol/function/method name" }),
        limit: Type.Optional(Type.Number({ description: "Maximum results, default 20, max 100" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, params, signal) => {
        const result = await runCodeGraphJson(["callers", params.symbol, "--json", "--limit", String(limit(params.limit, 20, 100))], { cwd, signal });
        return { content: [{ type: "text" as const, text: pretty(result) }], details: result };
      },
    }),

    defineTool({
      name: "codegraph_callees",
      label: "CodeGraph Callees",
      description: "Find functions or methods called by a symbol using CodeGraph call edges.",
      promptSnippet: "codegraph_callees: Find callees/dependencies of a symbol from the semantic call graph.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Symbol/function/method name" }),
        limit: Type.Optional(Type.Number({ description: "Maximum results, default 20, max 100" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, params, signal) => {
        const result = await runCodeGraphJson(["callees", params.symbol, "--json", "--limit", String(limit(params.limit, 20, 100))], { cwd, signal });
        return { content: [{ type: "text" as const, text: pretty(result) }], details: result };
      },
    }),

    defineTool({
      name: "codegraph_impact",
      label: "CodeGraph Impact",
      description: "Analyze what code may be affected by changing a symbol using CodeGraph graph traversal.",
      promptSnippet: "codegraph_impact: Analyze impact radius for a symbol before refactors or risky edits.",
      promptGuidelines: [
        "Use codegraph_impact before refactoring public APIs, shared utilities, or heavily reused components.",
      ],
      parameters: Type.Object({
        symbol: Type.String({ description: "Symbol/function/method name" }),
        depth: Type.Optional(Type.Number({ description: "Traversal depth, default 2, max 5" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, params, signal) => {
        const result = await runCodeGraphJson(["impact", params.symbol, "--json", "--depth", String(limit(params.depth, 2, 5))], { cwd, signal });
        return { content: [{ type: "text" as const, text: pretty(result) }], details: result };
      },
    }),
  ];
}
