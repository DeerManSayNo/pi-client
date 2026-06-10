import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

// POST /api/tavily/test — test if Tavily API key is valid by running a simple search
export async function POST() {
  try {
    const tvlyPath = process.env.HOME
      ? `${process.env.HOME}/.local/bin/tvly`
      : undefined;

    const env = {
      ...process.env,
      PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ""}`,
      HOME: process.env.HOME,
    };

    const { stdout, stderr } = await execFileAsync(
      tvlyPath || "tvly",
      ["search", "hello world", "--json", "--max-results", "1"],
      {
        env,
        timeout: 15000,
      },
    );

    // Try to parse JSON output to verify success
    try {
      const result = JSON.parse(stdout) as { results?: unknown[]; error?: string };
      if (result.error) {
        return NextResponse.json({
          success: false,
          error: result.error,
          message: "API 密钥无效或请求失败",
        });
      }
      if (result.results && Array.isArray(result.results)) {
        return NextResponse.json({
          success: true,
          message: "API 密钥有效，搜索功能正常",
          resultCount: result.results.length,
        });
      }
    } catch {
      // JSON parse failed — check stderr
      const output = stdout + stderr;
      if (output.includes("401") || output.includes("Unauthorized") || output.includes("Invalid API key")) {
        return NextResponse.json({
          success: false,
          error: "unauthorized",
          message: "API 密钥无效或已过期",
        });
      }
      return NextResponse.json({
        success: false,
        error: "unknown",
        message: "无法验证 API 密钥：" + (stderr || output).slice(0, 200),
      });
    }

    return NextResponse.json({
      success: true,
      message: "API 密钥有效",
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string; code?: string };
    const output = (err.stderr ?? "") + (err.stdout ?? "");
    if (output.includes("401") || output.includes("Unauthorized") || output.includes("Invalid API key")) {
      return NextResponse.json({
        success: false,
        error: "unauthorized",
        message: "API 密钥无效或已过期",
      });
    }
    if (err.code === "ENOENT") {
      return NextResponse.json({
        success: false,
        error: "not_installed",
        message: "Tavily CLI (tvly) 未安装，请先安装：curl -fsSL https://cli.tavily.com/install.sh | bash",
      });
    }
    return NextResponse.json({
      success: false,
      error: err.message || String(e),
      message: "测试失败：" + (output || err.message || String(e)).slice(0, 300),
    });
  }
}
