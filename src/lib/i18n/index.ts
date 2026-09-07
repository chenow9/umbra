import { createContext, useContext } from "react";
import {
  applyLocale,
  DEFAULT_LOCALE,
  readStoredPreference,
  resolveLocale,
  type Locale,
  type LocalePreference,
} from "./locale.ts";
import { en, zh, type MessageNode, type Plural } from "./messages.ts";

export type { Locale, LocalePreference } from "./locale.ts";
export {
  applyLocale,
  collateLocale,
  dateLocale,
  detectBrowserLocale,
  htmlLang,
  LOCALE_BOOT_SCRIPT,
  LOCALE_KEY,
  persistLocalePreference,
  readStoredPreference,
  resolveLocale,
} from "./locale.ts";

const catalogs: Record<Locale, MessageNode> = { zh, en };

let currentLocale: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return currentLocale;
}

export function setActiveLocale(locale: Locale) {
  currentLocale = locale;
  applyLocale(locale);
}

export type TranslateVars = Record<string, string | number>;

function isPlural(value: unknown): value is Plural {
  return Boolean(value && typeof value === "object" && "one" in value && "other" in value);
}

function lookup(root: MessageNode, path: string): unknown {
  let cur: unknown = root;
  const parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== "object") return undefined;
    const rec = cur as Record<string, unknown>;
    const rest = parts.slice(i).join(".");
    if (rest in rec) return rec[rest];
    const part = parts[i];
    if (!(part in rec)) return undefined;
    cur = rec[part];
  }
  return cur;
}

function interpolate(template: string, vars?: TranslateVars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] == null ? `{${key}}` : String(vars[key]),
  );
}

export function t(path: string, vars?: TranslateVars, locale: Locale = currentLocale): string {
  const raw = lookup(catalogs[locale], path) ?? lookup(catalogs.zh, path);
  if (typeof raw === "string") return interpolate(raw, vars);
  if (isPlural(raw)) {
    const n = Number(vars?.count ?? vars?.n ?? 0);
    return interpolate(n === 1 ? raw.one : raw.other, vars);
  }
  return path;
}

export function statusText(status: string, locale?: Locale) {
  if (status === "online" || status === "offline" || status === "revoked") {
    return t(`status.${status}`, undefined, locale);
  }
  return status;
}

export type I18nValue = {
  locale: Locale;
  preference: LocalePreference;
  setPreference: (value: LocalePreference) => void;
  t: (path: string, vars?: TranslateVars) => string;
};

export const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  preference: "auto",
  setPreference: () => undefined,
  t,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function readInitialLocale(): { preference: LocalePreference; locale: Locale } {
  if (typeof document !== "undefined") {
    const marked = document.documentElement.dataset.locale;
    if (marked === "zh" || marked === "en") {
      const preference = typeof localStorage === "undefined" ? "auto" : readStoredPreference();
      return { preference, locale: marked };
    }
  }
  const preference = typeof localStorage === "undefined" ? "auto" : readStoredPreference();
  return { preference, locale: resolveLocale(preference) };
}
