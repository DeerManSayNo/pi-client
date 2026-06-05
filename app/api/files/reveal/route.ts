import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-access";
import fs from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const { filePath } = (await request.json()) as { filePath: string };

    if (!filePath || typeof filePath !== "string") {
      return NextResponse.json({ error: "Missing filePath" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Determine if it's a file or directory
    let isDir = false;
    try {
      const stat = fs.statSync(filePath);
      isDir = stat.isDirectory();
    } catch {
      return NextResponse.json({ error: "Path not found" }, { status: 404 });
    }

    const platform = process.platform;
    let command: string;

    if (platform === "darwin") {
      // macOS: open directory to view contents, reveal file in Finder
      command = isDir ? `open "${path.resolve(filePath)}"` : `open -R "${path.resolve(filePath)}"`;
    } else if (platform === "win32") {
      // Windows: open directory, or select file in Explorer
      command = isDir ? `explorer "${filePath}"` : `explorer /select,"${filePath}"`;
    } else {
      // Linux: open directory or containing directory
      const dir = isDir ? filePath : path.dirname(filePath);
      command = `xdg-open "${dir}"`;
    }

    exec(command, (error) => {
      if (error) {
        console.error("Failed to reveal file:", error);
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
