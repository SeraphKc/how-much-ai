// Device-local settings only. Accounts now live in the server-side vault (see lib/vault-client),
// so they sync across devices; UI preferences like auto-refresh stay per-device here.

const SETTINGS_KEY = "usage.settings.v1";

export interface Settings {
  autoRefresh: boolean;
}

const DEFAULT_SETTINGS: Settings = { autoRefresh: true };

export function loadSettings(): Settings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_SETTINGS };

    const autoRefresh = (parsed as { autoRefresh?: unknown }).autoRefresh;
    return { autoRefresh: typeof autoRefresh === "boolean" ? autoRefresh : DEFAULT_SETTINGS.autoRefresh };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): boolean {
  if (typeof window === "undefined") return true;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
