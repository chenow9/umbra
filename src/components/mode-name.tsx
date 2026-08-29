import { modeHint } from "@/lib/umbra/labels";
import type { MappingMode } from "@/lib/umbra/types";
import { cn } from "@/lib/utils";

export function NameDotHint({
  name,
  hint,
  className,
}: {
  name: string;
  hint: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span className="font-mono">{name}</span>
      <span className="size-1 shrink-0 rounded-full bg-stone" aria-hidden="true" />
      <span className="min-w-0 truncate text-stone">{hint}</span>
    </span>
  );
}

export function ModeName({ mode, className }: { mode: MappingMode; className?: string }) {
  return <NameDotHint name={mode} hint={modeHint[mode]} className={className} />;
}
