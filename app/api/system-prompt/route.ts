import { NextResponse } from "next/server";
import {
  applySectionOverrides,
  createVersion,
  getDefaultSystemPromptSections,
  readGlobalSystemPromptConfig,
  readVersions,
  writeGlobalSystemPromptConfig,
} from "@/lib/system-prompt-decomposer";

export async function GET() {
  const config = readGlobalSystemPromptConfig();
  const sections = applySectionOverrides(getDefaultSystemPromptSections(), config.sections);
  return NextResponse.json({
    sections,
    config,
    versions: readVersions(),
  });
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      sections?: { id: string; enabled: boolean; content: string }[];
      activeVersionId?: string | null;
    };

    const config = writeGlobalSystemPromptConfig({
      sections: body.sections ?? [],
      activeVersionId: body.activeVersionId ?? null,
    });

    return NextResponse.json({ config });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
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
      name: body.name,
      description: body.description,
      sections: body.sections ?? [],
    });

    let config = readGlobalSystemPromptConfig();
    if (body.makeActive) {
      config = writeGlobalSystemPromptConfig({ sections: version.sections, activeVersionId: version.id });
    }

    return NextResponse.json({ version, config });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
