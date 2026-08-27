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
} as const;

export function StatusDot({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const tone = tones[status as keyof typeof tones] ?? "bg-stone";
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
      <span className={cn("size-1.5 shrink-0 rounded-full", tone)} />
      {label}
    </span>
  );
}
