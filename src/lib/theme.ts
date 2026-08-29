export type ThemeTokens = {
  paper: string;
  paper2: string;
  card: string;
  ink: string;
  inkSoft: string;
  stone: string;
  line: string;
  pine: string;
  pineFg: string;
  moss: string;
  live: string;
  amber: string;
  rose: string;
  shadow: string;
};

export const THEMES = [
  {
    id: "yueying",
    name: "月影",
    hint: "银纸 + 门影，幽门默认",
    scheme: "light",
    tokens: {
      paper: "#eef0f4",
      paper2: "#e4e7ee",
      card: "#f7f8fb",
      ink: "#16181f",
      inkSoft: "#3a3f4c",
      stone: "#6b7180",
      line: "#d0d3dc",
      pine: "#2e3148",
      pineFg: "#eef0f4",
      moss: "#434765",
      live: "#1e7a45",
      amber: "#8d7344",
      rose: "#9b4545",
      shadow:
        "0px 0px 0px 1px rgba(22, 24, 31, 0.07), 0px 1px 2px -1px rgba(22, 24, 31, 0.06), 0px 2px 4px 0px rgba(22, 24, 31, 0.04)",
    },
  },
  {
    id: "songmo",
    name: "松墨",
    hint: "暖纸 + 松绿",
    scheme: "light",
    tokens: {
      paper: "#f3efe6",
      paper2: "#ebe6da",
      card: "#f7f4ec",
      ink: "#1a1814",
      inkSoft: "#3f3a33",
      stone: "#8a8478",
      line: "#d9d2c4",
      pine: "#2c4a3e",
      pineFg: "#f3efe6",
      moss: "#4d6b5c",
      live: "#1b7a42",
      amber: "#9a6b2f",
      rose: "#8c3d3d",
      shadow:
        "0px 0px 0px 1px rgba(26, 24, 20, 0.06), 0px 1px 2px -1px rgba(26, 24, 20, 0.06), 0px 2px 4px 0px rgba(26, 24, 20, 0.04)",
    },
  },
  {
    id: "qingci",
    name: "青瓷",
    hint: "冷白绿，更干净",
    scheme: "light",
    tokens: {
      paper: "#eef3ee",
      paper2: "#e3ebe4",
      card: "#f5f8f5",
      ink: "#1c2420",
      inkSoft: "#3c4a43",
      stone: "#7d8a82",
      line: "#cdd6cf",
      pine: "#3f6b5c",
      pineFg: "#eef3ee",
      moss: "#5a8874",
      live: "#1b7a48",
      amber: "#9a7a48",
      rose: "#8c4a4a",
      shadow:
        "0px 0px 0px 1px rgba(28, 36, 32, 0.06), 0px 1px 2px -1px rgba(28, 36, 32, 0.06), 0px 2px 4px 0px rgba(28, 36, 32, 0.04)",
    },
  },
  {
    id: "haijiao",
    name: "海礁",
    hint: "雾灰蓝，偏冷静",
    scheme: "light",
    tokens: {
      paper: "#eef1f3",
      paper2: "#e4e8eb",
      card: "#f5f7f8",
      ink: "#1b2328",
      inkSoft: "#3d4a52",
      stone: "#7a858c",
      line: "#cfd6db",
      pine: "#3d5a66",
      pineFg: "#eef1f3",
      moss: "#5a7884",
      live: "#1b7a5c",
      amber: "#9a7a48",
      rose: "#8c4a4a",
      shadow:
        "0px 0px 0px 1px rgba(27, 35, 40, 0.06), 0px 1px 2px -1px rgba(27, 35, 40, 0.06), 0px 2px 4px 0px rgba(27, 35, 40, 0.04)",
    },
  },
  {
    id: "guci",
    name: "骨瓷",
    hint: "骨白 + 炭黑",
    scheme: "light",
    tokens: {
      paper: "#f6f3ee",
      paper2: "#eee9e1",
      card: "#faf8f4",
      ink: "#1e1c19",
      inkSoft: "#45413c",
      stone: "#8a857c",
      line: "#ddd6cc",
      pine: "#2a2724",
      pineFg: "#f6f3ee",
      moss: "#4a4641",
      live: "#1e7a45",
      amber: "#9a7a48",
      rose: "#8c3d3d",
      shadow:
        "0px 0px 0px 1px rgba(30, 28, 25, 0.07), 0px 1px 2px -1px rgba(30, 28, 25, 0.06), 0px 2px 4px 0px rgba(30, 28, 25, 0.04)",
    },
  },
  {
    id: "zhusha",
    name: "朱砂",
    hint: "暖纸 + 沉朱，偏金石",
    scheme: "light",
    tokens: {
      paper: "#f4eee8",
      paper2: "#ece4dc",
      card: "#f8f3ee",
      ink: "#1c1614",
      inkSoft: "#4a3c38",
      stone: "#8a7c76",
      line: "#ddd2ca",
      pine: "#7a3a32",
      pineFg: "#f4eee8",
      moss: "#8f5048",
      live: "#2a7a3d",
      amber: "#9a6b2f",
      rose: "#8c3d3d",
      shadow:
        "0px 0px 0px 1px rgba(28, 22, 20, 0.06), 0px 1px 2px -1px rgba(28, 22, 20, 0.06), 0px 2px 4px 0px rgba(28, 22, 20, 0.04)",
    },
  },
  {
    id: "dianlan",
    name: "靛蓝",
    hint: "冷灰纸 + 藏青",
    scheme: "light",
    tokens: {
      paper: "#eef0f4",
      paper2: "#e4e6ec",
      card: "#f5f6f9",
      ink: "#161820",
      inkSoft: "#3a3e4a",
      stone: "#7a7e8a",
      line: "#cfd2da",
      pine: "#3d4a63",
      pineFg: "#eef0f4",
      moss: "#536078",
      live: "#1b7a48",
      amber: "#9a7a48",
      rose: "#8c4a4a",
      shadow:
        "0px 0px 0px 1px rgba(22, 24, 32, 0.06), 0px 1px 2px -1px rgba(22, 24, 32, 0.06), 0px 2px 4px 0px rgba(22, 24, 32, 0.04)",
    },
  },
  {
    id: "chahe",
    name: "茶褐",
    hint: "茶汤纸 + 褐木",
    scheme: "light",
    tokens: {
      paper: "#f3eadc",
      paper2: "#e8decc",
      card: "#f7f1e6",
      ink: "#1c1610",
      inkSoft: "#4a3e32",
      stone: "#8a7c68",
      line: "#d9cdb8",
      pine: "#5a4030",
      pineFg: "#f3eadc",
      moss: "#6e5240",
      live: "#3a7a28",
      amber: "#9a6b2f",
      rose: "#8c3d3d",
      shadow:
        "0px 0px 0px 1px rgba(28, 22, 16, 0.07), 0px 1px 2px -1px rgba(28, 22, 16, 0.06), 0px 2px 4px 0px rgba(28, 22, 16, 0.04)",
    },
  },
  {
    id: "moye",
    name: "墨夜",
    hint: "冷深底，适合盯流量",
    scheme: "dark",
    tokens: {
      paper: "#121314",
      paper2: "#181a1b",
      card: "#1c1e20",
      ink: "#eceae4",
      inkSoft: "#c4c0b6",
      stone: "#8b8a84",
      line: "#2c2e30",
      pine: "#c8ccd4",
      pineFg: "#121314",
      moss: "#a8adb6",
      live: "#8fba9a",
      amber: "#c4a574",
      rose: "#d08080",
      shadow: "0 0 0 1px rgba(255, 255, 255, 0.08)",
    },
  },
  {
    id: "yesong",
    name: "夜松",
    hint: "暖深底 + 松青",
    scheme: "dark",
    tokens: {
      paper: "#141210",
      paper2: "#1c1916",
      card: "#221e1a",
      ink: "#ece6dc",
      inkSoft: "#c4baac",
      stone: "#8a8278",
      line: "#2e2a26",
      pine: "#9bb5a4",
      pineFg: "#141210",
      moss: "#b3c8ba",
      live: "#9bb5a4",
      amber: "#c4a574",
      rose: "#d08080",
      shadow: "0 0 0 1px rgba(255, 255, 255, 0.08)",
    },
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const THEME_KEY = "umbra-theme-v3";
export const DEFAULT_THEME: ThemeId = "yueying";

const GROUPS = [
  { id: "light", label: "浅色", scheme: "light" },
  { id: "dark", label: "深色", scheme: "dark" },
] as const;

export function themeGroups() {
  return GROUPS.map((g) => ({
    ...g,
    items: THEMES.filter((t) => t.scheme === g.scheme),
  }));
}

export function isThemeId(v: string | null): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

function writeVars(tokens: ThemeTokens) {
  const root = document.documentElement;
  const pairs: Array<[string, string]> = [
    ["--paper", tokens.paper],
    ["--paper-2", tokens.paper2],
    ["--card", tokens.card],
    ["--ink", tokens.ink],
    ["--ink-soft", tokens.inkSoft],
    ["--stone", tokens.stone],
    ["--line", tokens.line],
    ["--pine", tokens.pine],
    ["--pine-fg", tokens.pineFg],
    ["--moss", tokens.moss],
    ["--live", tokens.live],
    ["--amber", tokens.amber],
    ["--rose", tokens.rose],
    ["--shadow-border", tokens.shadow],
    ["--color-paper", tokens.paper],
    ["--color-paper-2", tokens.paper2],
    ["--color-ink", tokens.ink],
    ["--color-ink-soft", tokens.inkSoft],
    ["--color-stone", tokens.stone],
    ["--color-line", tokens.line],
    ["--color-pine", tokens.pine],
    ["--color-pine-fg", tokens.pineFg],
    ["--color-moss", tokens.moss],
    ["--color-live", tokens.live],
    ["--color-amber", tokens.amber],
    ["--color-rose", tokens.rose],
    ["--color-background", tokens.paper],
    ["--color-foreground", tokens.ink],
    ["--color-card", tokens.card],
    ["--color-card-foreground", tokens.ink],
    ["--color-muted", tokens.stone],
    ["--color-muted-foreground", tokens.stone],
    ["--color-border", tokens.line],
    ["--color-input", tokens.line],
    ["--color-primary", tokens.pine],
    ["--color-primary-foreground", tokens.pineFg],
    ["--color-secondary", tokens.paper2],
    ["--color-secondary-foreground", tokens.ink],
    ["--color-accent", tokens.pine],
    ["--color-accent-foreground", tokens.pineFg],
    ["--color-destructive", tokens.rose],
    ["--color-destructive-foreground", tokens.pineFg],
    ["--color-ring", tokens.pine],
  ];
  for (const [key, value] of pairs) root.style.setProperty(key, value);
}

export function applyTheme(id: ThemeId) {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) return;
  const root = document.documentElement;
  root.dataset.theme = id;
  root.style.colorScheme = theme.scheme;
  writeVars(theme.tokens);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme.tokens.paper);
}

export function persistTheme(id: ThemeId) {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* iframe may block storage */
  }
}

export function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}
