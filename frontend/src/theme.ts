import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "d2hub.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const isPreference = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

/** Defaults to following the operating system until someone chooses otherwise. */
export function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function writePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_KEY, preference);
  } catch {
    /* private browsing: the choice lasts only as long as the tab */
  }
}

export function systemTheme(): ResolvedTheme {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/**
 * Stamps the resolved theme on <html>, which is what every `[data-theme="dark"]`
 * rule keys off. Also moves the browser-chrome colour, so the mobile address bar
 * does not stay light over a dark page.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#0e1a1e" : "#173b45");
  return resolved;
}

export const THEME_LABEL: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System"
};

export const THEME_ICON: Record<ThemePreference, string> = {
  light: "☀",
  dark: "☾",
  system: "◐"
};

/** The next preference in the cycle, which is what the header button steps through. */
export function nextPreference(preference: ThemePreference): ThemePreference {
  return preference === "system" ? "light" : preference === "light" ? "dark" : "system";
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  const [preference, setStored] = useState<ThemePreference>(readPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

  const setPreference = useCallback((next: ThemePreference) => {
    writePreference(next);
    setStored(next);
    setResolved(applyTheme(next));
  }, []);

  // only while following the system: a change to the OS setting re-resolves
  useEffect(() => {
    if (preference !== "system") return;
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const sync = () => setResolved(applyTheme("system"));
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [preference]);

  return { preference, resolved, setPreference };
}
