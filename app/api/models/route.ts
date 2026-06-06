import { AuthStorage, ModelRegistry, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

interface ConfiguredModel {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

function getConfiguredModels(agentDir: string): Map<string, ConfiguredModel> {
  const modelsPath = join(agentDir, "models.json");
  if (!existsSync(modelsPath)) return new Map();

  try {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: Record<string, { models?: {
        id?: unknown;
        name?: unknown;
        reasoning?: unknown;
        thinkingLevelMap?: unknown;
      }[] }>;
    };
    const models = new Map<string, ConfiguredModel>();
    for (const [provider, config] of Object.entries(data.providers ?? {})) {
      for (const model of config.models ?? []) {
        if (typeof model.id === "string" && model.id.trim()) {
          const id = model.id.trim();
          const name = typeof model.name === "string" && model.name.trim() ? model.name : id;
          const thinkingLevelMap = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" && !Array.isArray(model.thinkingLevelMap)
            ? model.thinkingLevelMap as Record<string, string | null>
            : undefined;
          models.set(`${provider}:${id}`, {
            id,
            name,
            provider,
            reasoning: model.reasoning === true,
            thinkingLevelMap,
          });
        }
      }
    }
    return models;
  } catch {
    return new Map();
  }
}

export async function GET() {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  try {
    const agentDir = getAgentDir();
    const configuredModels = getConfiguredModels(agentDir);
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    const available = registry
      .getAvailable()
      .filter((m: { id: string; provider: string }) => configuredModels.has(`${m.provider}:${m.id}`));
    const mergedModels = new Map(configuredModels);
    for (const m of available) {
      const key = `${m.provider}:${m.id}`;
      mergedModels.set(key, { ...m, name: m.name || m.id });
      nameMap.set(key, m.name);
      thinkingLevels[key] = getSupportedThinkingLevels(m);
      if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
    }
    for (const [key, m] of mergedModels) {
      nameMap.set(key, m.name);
      if (m.thinkingLevelMap && !thinkingLevelMaps[key]) thinkingLevelMaps[key] = m.thinkingLevelMap;
    }
    modelList = [...mergedModels.values()].map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
    }));

    const settings = SettingsManager.create(process.cwd(), agentDir);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider && modelId && configuredModels.has(`${provider}:${modelId}`)) {
      defaultModel = { provider, modelId };
    }
  } catch { /* return empty */ }

  return Response.json({ models: Object.fromEntries(nameMap), modelList, defaultModel, thinkingLevels, thinkingLevelMaps });
}
