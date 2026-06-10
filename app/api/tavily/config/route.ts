import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";

export const dynamic = "force-dynamic";

const TAVILY_CONFIG_DIR = path.join(homedir(), ".tavily");
const TAVILY_CONFIG_PATH = path.join(TAVILY_CONFIG_DIR, "config.json");

interface TavilyConfig {
  api_key?: string;
}

function readConfig(): TavilyConfig {
  if (!existsSync(TAVILY_CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(TAVILY_CONFIG_PATH, "utf8");
    return JSON.parse(raw) as TavilyConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: TavilyConfig): void {
  if (!existsSync(TAVILY_CONFIG_DIR)) {
    mkdirSync(TAVILY_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(TAVILY_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

// GET /api/tavily/config — get current Tavily API key (masked)
export async function GET() {
  try {
    const config = readConfig();
    const key = config.api_key ?? "";
    return NextResponse.json({
      configured: !!key,
      apiKey: key ? maskApiKey(key) : "",
      hasKey: !!key,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST /api/tavily/config — save Tavily API key
export async function POST(req: Request) {
  try {
    const body = await req.json() as { apiKey?: string };
    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    writeConfig({ api_key: apiKey });
    return NextResponse.json({
      success: true,
      configured: true,
      apiKey: maskApiKey(apiKey),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
