import { NextResponse } from "next/server";
import {
  applySectionOverrides,
  createVersion,
  getDefaultSystemPromptSections,
  readRoleSystemPromptConfig,
  readVersions,
  writeRoleSystemPromptConfig,
} from "@/lib/system-prompt-decomposer";

function roleIdFromUrl(req: Request): string {
  return new URL(req.url).searchParams.get("roleId") || "default";
}

export async function GET(req: Request) {
  const roleId = roleIdFromUrl(req);
  const config = readRoleSystemPromptConfig(roleId);
  const sections = applySectionOverrides(getDefaultSystemPromptSections(), config.sections);
  return NextResponse.json({
    roleId,
    sections,
    config,
    versions: readVersions(roleId),
  });
}

export async function PATCH(req: Request) {
  const roleId = roleIdFromUrl(req);
  try {
    const body = await req.json() as {
      sections?: { id: string; enabled: boolean; content: string }[];
      activeVersionId?: string | null;
    };

    const config = writeRoleSystemPromptConfig(roleId, {
      sections: body.sections ?? [],
      activeVersionId: body.activeVersionId ?? null,
    });

    return NextResponse.json({ roleId, config });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const roleId = roleIdFromUrl(req);
  try {
    const body = await req.json() as {
      name?: string;
      description?: string;
      sections?: { id: string; enabled: boolean; content: string }[];
      makeActive?: boolean;
    };

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const version = createVersion({
      roleId,
      name: body.name,
      description: body.description,
      sections: body.sections ?? [],
    });

    let config = readRoleSystemPromptConfig(roleId);
    if (body.makeActive) {
      config = writeRoleSystemPromptConfig(roleId, { sections: version.sections, activeVersionId: version.id });
    }

    return NextResponse.json({ roleId, version, config });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
