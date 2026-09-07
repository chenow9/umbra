export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export type LocalePreference = "auto" | Locale;

export const LOCALE_KEY = "umbra-locale";
export const DEFAULT_LOCALE: Locale = "zh";

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "zh" || value === "en";
}

export function isLocalePreference(value: string | null | undefined): value is LocalePreference {
  return value === "auto" || isLocale(value);
}

export function detectBrowserLocale(
  languages: readonly string[] | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator.languages?.length ? navigator.languages : [navigator.language]),
): Locale {
  for (const raw of languages ?? []) {
    const tag = raw.trim().toLowerCase();
    if (tag === "zh" || tag.startsWith("zh-")) return "zh";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}

export function readStoredPreference(): LocalePreference {
  try {
    const value = localStorage.getItem(LOCALE_KEY);
    if (isLocalePreference(value)) return value;
  } catch {
    /* storage may be unavailable */
  }
  return "auto";
}

export function persistLocalePreference(value: LocalePreference) {
  try {
    if (value === "auto") localStorage.removeItem(LOCALE_KEY);
    else localStorage.setItem(LOCALE_KEY, value);
  } catch {
    /* storage may be unavailable */
  }
}

export function resolveLocale(preference: LocalePreference, languages?: readonly string[]): Locale {
  if (preference === "zh" || preference === "en") return preference;
  return detectBrowserLocale(languages);
}

export function htmlLang(locale: Locale) {
  return locale === "zh" ? "zh-CN" : "en";
}

export function dateLocale(locale: Locale) {
  return locale === "zh" ? "zh-CN" : "en-GB";
}

export function collateLocale(locale: Locale) {
  return locale === "zh" ? "zh" : "en";
}

export function applyLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = htmlLang(locale);
  document.documentElement.dataset.locale = locale;
}

export const LOCALE_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(LOCALE_KEY)});var l=(s==="zh"||s==="en")?s:(function(){var langs=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""];for(var i=0;i<langs.length;i++){var x=String(langs[i]||"").trim().toLowerCase();if(x==="zh"||x.indexOf("zh-")===0)return"zh";if(x==="en"||x.indexOf("en-")===0)return"en";}return"en";})();document.documentElement.lang=l==="zh"?"zh-CN":"en";document.documentElement.dataset.locale=l;}catch(e){}})();`;
