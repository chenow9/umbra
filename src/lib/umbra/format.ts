export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatBps(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B/s";
  if (n < 1024) return `${n < 10 ? n.toFixed(1) : Math.round(n)} B/s`;
  return `${formatBytes(n)}/s`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "从未";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "从未";
  const diff = Date.now() - t;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60_000) return "即将";
    if (ahead < 3_600_000) return `${Math.floor(ahead / 60_000)} 分钟后`;
    if (ahead < 86_400_000) return `${Math.floor(ahead / 3_600_000)} 小时后`;
    return `${Math.floor(ahead / 86_400_000)} 天后`;
  }
  if (diff < 15_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatPort(port: number | null | undefined, mode: string): string {
  if (mode === "visitor" || port == null) return "—";
  return String(port);
}

/** Stored mapping limit is KiB/s (rateKbps × 1024 bytes). */
export const RATE_UNITS = [
  { id: "KBps", label: "KB/s" },
  { id: "MBps", label: "MB/s" },
  { id: "Mbps", label: "Mbps" },
] as const;

export type RateUnit = (typeof RATE_UNITS)[number]["id"];

export function pickRateUnit(kbps: number): RateUnit {
  if (kbps >= 1024) return "MBps";
  return "KBps";
}

export function kbpsToUnit(kbps: number, unit: RateUnit): number {
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  if (unit === "KBps") return kbps;
  if (unit === "MBps") return kbps / 1024;
  return (kbps * 1024 * 8) / 1_000_000;
}

export function unitToKbps(value: number, unit: RateUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  let kbps = value;
  if (unit === "MBps") kbps = value * 1024;
  else if (unit === "Mbps") kbps = (value * 1_000_000) / 8 / 1024;
  return Math.min(1_000_000, Math.max(0, Math.round(kbps)));
}

export function formatRateDisplay(kbps: number, unit: RateUnit): string {
  const v = kbpsToUnit(kbps, unit);
  if (v <= 0) return "0";
  if (Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  if (v >= 10) return trimRate(v.toFixed(1));
  if (v >= 1) return trimRate(v.toFixed(2));
  return trimRate(v.toFixed(3));
}

function trimRate(s: string) {
  return s.replace(/\.?0+$/, "");
}

export function formatRateHint(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) return "0 不限制";
  const mb = formatRateDisplay(kbps, "MBps");
  const mbps = formatRateDisplay(kbps, "Mbps");
  return `${kbps} KB/s · ${mb} MB/s · ${mbps} Mbps`;
}
