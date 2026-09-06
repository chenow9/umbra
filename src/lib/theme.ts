// CSS owns palette values. This module only selects and persists appearance.
export const THEMES = [
  { id: "yueying", name: "浅色", scheme: "light" },
  { id: "moye", name: "深色", scheme: "dark" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_KEY = "umbra-theme-v3";
export const DEFAULT_THEME: ThemeId = "yueying";
export function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}
export function applyTheme(id: ThemeId) {
  const theme = THEMES.find((item) => item.id === id);
  if (!theme) return;
  const root = document.documentElement;
  // Retire inline values from the old JS palette writer during an in-place update.
  const legacy = new Set([
    "--paper",
    "--paper-2",
    "--card",
    "--ink",
    "--ink-soft",
    "--stone",
    "--line",
    "--pine",
    "--pine-fg",
    "--moss",
    "--live",
    "--amber",
    "--rose",
    "--shadow-border",
  ]);
  for (const name of Array.from(root.style)) {
    if (legacy.has(name) || name.startsWith("--color-")) root.style.removeProperty(name);
  }
  root.dataset.theme = id;
  root.style.colorScheme = theme.scheme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--paper").trim());
}
export function persistTheme(id: ThemeId) {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* storage may be unavailable */
  }
}
export function readStoredTheme(): ThemeId {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (isThemeId(value)) return value;
    // Old decorative themes converge on their corresponding light/dark scheme.
    if (value === "yesong") return "moye";
  } catch {
    /* storage may be unavailable */
  }
  return DEFAULT_THEME;
}
