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
