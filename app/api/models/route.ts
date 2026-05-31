import { AuthStorage, ModelRegistry, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

function getConfiguredModelKeys(agentDir: string): Set<string> {
  const modelsPath = join(agentDir, "models.json");
  if (!existsSync(modelsPath)) return new Set();

  try {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: Record<string, { models?: { id?: unknown }[] }>;
    };
    const keys = new Set<string>();
    for (const [provider, config] of Object.entries(data.providers ?? {})) {
      for (const model of config.models ?? []) {
        if (typeof model.id === "string" && model.id.trim()) {
          keys.add(`${provider}:${model.id}`);
        }
      }
    }
    return keys;
  } catch {
    return new Set();
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
    const configuredModelKeys = getConfiguredModelKeys(agentDir);
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    const available = registry
      .getAvailable()
      .filter((m: { id: string; provider: string }) => configuredModelKeys.has(`${m.provider}:${m.id}`));
    modelList = available.map((m: { id: string; name: string; provider: string }) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
    }));
    for (const m of available) {
      const key = `${m.provider}:${m.id}`;
      nameMap.set(key, m.name);
      thinkingLevels[key] = getSupportedThinkingLevels(m);
      if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
    }

    const settings = SettingsManager.create(process.cwd(), agentDir);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider && modelId && configuredModelKeys.has(`${provider}:${modelId}`)) {
      defaultModel = { provider, modelId };
    }
  } catch { /* return empty */ }

  return Response.json({ models: Object.fromEntries(nameMap), modelList, defaultModel, thinkingLevels, thinkingLevelMaps });
}
