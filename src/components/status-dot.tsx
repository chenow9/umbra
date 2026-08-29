import { cn } from "@/lib/utils";

const tones = {
  online: "bg-pine",
  listening: "bg-pine",
  ready: "bg-pine",
  acked: "bg-pine",
  offline: "bg-stone",
  pending: "bg-amber",
  pending_offline: "bg-amber",
  disabled: "bg-stone",
  revoked: "bg-rose",
  error: "bg-rose",
  open: "bg-pine",
  visitor: "bg-pine",
  full: "bg-rose",
  closed: "bg-stone",
} as const;

export function StatusDot({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const tone = tones[status as keyof typeof tones] ?? "bg-stone";
  const live = status === "online" || status === "listening" || status === "ready" || status === "open" || status === "visitor";
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
      <span className={cn("size-1.5 shrink-0 rounded-full", tone, live && "live-dot")} />
      {label}
    </span>
  );
}
