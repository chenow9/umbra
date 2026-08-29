"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
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

  useLayoutEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    applyTheme(stored);
  }, []);

  return (
    <QueryClientProvider client={client}>
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
    </QueryClientProvider>
  );
}
