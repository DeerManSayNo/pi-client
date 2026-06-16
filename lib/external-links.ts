"use client";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function normalizeExternalHref(href: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    const url = new URL(href, window.location.href);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export async function openExternalLink(href: string): Promise<boolean> {
  const target = normalizeExternalHref(href);
  if (!target || typeof window === "undefined") return false;

  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:shell|open", { path: target });
      return true;
    } catch (error) {
      console.warn("Failed to open external link via Tauri shell:", error);
    }
  }

  const opened = window.open(target, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
  return true;
}
