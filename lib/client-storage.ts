/** Legacy localStorage keys from the pi-agent rename → current DeerHux keys. */
const LEGACY_LOCAL_STORAGE_KEYS: Record<string, string[]> = {
  "deerhux-theme": ["pi-theme"],
  "deerhux-sound-enabled": ["pi-sound-enabled"],
  "deerhux.sidebar-width": ["pi-agent.sidebar-width"],
  "deerhux.current-role": ["pi-agent.current-role"],
  "deerhux.sidebar-split-percent": ["pi-agent.sidebar-split-percent"],
  "deerhux.log-split-percent": ["pi-agent.log-split-percent"],
  "deerhux.auto-recovery-mode": ["pi-agent.auto-recovery-mode"],
  "deerhux.project-meta": ["pi-agent.project-meta"],
  "deerhux.custom-cwds": ["pi-agent.custom-cwds"],
};

/** Read a localStorage value, falling back to legacy pi-agent keys and persisting the migration. */
export function getLocalStorageItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    for (const legacyKey of LEGACY_LOCAL_STORAGE_KEYS[key] ?? []) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        localStorage.setItem(key, legacy);
        return legacy;
      }
    }
  } catch {
    // ignore quota / private mode errors
  }
  return null;
}
