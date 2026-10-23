import { useSyncExternalStore } from "react";

// Light / dark theme shared by the viewer and the studio. The choice is per device
// (localStorage); "system" follows prefers-color-scheme. The `dark` class on <html> drives both
// the color tokens (styles.css) and Tailwind's `dark:` variant. The inline script in each app's
// index.html sets it before the first paint (same key and rule), so there is no white flash.

export type ThemePreference = "system" | "light" | "dark";

const KEY = "ttk-theme";
const QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function isDark(preference: ThemePreference): boolean {
  return preference === "dark" || (preference === "system" && matchMedia(QUERY).matches);
}

function apply() {
  const dark = isDark(readPreference());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  for (const notify of listeners) notify();
}

if (typeof window !== "undefined") {
  matchMedia(QUERY).addEventListener("change", apply);
  window.addEventListener("storage", (event) => event.key === KEY && apply());
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    // Private mode: the choice lasts until the page is closed.
  }
  apply();
}

const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

/** Current preference and whether dark is in effect; re-renders on any change. */
export function useTheme(): { preference: ThemePreference; dark: boolean } {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  const dark = useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
  return { preference, dark };
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "Как в системе",
  light: "Светлая",
  dark: "Тёмная",
};
