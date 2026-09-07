"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { UmbraLive } from "@/components/umbra-live";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  type ThemeId,
} from "@/lib/theme";
import {
  I18nContext,
  persistLocalePreference,
  readInitialLocale,
  resolveLocale,
  setActiveLocale,
  t as translate,
  type Locale,
  type LocalePreference,
  type TranslateVars,
} from "@/lib/i18n";

const ThemeCtx = createContext<{
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}>({ theme: DEFAULT_THEME, setTheme: () => undefined });

export function useTheme() {
  return useContext(ThemeCtx);
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 20_000, refetchOnWindowFocus: false, retry: 0 },
          mutations: { retry: 0 },
        },
      }),
  );
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const boot = readInitialLocale();
  const [preference, setPreferenceState] = useState<LocalePreference>(boot.preference);
  const [locale, setLocaleState] = useState<Locale>(boot.locale);

  useLayoutEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    applyTheme(stored);
    const next = readInitialLocale();
    setPreferenceState(next.preference);
    setLocaleState(next.locale);
    setActiveLocale(next.locale);
  }, []);

  const setPreference = useCallback((value: LocalePreference) => {
    persistLocalePreference(value);
    const resolved = resolveLocale(value);
    setActiveLocale(resolved);
    setPreferenceState(value);
    setLocaleState(resolved);
  }, []);

  const t = useCallback((path: string, vars?: TranslateVars) => translate(path, vars, locale), [locale]);
  const i18n = useMemo(
    () => ({ locale, preference, setPreference, t }),
    [locale, preference, setPreference, t],
  );

  return (
    <QueryClientProvider client={client}>
      <I18nContext.Provider value={i18n}>
        <ThemeCtx.Provider value={{ theme, setTheme }}>
          <UmbraLive>
            {children}
            <Toaster
              position="bottom-right"
              toastOptions={{
                className: "font-sans !bg-card !text-ink !border-line shadow-border",
              }}
            />
          </UmbraLive>
        </ThemeCtx.Provider>
      </I18nContext.Provider>
    </QueryClientProvider>
  );
}
