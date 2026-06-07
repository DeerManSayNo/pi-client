import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync, rmdirSync, unlinkSync } from "fs";
import { DefaultResourceLoader, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import path from "path";
import { readdirSync } from "fs";
import { migrateProjectAgentsDir } from "@/lib/legacy-migration";
import { isManagedDeerHuxSkillFile } from "@/lib/extensions/config";

export const dynamic = "force-dynamic";

interface SkillWithMeta {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  canDelete: boolean;
}

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .deerhux/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    migrateProjectAgentsDir(cwd);
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();

    // Pass through full skill data including sourceInfo so the frontend can
    // properly categorize and display skill metadata.
    const skillsWithMeta: SkillWithMeta[] = skills.map((skill) => {
      return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation,
        sourceInfo: {
          source: skill.sourceInfo?.source,
          scope: skill.sourceInfo?.scope,
        },
        canDelete: isManagedDeerHuxSkillFile(skill.filePath, cwd),
      };
    });

    return NextResponse.json({ skills: skillsWithMeta, diagnostics });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE /api/skills — delete a skill file
export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get("cwd");
    const filePath = searchParams.get("filePath");
    if (!filePath) {
      return NextResponse.json({ error: "filePath required" }, { status: 400 });
    }
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: "file not found" }, { status: 404 });
    }

    // Safety: only allow deleting SKILL.md files managed by DeerHux.
    if (!isManagedDeerHuxSkillFile(filePath, cwd)) {
      return NextResponse.json({ error: "only DeerHux-managed SKILL.md files can be deleted" }, { status: 400 });
    }

    // Delete the SKILL.md file
    unlinkSync(filePath);

    // Try to remove the parent directory if it's empty
    const parentDir = path.dirname(filePath);
    try {
      const entries = readdirSync(parentDir);
      if (entries.length === 0) {
        rmdirSync(parentDir);
      }
    } catch {
      // Directory not empty or can't be removed — that's fine
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean; cwd?: string | null };
    const { filePath, disableModelInvocation, cwd } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });

    if (!isManagedDeerHuxSkillFile(filePath, cwd)) {
      return NextResponse.json({ error: "only DeerHux-managed SKILL.md files can be modified" }, { status: 400 });
    }

    const content = readFileSync(filePath, "utf8");
    const key = "disable-model-invocation";

    // Use parseFrontmatter to check current value, then do a surgical line edit
    // to preserve the original YAML formatting of all other fields.
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const alreadySet = Boolean(frontmatter[key]);

    let updated = content;
    if (disableModelInvocation && !alreadySet) {
      // Add key after the opening --- line
      updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
      // If no frontmatter exists, create one
      if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
    } else if (!disableModelInvocation && alreadySet) {
      // Remove the key line entirely
      updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
    }

    writeFileSync(filePath, updated, "utf8");
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
