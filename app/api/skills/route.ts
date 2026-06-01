import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { DefaultResourceLoader, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import path from "path";

export const dynamic = "force-dynamic";

function getGlobalSkillDirs(): string[] {
  const home = homedir();
  return [
    path.join(home, ".pi", "agent", "skills"),
    path.join(home, ".agents", "skills"),
  ];
}

function isGlobalSkill(filePath: string): boolean {
  const globalDirs = getGlobalSkillDirs();
  for (const dir of globalDirs) {
    if (filePath.startsWith(dir + path.sep) || filePath.startsWith(dir + "/")) {
      return true;
    }
  }
  return false;
}

function isProjectSkill(filePath: string, cwd: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedCwd = path.resolve(cwd);
  return resolved.startsWith(resolvedCwd + path.sep) || resolved.startsWith(resolvedCwd + "/");
}

interface SkillWithSource {
  name: string;
  description: string;
  filePath: string;
  source: "global" | "project";
}

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();

    // Categorize skills as global or project
    const skillsWithSource: SkillWithSource[] = skills.map((skill) => {
      let source: "global" | "project" = "project";
      if (isGlobalSkill(skill.filePath)) {
        source = "global";
      } else if (isProjectSkill(skill.filePath, cwd)) {
        source = "project";
      }
      // Skills from packages or settings paths default to "project"
      return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        source,
      };
    });

    return NextResponse.json({ skills: skillsWithSource, diagnostics });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });

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
