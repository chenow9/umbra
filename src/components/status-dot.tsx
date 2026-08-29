import { cn } from "@/lib/utils";

const tones = {
  online: "bg-live",
  listening: "bg-live",
  ready: "bg-live",
  acked: "bg-live",
  offline: "bg-stone",
  pending: "bg-amber",
  pending_offline: "bg-amber",
  disabled: "bg-stone",
  revoked: "bg-rose",
  error: "bg-rose",
  open: "bg-live",
  visitor: "bg-live",
  full: "bg-rose",
  closed: "bg-stone",
} as const;

const labels = {
  online: "text-live",
  listening: "text-live",
  ready: "text-live",
  acked: "text-live",
  offline: "text-stone",
  pending: "text-amber",
  pending_offline: "text-amber",
  disabled: "text-stone",
  revoked: "text-rose",
  error: "text-rose",
  open: "text-live",
  visitor: "text-live",
  full: "text-rose",
  closed: "text-stone",
} as const;

export function StatusDot({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const tone = tones[status as keyof typeof tones] ?? "bg-stone";
  const text = labels[status as keyof typeof labels] ?? "text-stone";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", text)}>
      <span className={cn("size-2.5 shrink-0 rounded-full", tone)} />
      {label}
    </span>
  );
}
